// Hedged-pair strategy.
//
//  1. Open a long and a short of equal margin on the chosen asset at the same time.
//  2. When one leg's payout reaches -LOSER_STOP_PCT of its margin, close it (the "loser").
//  3. Ride the other leg (the "winner"):
//       - never let it slide toward a loss: close if its own payout falls to WINNER_FLOOR_PCT
//       - once the pair has covered the loser's loss, close if pair net falls back to ~breakeven
//       - at TAKE_PROFIT_PCT of pair margin: close, unless price is still running in our favour,
//         in which case trail it and close when momentum stalls or too much profit is given back.
//
// Invariant: a pair is only `done` once every leg that filled has a settlement result. Closing is a
// state that is retried from the timer loop, never a one-shot call, so a rejected close can't strand a leg.

import { ASSETS, INSTRUMENTS, type Asset } from './constants.ts';
import type { Config } from './config.ts';
import type { CloseResult, Executor, Position } from './executor/types.ts';
import { legValue } from './math.ts';
import type { PriceFeed, Tick } from './prices.ts';
import { pickAsset } from './selector.ts';
import { log, type Journal } from './log.ts';

type PairState = 'opening' | 'both' | 'stopping' | 'riding' | 'closing' | 'done';

interface Pair {
  id: number;
  asset: Asset;
  state: PairState;
  startedAt: number;
  long?: Position;
  short?: Position;
  loser?: Position;
  winner?: Position;
  results: Map<string, CloseResult>; // settlement per leg id
  inFlight: Set<string>;             // leg ids with a close request in flight
  aborts: AbortController[];         // pending open requests
  covered: boolean;      // pair net has reached >= 0 at least once
  profitMode: boolean;   // take-profit reached, now trailing
  peakNet: number;
  bestPrice: number;     // most favourable mid for the winner since riding began
  bestAt: number;
  lastCloseAttempt: number;
  exitReason?: string;
  closeRequested?: string; // flatten asked for while still opening
}

export interface SessionStats {
  pairs: number; wins: number; losses: number; net: number; liquidations: number;
  paperMinted: number; aborted: number;
}

export class PairTrader {
  private pairs = new Map<number, Pair>();
  private nextPairId = 1;
  private lastStart = 0;
  private openFailures = 0;
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private feedStaleSince: Record<Asset, number> = { BTC: 0, ETH: 0 };
  private lastLoopAt = 0;
  private unmatchedSettlements = new Map<string, { r: CloseResult; at: number }>(); // settled before we knew the leg
  readonly stats: SessionStats = { pairs: 0, wins: 0, losses: 0, net: 0, liquidations: 0, paperMinted: 0, aborted: 0 };

  constructor(private cfg: Config, private feed: PriceFeed, private ex: Executor, private journal: Journal) {}

  start() {
    this.feed.on('tick', (asset: Asset, tick: Tick) => {
      for (const p of this.pairs.values()) if (p.asset === asset) this.guard(() => this.evaluate(p, tick));
    });
    this.ex.onSettled((r) => this.guard(() => this.handleSettled(r)));
    this.timer = setInterval(() => this.guard(() => this.loop()), 250);
  }

  activePairs() { return [...this.pairs.values()].filter((p) => p.state !== 'done'); }

  /** One-line status for the periodic log. */
  statusLine(): string {
    const s = this.stats;
    const rate = s.pairs ? ((s.wins / s.pairs) * 100).toFixed(0) : '–';
    const p = this.ex.paperSummary();
    return `STATUS bal $${this.ex.freeBalance().toFixed(2)} | pairs ${s.pairs} (${s.wins}W/${s.losses}L, ${rate}%) net ${s.net >= 0 ? '+' : ''}$${s.net.toFixed(2)} | liqs ${s.liquidations} | active ${this.activePairs().length} | PAPER +${p.mintedSession.toFixed(0)} (staked ${p.staked.toFixed(0)})`;
  }

  /** Close everything and wait (bounded) until every pair has settled. */
  async stop() {
    this.stopping = true;
    this.flatten('shutdown');
    const t0 = Date.now();
    while (this.activePairs().length && Date.now() - t0 < 120_000) await new Promise((r) => setTimeout(r, 250));
    clearInterval(this.timer);
    const left = this.activePairs();
    if (left.length) log.error(`${left.length} pair(s) still unsettled after 120s: ${left.map((p) => `#${p.id} ${[...this.unsettled(p)].map((l) => l.id).join(',')}`).join(' ')}`);
  }

  private guard(fn: () => void) {
    try { fn(); } catch (e) { log.error('strategy error', e); }
  }

  private legs(p: Pair): Position[] { return [p.long, p.short].filter((x): x is Position => !!x); }
  private unsettled(p: Pair): Position[] { return this.legs(p).filter((l) => !p.results.has(l.id)); }

  // ---------- timer loop ----------

  private loop() {
    const now = Date.now();
    if (this.lastLoopAt && now - this.lastLoopAt > 5000) {
      const open = this.activePairs().filter((p) => p.state !== 'closing').length;
      log.warn(`process was suspended for ${((now - this.lastLoopAt) / 1000).toFixed(0)}s (machine asleep?)${open ? `; ${open} pair(s) were unmanaged meanwhile` : ''}`);
    }
    this.lastLoopAt = now;
    this.watchFeed();
    for (const p of this.activePairs()) {
      if (p.state === 'closing') this.ensureCloses(p);
      else if (p.state === 'both' || p.state === 'riding') {
        const t = this.feed.latest(p.asset);
        if (t) this.evaluate(p, t); // also evaluate when the market is quiet and no tick arrives
      }
    }
    this.maybeStartPair();
  }

  private watchFeed() {
    for (const asset of ASSETS) {
      if (this.feed.healthy(undefined, asset)) { this.feedStaleSince[asset] = 0; continue; }
      if (!this.feedStaleSince[asset]) this.feedStaleSince[asset] = Date.now();
      const exposed = this.activePairs().filter((p) => p.asset === asset && p.state !== 'closing');
      if (exposed.length && Date.now() - this.feedStaleSince[asset] > this.cfg.feedStaleFlattenMs) {
        log.warn(`${asset} price feed stale with open legs; closing its pairs`);
        this.feedStaleSince[asset] = Date.now();
        for (const p of exposed) this.closePairNow(p, 'feed-stale');
      }
    }
  }

  private closePairNow(p: Pair, reason: string) {
    if (p.state === 'opening') {
      p.closeRequested = reason;
      for (const a of p.aborts) a.abort();
    } else if (p.state !== 'closing') {
      this.beginClosing(p, reason);
    }
  }

  /** Request every active pair to close (opening pairs are aborted, then their filled legs closed). */
  private flatten(reason: string) {
    for (const p of this.activePairs()) this.closePairNow(p, reason);
  }

  // ---------- opening ----------

  private maybeStartPair() {
    if (this.stopping) return;
    const active = this.activePairs();
    if (active.length >= this.cfg.maxConcurrentPairs) return;
    const cooldown = this.cfg.pairCooldownMs * 2 ** Math.min(this.openFailures, 6); // back off on repeated open failures
    if (Date.now() - this.lastStart < cooldown) return;
    if (this.stats.net <= -this.cfg.maxSessionLossUsd) {
      log.warn(`session loss limit reached ($${this.stats.net.toFixed(2)}); no new pairs`);
      this.stopping = true;
      return;
    }
    const need = 2 * this.cfg.marginPerLegUsd + this.cfg.minFreeBalanceUsd;
    if (this.ex.freeBalance() < need) return;
    const busy = this.cfg.onePairPerAsset ? new Set(active.map((p) => p.asset)) : new Set<Asset>();
    for (const a of ASSETS) if (!this.feed.healthy(undefined, a)) busy.add(a); // no fresh prices, no new pair
    const pick = pickAsset(this.feed, this.cfg.selectorWindowMs, this.cfg.minActivityBps, busy);
    if (!pick) return;
    this.lastStart = Date.now();
    void this.openPair(pick.asset, pick.activityBps);
  }

  private async openPair(asset: Asset, activity: number) {
    const p: Pair = {
      id: this.nextPairId++, asset, state: 'opening', startedAt: Date.now(),
      results: new Map(), inFlight: new Set(), aborts: [new AbortController(), new AbortController()],
      covered: false, profitMode: false, peakNet: -Infinity, bestPrice: 0, bestAt: 0, lastCloseAttempt: 0,
    };
    this.pairs.set(p.id, p);
    log.info(`pair #${p.id} ${asset}: opening long+short $${this.cfg.marginPerLegUsd} x${this.cfg.leverage} (activity ${activity.toFixed(1)}bps/min)`);
    const m = this.cfg.marginPerLegUsd, lev = this.cfg.leverage;
    let grace: NodeJS.Timeout | undefined;
    const onFill = (pos: Position, other: AbortController) => {
      if (pos.isLong) p.long = pos; else p.short = pos;
      // One leg filled: the other must land soon or we're naked at 1000x. Abort it after a grace period.
      if (!(p.long && p.short) && !grace) grace = setTimeout(() => other.abort(), this.cfg.secondLegGraceMs);
    };
    const [l, s] = await Promise.allSettled([
      this.ex.open(asset, true, m, lev, p.aborts[0].signal).then((pos) => onFill(pos, p.aborts[1])),
      this.ex.open(asset, false, m, lev, p.aborts[1].signal).then((pos) => onFill(pos, p.aborts[0])),
    ]);
    clearTimeout(grace);
    this.adoptUnmatchedSettlements(p);
    const bothFilled = !!(p.long && p.short);
    if (!bothFilled) {
      if (!p.closeRequested) this.openFailures++;
      const err = [l, s].find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason;
      log.warn(`pair #${p.id}: leg failed to open (${err?.message ?? err}); ${p.long || p.short ? 'closing the other' : 'nothing opened'} [failures ${this.openFailures}]`);
      this.stats.aborted++;
      this.beginClosing(p, 'open-failed');
      return;
    }
    this.openFailures = 0;
    if (p.closeRequested) { this.beginClosing(p, p.closeRequested); return; }
    log.info(`pair #${p.id}: filled long @${p.long!.entry} short @${p.short!.entry}`);
    const settled = this.legs(p).find((x) => p.results.has(x.id));
    if (!settled) { p.state = 'both'; return; }
    // A leg was liquidated before both fills were confirmed: it is the loser.
    p.loser = settled;
    p.winner = this.legs(p).find((x) => x.id !== settled.id);
    if (p.results.has(p.winner!.id)) this.beginClosing(p, 'winner-liquidated');
    else this.startRiding(p);
  }

  // ---------- per-tick evaluation ----------

  private evaluate(p: Pair, tick: Tick) {
    const inst = INSTRUMENTS[p.asset];
    const now = Math.max(tick.t, Date.now()); // the loop re-evaluates stale ticks; time must still advance
    if (p.state === 'both') {
      const vl = legValue(p.long!.entry, tick.mid, p.long!.margin, p.long!.leverage, true, inst).payout / p.long!.margin;
      const vs = legValue(p.short!.entry, tick.mid, p.short!.margin, p.short!.leverage, false, inst).payout / p.short!.margin;
      if (vl <= -this.cfg.loserStopPct) this.stopLoser(p, p.long!, p.short!);
      else if (vs <= -this.cfg.loserStopPct) this.stopLoser(p, p.short!, p.long!);
      else if (now - p.startedAt > this.cfg.maxPairHoldMs) this.beginClosing(p, 'max-hold');
      return;
    }
    if (p.state !== 'riding') return;

    const w = p.winner!;
    const dir = w.isLong ? 1 : -1;
    const winnerPayout = legValue(w.entry, tick.mid, w.margin, w.leverage, w.isLong, inst).payout;
    const net = p.results.get(p.loser!.id)!.netPnl + winnerPayout;
    const pairMargin = p.long!.margin + p.short!.margin;
    if ((tick.mid - p.bestPrice) * dir > 0) { p.bestPrice = tick.mid; p.bestAt = now; }
    p.peakNet = Math.max(p.peakNet, net);
    if (net >= 0) p.covered = true;

    let reason: string | undefined;
    if (winnerPayout <= this.cfg.winnerFloorPct * w.margin) reason = 'winner-floor';
    else if (p.covered && net <= this.cfg.breakevenBufferPct * pairMargin) reason = 'breakeven-protect';
    else if (now - p.startedAt > this.cfg.maxPairHoldMs) reason = 'max-hold';
    else {
      if (!p.profitMode && net >= this.cfg.takeProfitPct * pairMargin) p.profitMode = true;
      if (p.profitMode) {
        const past = this.feed.midAt(p.asset, now - this.cfg.momentumWindowMs) ?? tick.mid;
        const momentumBps = ((tick.mid - past) / past) * dir * 1e4;
        const stalled = now - p.bestAt >= this.cfg.stallMs;
        const running = momentumBps >= this.cfg.momentumMinBps && !stalled;
        const gaveBack = net <= p.peakNet * (1 - this.cfg.trailGivebackPct);
        if (gaveBack) reason = 'trail-giveback';
        else if (!running) reason = p.peakNet > this.cfg.takeProfitPct * pairMargin * 1.5 ? 'momentum-stalled' : 'take-profit';
      }
    }
    if (reason) this.beginClosing(p, reason);
  }

  // ---------- transitions ----------

  private stopLoser(p: Pair, loser: Position, winner: Position) {
    if (Date.now() - p.lastCloseAttempt < this.cfg.closeRetryMs) return; // a previous stop attempt just failed
    p.state = 'stopping';
    p.loser = loser;
    p.winner = winner;
    this.closeLeg(p, loser);
  }

  private startRiding(p: Pair) {
    p.state = 'riding';
    p.lastCloseAttempt = 0;
    const mid = this.feed.latest(p.asset)?.mid ?? p.winner!.entry;
    p.bestPrice = mid;
    p.bestAt = Date.now();
    const lr = p.results.get(p.loser!.id)!;
    log.info(`pair #${p.id}: loser ${p.loser!.isLong ? 'long' : 'short'} closed ${fmt(lr.netPnl)}${lr.liquidated ? ' (LIQUIDATED)' : ''}; riding ${p.winner!.isLong ? 'long' : 'short'}`);
  }

  private beginClosing(p: Pair, reason: string) {
    if (p.state === 'done') return;
    if (p.state !== 'closing') p.exitReason = reason;
    p.state = 'closing';
    this.ensureCloses(p);
  }

  /** Closing state: (re)send closes for every unsettled leg, finish once all have settled. */
  private ensureCloses(p: Pair) {
    if (p.state !== 'closing') return;
    const open = this.unsettled(p);
    if (!open.length) { this.finish(p); return; }
    if (Date.now() - p.lastCloseAttempt < this.cfg.closeRetryMs) return;
    for (const leg of open) this.closeLeg(p, leg);
  }

  private closeLeg(p: Pair, leg: Position) {
    if (p.inFlight.has(leg.id) || p.results.has(leg.id)) return;
    p.inFlight.add(leg.id);
    p.lastCloseAttempt = Date.now();
    this.ex.close(leg).then(
      (r) => { p.inFlight.delete(leg.id); this.guard(() => this.settle(p, r)); },
      (e) => {
        p.inFlight.delete(leg.id);
        log.error(`pair #${p.id}: close of ${leg.id} failed (${(e as Error).message}); will retry`);
        this.guard(() => { if (p.state === 'stopping') p.state = 'both'; }); // closing state retries from the loop
      },
    );
  }

  /** Record a leg's settlement (from our close or from a liquidation) and advance the pair. */
  private settle(p: Pair, r: CloseResult) {
    if (p.results.has(r.positionId)) return;
    const leg = this.legs(p).find((x) => x.id === r.positionId);
    if (!leg) return;
    p.results.set(r.positionId, r);
    if (r.liquidated) log.warn(`pair #${p.id}: ${leg.isLong ? 'long' : 'short'} LIQUIDATED (${fmt(r.netPnl)})`);
    switch (p.state) {
      case 'opening':
        return; // openPair decides once both fills are known
      case 'both': // settled under us: that leg is the loser
        p.loser = leg;
        p.winner = this.legs(p).find((x) => x.id !== leg.id);
        this.startRiding(p);
        return;
      case 'stopping':
        if (leg.id === p.winner!.id) { this.beginClosing(p, 'winner-liquidated'); return; }
        if (p.results.has(p.winner!.id)) { this.beginClosing(p, 'winner-liquidated'); return; }
        this.startRiding(p);
        return;
      case 'riding':
        this.beginClosing(p, 'winner-liquidated');
        return;
      case 'closing':
        this.ensureCloses(p);
        return;
    }
  }

  private handleSettled(r: CloseResult) {
    for (const p of this.activePairs()) {
      if (this.legs(p).some((x) => x.id === r.positionId)) { this.settle(p, r); return; }
    }
    // Can arrive in the same stream batch as the fill, before openPair has recorded the leg.
    this.unmatchedSettlements.set(r.positionId, { r, at: Date.now() });
    for (const [id, u] of this.unmatchedSettlements) if (Date.now() - u.at > 60_000) this.unmatchedSettlements.delete(id);
  }

  private adoptUnmatchedSettlements(p: Pair) {
    for (const leg of this.legs(p)) {
      const u = this.unmatchedSettlements.get(leg.id);
      if (u) { this.unmatchedSettlements.delete(leg.id); this.settle(p, u.r); }
    }
  }

  private finish(p: Pair) {
    if (p.state === 'done') return;
    p.state = 'done';
    const reason = p.exitReason ?? 'unknown';
    const results = [...p.results.values()];
    const net = results.reduce((a, r) => a + r.netPnl, 0);
    const minted = results.reduce((a, r) => a + r.paperMinted, 0);
    const liqs = results.filter((r) => r.liquidated).length;
    if (reason !== 'open-failed') {
      this.stats.pairs++;
      if (net > 0) this.stats.wins++; else this.stats.losses++;
    }
    this.stats.net += net;
    this.stats.liquidations += liqs;
    this.stats.paperMinted += minted;
    const heldS = ((Date.now() - p.startedAt) / 1000).toFixed(1);
    log.info(`pair #${p.id} ${p.asset} done [${reason}] net ${fmt(net)} in ${heldS}s | session ${this.stats.wins}W/${this.stats.losses}L net ${fmt(this.stats.net)}`);
    const lr = p.loser && p.results.get(p.loser.id), wr = p.winner && p.results.get(p.winner.id);
    this.journal.write({
      mode: this.ex.mode, pair: p.id, asset: p.asset, reason, net, heldMs: Date.now() - p.startedAt,
      loser: lr && { side: p.loser!.isLong ? 'long' : 'short', pnl: lr.netPnl, liquidated: lr.liquidated },
      winner: wr && { side: p.winner!.isLong ? 'long' : 'short', pnl: wr.netPnl, liquidated: wr.liquidated },
      entry: p.long?.entry ?? p.short?.entry, peakNet: Number.isFinite(p.peakNet) ? p.peakNet : null,
      paperMinted: minted, liquidations: liqs,
    });
    setTimeout(() => this.pairs.delete(p.id), 60_000).unref();
  }
}

const fmt = (x: number) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;

// Simulated executor: same strategy, live HL prices, Papertrade's exact payout math, no real orders.
// Fills happen at the HL mid after a random relayer delay, as on the real exchange.

import { INSTRUMENTS, URLS, type Asset } from '../constants.ts';
import { bustPrice, isBusted, legValue, paperMintRate } from '../math.ts';
import type { PriceFeed } from '../prices.ts';
import { log } from '../log.ts';
import type { CloseResult, Executor, Position } from './types.ts';

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('open aborted')); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error('open aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class SimExecutor implements Executor {
  readonly mode = 'sim' as const;
  private balance: number;
  private open_ = new Map<string, Position>();
  private closing = new Set<string>();
  private nextId = 1;
  private settledCbs: ((r: CloseResult) => void)[] = [];
  private mintRate = 25;
  private paper = { unstaked: 0, staked: 0, mintedSession: 0 };
  private rateTimer?: NodeJS.Timeout;

  constructor(private feed: PriceFeed, startBalance: number, private latency: [number, number], private liveMintRate = true) {
    this.balance = startBalance;
  }

  async init() {
    if (this.liveMintRate) {
      await this.refreshMintRate();
      this.rateTimer = setInterval(() => void this.refreshMintRate(), 5 * 60_000);
    }
    // Liquidation keeper: check every tick for busted positions.
    this.feed.on('tick', (asset: Asset, tick) => {
      for (const p of this.open_.values()) {
        if (p.asset === asset && !this.closing.has(p.id) && isBusted(tick.mid, p.bust, p.isLong)) {
          const r = this.settleLiquidation(p);
          for (const cb of this.settledCbs) cb(r);
        }
      }
    });
  }

  private async refreshMintRate() {
    try {
      const res = await fetch(`${URLS.exchange}/query/protocol/summary`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      const j = await res.json() as { paper: { trackedLp: string; tailProgress: string } };
      this.mintRate = paperMintRate(Number(BigInt(j.paper.trackedLp) / 10n ** 12n) / 1e6, Number(BigInt(j.paper.tailProgress) / 10n ** 12n) / 1e6);
    } catch (e) {
      log.warn('could not refresh PAPER mint rate, keeping', this.mintRate.toFixed(1), String(e));
    }
  }

  private delay(signal?: AbortSignal) {
    const [a, b] = this.latency;
    return sleep(a + Math.random() * (b - a), signal);
  }

  async open(asset: Asset, isLong: boolean, margin: number, leverage: number, signal?: AbortSignal): Promise<Position> {
    if (margin > this.balance) throw new Error('insufficient balance');
    this.balance -= margin; // reserved while pending
    try {
      await this.delay(signal);
    } catch (e) {
      this.balance += margin; // cancelled before it filled
      throw e;
    }
    const mid = this.feed.latest(asset)!.mid;
    const inst = INSTRUMENTS[asset];
    const entry = Math.round(mid * inst.priceScale) / inst.priceScale;
    const pos: Position = {
      id: `sim-${this.nextId++}`, asset, isLong, entry, margin, leverage,
      bust: bustPrice(entry, leverage, isLong, inst), openedAt: Date.now(),
    };
    this.open_.set(pos.id, pos);
    return pos;
  }

  async close(pos: Position): Promise<CloseResult> {
    if (!this.open_.has(pos.id)) throw new Error(`position ${pos.id} not open`);
    this.closing.add(pos.id);
    await this.delay();
    this.closing.delete(pos.id);
    if (!this.open_.has(pos.id)) throw new Error(`position ${pos.id} vanished`);
    const exit = this.feed.latest(pos.asset)!.mid;
    // The keeper liquidates first if the bust was crossed while our close was in flight.
    if (isBusted(exit, pos.bust, pos.isLong)) return this.settleLiquidation(pos);
    const { payout } = legValue(pos.entry, exit, pos.margin, pos.leverage, pos.isLong, INSTRUMENTS[pos.asset]);
    this.open_.delete(pos.id);
    this.balance += pos.margin + payout;
    // Losing close: 2% LP-side fee is carved from the loss basis (queue empty), PAPER mints on the rest.
    const minted = payout < 0 ? -payout * 0.98 * this.mintRate : 0;
    this.creditPaper(minted);
    return { positionId: pos.id, netPnl: payout, liquidated: false, paperMinted: minted, exit };
  }

  async closeMany(positions: Position[]): Promise<PromiseSettledResult<CloseResult>[]> {
    for (const p of positions) if (this.open_.has(p.id)) this.closing.add(p.id);
    await this.delay();
    const out: PromiseSettledResult<CloseResult>[] = [];
    for (const pos of positions) {
      this.closing.delete(pos.id);
      if (!this.open_.has(pos.id)) { out.push({ status: 'rejected', reason: new Error(`position ${pos.id} not open`) }); continue; }
      const exit = this.feed.latest(pos.asset)!.mid;
      if (isBusted(exit, pos.bust, pos.isLong)) { out.push({ status: 'fulfilled', value: this.settleLiquidation(pos) }); continue; }
      const { payout } = legValue(pos.entry, exit, pos.margin, pos.leverage, pos.isLong, INSTRUMENTS[pos.asset]);
      this.open_.delete(pos.id);
      this.balance += pos.margin + payout;
      const minted = payout < 0 ? -payout * 0.98 * this.mintRate : 0;
      this.creditPaper(minted);
      out.push({ status: 'fulfilled', value: { positionId: pos.id, netPnl: payout, liquidated: false, paperMinted: minted, exit } });
    }
    return out;
  }

  private settleLiquidation(pos: Position): CloseResult {
    this.open_.delete(pos.id);
    const minted = pos.margin * this.mintRate;
    this.creditPaper(minted);
    return { positionId: pos.id, netPnl: -pos.margin, liquidated: true, paperMinted: minted, exit: pos.bust };
  }

  private creditPaper(n: number) {
    this.paper.unstaked += n;
    this.paper.mintedSession += n;
  }

  onSettled(cb: (r: CloseResult) => void) { this.settledCbs.push(cb); }
  openPositionIds() { return [...this.open_.keys()]; }
  lifetimePnl() { return undefined; }
  freeBalance() { return this.balance; }

  async stakePaper() {
    if (this.paper.unstaked >= 1000) {
      log.info(`[sim] staking ${this.paper.unstaked.toFixed(0)} PAPER`);
      this.paper.staked += this.paper.unstaked;
      this.paper.unstaked = 0;
    }
  }
  async claimRewards() { /* sim: staker rewards not modelled */ }
  paperSummary() { return { ...this.paper }; }

  async shutdown() {
    clearInterval(this.rateTimer);
    for (const p of [...this.open_.values()]) {
      try { await this.close(p); } catch { /* ignore */ }
    }
  }
}

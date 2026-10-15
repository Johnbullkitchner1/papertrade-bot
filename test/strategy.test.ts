import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { config } from '../src/config.ts';
import { SimExecutor } from '../src/executor/sim.ts';
import type { CloseResult, Position } from '../src/executor/types.ts';
import { PairTrader } from '../src/strategy.ts';
import { Journal } from '../src/log.ts';
import type { Asset } from '../src/constants.ts';
import type { PriceFeed, Tick } from '../src/prices.ts';

/** Minimal scripted feed: BTC follows the given path, ETH is flat. */
class FakeFeed extends EventEmitter {
  ticks: Record<Asset, Tick[]> = { BTC: [], ETH: [] };
  push(asset: Asset, mid: number) {
    const t: Tick = { t: Date.now(), mid, bid: mid - 0.5, ask: mid + 0.5 };
    this.ticks[asset].push(t);
    this.emit('tick', asset, t);
  }
  latest(a: Asset) { return this.ticks[a].at(-1); }
  midAt(a: Asset, t: number) { const h = this.ticks[a]; for (let i = h.length - 1; i >= 0; i--) if (h[i].t <= t) return h[i].mid; return h[0]?.mid; }
  ticksSince(a: Asset, t: number) { return this.ticks[a].filter((x) => x.t >= t); }
  healthy() { return true; }
}

/** Sim executor with fault injection. */
class FaultyExecutor extends SimExecutor {
  failCloses = 0;          // reject this many close() calls before behaving
  stuckShortOpen = false;  // short opens never fill until aborted
  closeCalls = 0;
  override async open(asset: Asset, isLong: boolean, margin: number, lev: number, signal?: AbortSignal): Promise<Position> {
    if (this.stuckShortOpen && !isLong) {
      await new Promise<void>((_, rej) => signal?.addEventListener('abort', () => rej(new Error('open aborted')), { once: true }));
    }
    return super.open(asset, isLong, margin, lev, signal);
  }
  override async close(pos: Position): Promise<CloseResult> {
    this.closeCalls++;
    if (this.failCloses > 0) { this.failCloses--; throw new Error('relayer 503'); }
    return super.close(pos);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runScenario(path: number[], opts: { stepMs?: number; setup?: (ex: FaultyExecutor) => void; cfg?: Partial<typeof config> } = {}) {
  const feed = new FakeFeed();
  const cfg = { ...config, leverage: 1000, takeProfitPct: 0.10, maxPairHoldMs: 15 * 60_000, maxConcurrentPairs: 1, pairCooldownMs: 1e9, stallMs: 200, momentumWindowMs: 200, minActivityBps: 0, closeRetryMs: 100, secondLegGraceMs: 200, ...opts.cfg };
  const ex = new FaultyExecutor(feed as unknown as PriceFeed, 49, [0, 0], false);
  opts.setup?.(ex);
  await ex.init();
  // BTC is busier than ETH so the selector picks it.
  for (let i = 0; i < 30; i++) { feed.push('BTC', 100_000 + (i % 2) * 2); feed.push('ETH', 3000); }
  feed.push('BTC', 100_000);
  const dir = mkdtempSync(`${tmpdir()}/ptb-`);
  const trader = new PairTrader(cfg, feed as unknown as PriceFeed, ex, new Journal(`${dir}/j.jsonl`));
  trader.start();
  await sleep(400); // pair opens at 100000
  for (const mid of path) { feed.push('BTC', mid); await sleep(opts.stepMs ?? 60); }
  await sleep(300);
  await trader.stop();
  return { stats: trader.stats, balance: ex.freeBalance(), ex };
}

test('down-move: long stopped at -30%, short rides to take-profit and the pair nets a profit', async () => {
  // -3.5 bps stops the long, then a steady fall to -9 bps, then a bounce triggers the trailing exit.
  const path = [99_990, 99_980, 99_970, 99_965, 99_955, 99_945, 99_935, 99_925, 99_915, 99_910, 99_910, 99_910, 99_930, 99_960];
  const { stats, balance } = await runScenario(path);
  assert.equal(stats.pairs, 1);
  assert.equal(stats.wins, 1, `net ${stats.net}`);
  assert.ok(stats.net > 0);
  assert.ok(Math.abs(balance - (49 + stats.net)) < 1e-9);
});

test('whipsaw: loser stopped, price reverses, winner closed at its floor before turning negative', async () => {
  const path = [99_990, 99_970, 99_965, 99_975, 99_985, 99_995, 100_005];
  const { stats } = await runScenario(path);
  assert.equal(stats.pairs, 1);
  assert.equal(stats.liquidations, 0);
  assert.ok(stats.net < 0 && stats.net > -3, `net ${stats.net}`); // lost less than the loser's $3
});

test('rejected closes are retried until every leg settles; nothing is left open', async () => {
  const path = [99_990, 99_970, 99_965, 99_975, 99_985, 99_995, 100_005, 100_005, 100_005, 100_005];
  const { stats, ex } = await runScenario(path, { setup: (e) => { e.failCloses = 3; }, stepMs: 100 });
  assert.equal(stats.pairs, 1);
  assert.deepEqual(ex.openPositionIds(), []);
  assert.ok(ex.closeCalls >= 5, `close calls ${ex.closeCalls}`); // 3 failures + 2 successful legs
  assert.ok(stats.net < 0 && stats.net > -10, `net ${stats.net}`);
});

test('second leg never fills: it is aborted, the lone leg is closed and the pair is counted as aborted', async () => {
  const { stats, ex } = await runScenario([100_000, 100_000, 100_000, 100_000, 100_000], { setup: (e) => { e.stuckShortOpen = true; }, stepMs: 100 });
  assert.equal(stats.pairs, 0);
  assert.equal(stats.aborted, 1);
  assert.deepEqual(ex.openPositionIds(), []);
});

test('liquidation of the loser before its stop fills: the pair rides the other leg', async () => {
  // Latency 150 ms; price gaps straight through the bust (-5.2 bps) so the keeper gets there first.
  const path = [99_990, 99_930, 99_900, 99_880, 99_870, 99_870, 99_870, 99_900];
  const { stats, ex } = await runScenario(path, { setup: (e) => { (e as unknown as { latency: [number, number] }).latency = [150, 150]; } });
  assert.equal(stats.pairs, 1);
  assert.equal(stats.liquidations, 1);
  assert.deepEqual(ex.openPositionIds(), []);
});

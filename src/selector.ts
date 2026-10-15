// Picks BTC or ETH for the next pair.
//
// A pair only pays when price keeps moving after the loser is stopped (~3 bps), so "looking better"
// means: more live movement, weighted by how much of a typical winning move the haircut lets us keep.

import { ASSETS, INSTRUMENTS, type Asset } from './constants.ts';
import { impactScale } from './math.ts';
import type { PriceFeed } from './prices.ts';
import { marketOpen, tradingPaused } from './markets.ts';

export interface AssetScore { asset: Asset; activityBps: number; keep: number; score: number }

/** Sum of absolute mid changes (bps) over the window: how much the price is actually travelling. */
export function activityBps(feed: PriceFeed, asset: Asset, windowMs: number, now = Date.now()): number {
  const ticks = feed.ticksSince(asset, now - windowMs);
  let path = 0;
  for (let i = 1; i < ticks.length; i++) path += Math.abs(ticks[i].mid - ticks[i - 1].mid) / ticks[i - 1].mid;
  return path * 1e4;
}

export function scoreAssets(feed: PriceFeed, windowMs: number): AssetScore[] {
  return ASSETS.map((asset) => {
    const act = activityBps(feed, asset, windowMs);
    // Payout share kept on a typical profitable pair exit (~7.5 bps move).
    const keep = impactScale(0.00075, INSTRUMENTS[asset]);
    return { asset, activityBps: act, keep, score: act * keep };
  }).sort((a, b) => b.score - a.score);
}

export function pickAsset(feed: PriceFeed, windowMs: number, minActivityBps: number, exclude = new Set<Asset>()): AssetScore | undefined {
  if (tradingPaused) return undefined;
  const best = scoreAssets(feed, windowMs).filter((s) => marketOpen[s.asset] && !exclude.has(s.asset))[0];
  return best && best.activityBps >= minActivityBps ? best : undefined;
}

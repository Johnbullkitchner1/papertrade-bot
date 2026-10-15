// Papertrade settlement math, ported from the official frontend (valuation + bust preview)
// and the docs' "Asymmetric impact PnL" page.

import type { InstrumentParams } from './constants.ts';

/** Exact bust (hard-liquidation trigger) price in raw price units (USD * priceScale). */
export function bustPriceRaw(entryRaw: bigint, leverage: number, isLong: boolean, bustBuffer1e18: bigint): bigint {
  const d = entryRaw / BigInt(leverage);
  const a = isLong ? entryRaw - d : entryRaw + d;
  return isLong ? a + (a * bustBuffer1e18) / 10n ** 18n : a - (a * bustBuffer1e18) / 10n ** 18n;
}

/** Bust price in USD. */
export function bustPrice(entry: number, leverage: number, isLong: boolean, inst: InstrumentParams): number {
  const raw = bustPriceRaw(
    BigInt(Math.round(entry * inst.priceScale)), leverage, isLong,
    BigInt(Math.round(inst.bustBuffer * 1e18)),
  );
  return Number(raw) / inst.priceScale;
}

export function isBusted(mid: number, bust: number, isLong: boolean): boolean {
  return isLong ? mid <= bust : mid >= bust;
}

/** Share of a raw gain kept by the impact haircut (before the win fee), for fractional move d. */
export function impactScale(d: number, inst: InstrumentParams): number {
  if (d <= 0) return 0;
  const term1 = 1 / (d * inst.rateMultiplier);
  const term2 = inst.referenceNotional / (1e6 * d * inst.positionMultiplier);
  return (1 - inst.baseRate) / (1 + term1 + term2);
}

export interface LegValue {
  raw: number;    // raw PnL in USD (price move * notional), losses capped at -margin
  payout: number; // what closing now would credit/debit vs. margin (after deadband, impact, win fee)
}

/** Value of closing a position at `exit` right now. Mirrors the frontend's pnl(). */
export function legValue(
  entry: number, exit: number, margin: number, leverage: number, isLong: boolean, inst: InstrumentParams,
): LegValue {
  const band = entry / 50000; // 0.2 bps deadband applied to winning exits
  let c = exit;
  if (isLong) { if (exit > entry + band) c = exit - band; else if (exit > entry) c = entry; }
  else { if (exit + band < entry) c = exit + band; else if (exit < entry) c = entry; }
  const move = isLong ? c - entry : entry - c;
  const raw = (margin * leverage * move) / entry;
  if (raw <= 0) return { raw, payout: Math.max(raw, -margin) };
  const adjusted = raw * impactScale(Math.abs(move) / entry, inst);
  return { raw, payout: adjusted * (1 - inst.winFeeRate) };
}

/** PAPER minted per $1 of loss basis, given tracked LP and tail high-water-mark (USD). */
export function paperMintRate(trackedLpUsd: number, tailProgressUsd: number, flatRate = 100, threshold = 2e6, decay = 120e6): number {
  if (trackedLpUsd < threshold) return flatRate;
  return flatRate * (decay / (decay + tailProgressUsd)) ** 2;
}

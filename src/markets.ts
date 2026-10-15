// Keeps instrument parameters and market status in sync with the live exchange (/state/trading).

import { ASSET_BY_ID, INSTRUMENTS, type Asset } from './constants.ts';
import { getJson } from './papertrade/api.ts';
import { log } from './log.ts';

export const marketOpen: Record<Asset, boolean> = { BTC: true, ETH: true };
export let tradingPaused = false;

const f18 = (s: string) => Number(BigInt(s)) / 1e18;

export async function refreshMarkets() {
  try {
    const t = await getJson<{ tradingPaused: boolean; instruments: unknown[][] }>('/state/trading');
    tradingPaused = t.tradingPaused;
    for (const row of t.instruments) {
      const asset = ASSET_BY_ID[Number(row[0])];
      if (!asset) continue;
      const [, , , priceScale, active, paused, retired, closeOnly, terminal] = row as [number, string, number, string, boolean, boolean, boolean, boolean, boolean];
      marketOpen[asset] = active && !paused && !retired && !closeOnly && !terminal;
      Object.assign(INSTRUMENTS[asset], {
        priceScale: Number(priceScale),
        rateMultiplier: f18(row[12] as string),
        positionMultiplier: f18(row[13] as string),
        bustBuffer: f18(row[16] as string),
        baseRate: f18(row[17] as string),
        referenceNotional: f18(row[18] as string),
      });
    }
  } catch (e) {
    log.warn('could not refresh market params:', (e as Error).message);
  }
}

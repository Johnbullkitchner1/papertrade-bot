import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bustPriceRaw, impactScale, legValue, paperMintRate } from '../src/math.ts';
import { INSTRUMENTS } from '../src/constants.ts';

test('bust price matches a live position (BTC long, entry 83461.5, 333x -> 83250.5)', () => {
  assert.equal(bustPriceRaw(834615n, 333, true, 476041580087574n), 832505n);
});

test('impact haircut matches docs: BTC 1% move keeps ~88%, 0.1% ~74% (with deadband)', () => {
  const btc = INSTRUMENTS.BTC;
  const keep = (move: number) => impactScale(move - 0.00002, btc) * (move - 0.00002) / move;
  assert.ok(Math.abs(keep(0.01) - 0.88) < 0.01, `1%: ${keep(0.01)}`);
  assert.ok(Math.abs(keep(0.001) - 0.74) < 0.01, `0.1%: ${keep(0.001)}`);
});

test('losses are taken in full and capped at margin; wins pay haircut and 2% fee', () => {
  const btc = INSTRUMENTS.BTC;
  // 1000x, $10 margin, -3 bps: raw -$3, no haircut on losses
  const loss = legValue(100_000, 99_970, 10, 1000, true, btc);
  assert.ok(Math.abs(loss.payout + 3) < 1e-9);
  // beyond margin -> capped
  assert.equal(legValue(100_000, 99_000, 10, 1000, true, btc).payout, -10);
  // +5 bps: about 60% of the $5 raw kept after impact + fee
  const win = legValue(100_000, 100_050, 10, 1000, true, btc);
  assert.ok(win.payout > 2.9 && win.payout < 3.1, `win ${win.payout}`);
  // within the 0.2 bp deadband: zero
  assert.equal(legValue(100_000, 100_001, 10, 1000, true, btc).payout, 0);
});

test('PAPER mint rate: flat below $2M, decays with tail progress', () => {
  assert.equal(paperMintRate(1e6, 0), 100);
  assert.ok(Math.abs(paperMintRate(5e6, 100e6) - 100 * (120 / 220) ** 2) < 1e-9);
});

// Writes the stats-page data files: logs/dashboard/account.json (live wallet state) and
// logs/dashboard/trades.json (every finished farm trade from the live journal). Read-only: signs nothing.
// Usage: npm run stats:export

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config.ts';
import { WalletStream } from './papertrade/api.ts';

const usd = (raw: bigint) => Number(raw) / 1e18;
const key = process.env.WALLET_PRIVATE_KEY;
if (!key) throw new Error('WALLET_PRIVATE_KEY missing from .env');
const wallet = privateKeyToAccount(key as `0x${string}`).address.toLowerCase();

const stream = new WalletStream(wallet);
stream.start();
const s = await Promise.race([
  stream.ready(),
  new Promise<never>((_, rej) => setTimeout(() => rej(new Error('wallet stream timed out')), 30_000)),
]);
stream.stop();

let marginInUse = 0;
for (const p of s.positions.values()) marginInUse += usd(p.marginRaw);
const available = usd(s.funds.availableBalance);
const account = [{
  asOf: new Date().toISOString(),
  availableUsd: available,
  marginInUseUsd: marginInUse,
  openPairs: s.positions.size / 2,
  lifetimePnlUsd: usd(s.lifetimeRealizedPnl),
  paperStaked: usd(s.paper.staked),
  paperUnstaked: usd(s.paper.balance),
  budgetUsd: config.farmBudgetUsd,
  targetPaper: config.farmTargetPaper,
}];

const trades = readFileSync('logs/journal-farm-live.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((r) => r.strategy === 'farm' && r.reason !== 'open-failed')
  .map((r, i) => ({
    n: i + 1, closedAt: r.t, day: r.t.slice(0, 10), asset: r.asset, reason: r.reason,
    netUsd: r.net, paper: r.paperMinted, costPerPaperUsd: r.costPerPaper,
    heldMin: Math.round(r.heldMs / 6e4), liquidations: r.liquidations,
  }));

mkdirSync('logs/dashboard', { recursive: true });
writeFileSync('logs/dashboard/account.json', JSON.stringify(account, null, 2));
writeFileSync('logs/dashboard/trades.json', JSON.stringify(trades, null, 2));
console.log(JSON.stringify(account[0]), `\n${trades.length} trades`);
process.exit(0);

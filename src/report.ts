// Summarises the pair journal: `npm run stats [-- sim|live]`.

import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const farm = args.includes('farm');
const mode = args.find((a) => a === 'sim' || a === 'live') ?? 'sim';
const file = new URL(`../logs/journal-${farm ? 'farm-' : ''}${mode}.jsonl`, import.meta.url).pathname;
if (!existsSync(file)) { console.log(`no journal yet at ${file}`); process.exit(0); }

const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.reason !== 'open-failed');

if (farm) {
  const minted = rows.reduce((a, r) => a + (r.paperMinted ?? 0), 0);
  const spent = -rows.reduce((a, r) => a + r.net, 0);
  const liqs = rows.reduce((a, r) => a + (r.liquidations ?? 0), 0);
  const held = rows.length ? rows.reduce((a, r) => a + r.heldMs, 0) / rows.length / 60000 : 0;
  console.log(`journal: ${file}\n`);
  console.log(`cycles ${rows.length} | PAPER ${minted.toFixed(0)} for $${spent.toFixed(2)} = $${minted ? (spent / minted).toFixed(4) : '–'}/PAPER | liquidations ${liqs} | avg cycle ${held.toFixed(0)} min`);
  const reasons: Record<string, number> = {};
  for (const r of rows) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  console.log('exit reasons:', reasons);
  process.exit(0);
}

function summarise(label: string, rs: typeof rows) {
  if (!rs.length) return;
  const wins = rs.filter((r) => r.net > 0);
  const net = rs.reduce((a, r) => a + r.net, 0);
  const avgWin = wins.length ? wins.reduce((a, r) => a + r.net, 0) / wins.length : 0;
  const losses = rs.filter((r) => r.net <= 0);
  const avgLoss = losses.length ? losses.reduce((a, r) => a + r.net, 0) / losses.length : 0;
  const liqs = rs.reduce((a, r) => a + (r.liquidations ?? 0), 0);
  const paper = rs.reduce((a, r) => a + (r.paperMinted ?? 0), 0);
  const held = rs.reduce((a, r) => a + r.heldMs, 0) / rs.length / 1000;
  console.log(`${label.padEnd(8)} pairs ${String(rs.length).padStart(4)} | win rate ${((wins.length / rs.length) * 100).toFixed(1).padStart(5)}% | net ${net >= 0 ? '+' : ''}$${net.toFixed(2).padStart(7)} | avg win +$${avgWin.toFixed(2)} avg loss -$${Math.abs(avgLoss).toFixed(2)} | liqs ${liqs} | avg hold ${held.toFixed(0)}s | PAPER ${paper.toFixed(0)}`);
}

console.log(`journal: ${file}\n`);
summarise('ALL', rows);
summarise('BTC', rows.filter((r) => r.asset === 'BTC'));
summarise('ETH', rows.filter((r) => r.asset === 'ETH'));
const reasons: Record<string, { n: number; net: number }> = {};
for (const r of rows) { reasons[r.reason] ??= { n: 0, net: 0 }; reasons[r.reason].n++; reasons[r.reason].net += r.net; }
console.log('\nexit reasons:');
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${k.padEnd(20)} ${String(v.n).padStart(4)}  net ${v.net >= 0 ? '+' : ''}$${v.net.toFixed(2)}`);
}

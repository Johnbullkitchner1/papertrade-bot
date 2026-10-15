# Farm backtest: open a hedge at a candle open, close both legs together once |move| >= target
# (or a leg reaches the bust guard). Cost = loss on loser - payout of winner, +1 bp slippage per leg.
import json
INST = {"BTC": dict(pm=814.598, buf=0.000476), "ETH": dict(pm=483.979, buf=0.000481)}
BASE, RM, REF, FEE, MINT = 0.10, 15000, 100000, 0.02, 23.6
def payout(move, margin, L, pm):
    if move <= 0: return max(move*margin*L, -margin)
    m = max(move - 1/50000, 0)
    if m <= 0: return 0.0
    return m*margin*L*(1-BASE)/(1 + 1/(m*RM) + REF/(1e6*m*pm))*(1-FEE)
def run(asset, c, L, tgt_bps, guard=0.85, margin=10.0, slip_bps=1.0):
    pm, buf = INST[asset]["pm"], INST[asset]["buf"]
    d_bust = 1/L - buf*(1-1/L); d_guard = guard*d_bust; d_tgt = tgt_bps/1e4
    exit_d = min(d_tgt, d_guard)
    out = []; i = 0; n = len(c)
    while i < n-1:
        E = c[i][1]; k = i
        while k < n:
            h, l = c[k][2], c[k][3]
            mv = max((h-E)/E, (E-l)/E)
            if mv >= exit_d: break
            k += 1
        if k >= n: break
        d = exit_d + slip_bps/1e4 * 0   # exit at the trigger level
        loss = min(d*margin*L, margin)
        win = payout(d, margin, L, pm)
        slip = 2*margin*L*slip_bps/1e4
        cost = loss - win + slip
        paper = loss*0.98*MINT
        out.append((cost, paper, (c[k][0]-c[i][0])/60000))
        i = k+1
    return out
data = {a: json.load(open(f"{a}_1m.json")) for a in ("BTC","ETH")}
days = (data["BTC"][-1][0]-data["BTC"][0][0])/86400e3
print(f"{days:.1f} days, $10/leg, 1 bp slippage per leg, mint {MINT} PAPER/$, yield $0.00047/PAPER/day\n")
print(f"{'lev':>4} {'tgt':>4} | {'cycles':>6} {'/day':>5} {'avg min':>7} | {'cost/cyc':>8} {'PAPER/cyc':>9} {'$/PAPER':>8} {'payback':>8}")
for L in (100, 50):
    for t in (20, 30, 40, 60, 80):
        r = run("BTC", data["BTC"], L, t) + run("ETH", data["ETH"], L, t)
        if not r: continue
        cost = sum(x[0] for x in r); paper = sum(x[1] for x in r); mins = sum(x[2] for x in r)/len(r)
        per = cost/paper
        print(f"{L:>4} {t:>4} | {len(r):>6} {len(r)/days/2:>5.1f} {mins:>7.0f} | {cost/len(r):>8.2f} {paper/len(r):>9.0f} {per:>8.4f} {per/0.00047:>7.0f}d")

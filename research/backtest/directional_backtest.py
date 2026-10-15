# Single-leg directional variants on the same data: momentum (follow the last N-min move) vs mean-reversion (fade it).
import json
INST = {"BTC": dict(pm=814.598, buf=0.000476), "ETH": dict(pm=483.979, buf=0.000481)}
BASE, RM, REF, FEE = 0.10, 15000, 100000, 0.02
def payout(move, margin, L, pm):
    if move <= 0: return max(move * margin * L, -margin)
    m = max(move - 1/50000, 0)
    if m <= 0: return 0.0
    return m*margin*L * (1-BASE)/(1 + 1/(m*RM) + REF/(1e6*m*pm)) * (1-FEE)
def solve_move(tp, margin, L, pm):
    lo, hi = 0.0, 0.5
    for _ in range(60):
        mid=(lo+hi)/2
        if payout(mid,margin,L,pm) < tp: lo=mid
        else: hi=mid
    return hi
def run(asset, c, L, stop, tp, N, thr_mult, fade, slip_bps=1.0, margin=10.0):
    pm, buf = INST[asset]["pm"], INST[asset]["buf"]
    d_stop, d_liq = stop/L, 1/L - buf*(1-1/L)
    slip = margin*L*slip_bps/1e4
    mv_tp = solve_move(tp*margin, margin, L, pm)
    max_hold = int(min(1440, 15*1000/L))
    st = dict(n=0, wins=0, net=0.0, liqs=0)
    i, n = N+1, len(c)
    while i < n-2:
        m = (c[i][1]-c[i-N][1])/c[i-N][1]
        if abs(m) < thr_mult*d_stop: i += 1; continue
        sgn = (1 if m > 0 else -1) * (-1 if fade else 1)
        E = c[i][1]; k = i; w = None
        while k < n:
            _,o,h,l,cl = c[k]
            fav = sgn*((h if sgn>0 else l)-E)/E; adv = -sgn*((l if sgn>0 else h)-E)/E
            fav_first = (cl > o) == (sgn > 0)
            def adverse():
                if adv >= d_liq: return (-margin, 1)
                if adv >= d_stop: return (-stop*margin - slip, 0)
                return None
            def favour():
                if fav >= mv_tp: return (payout(mv_tp,margin,L,pm) - slip, 0)
                return None
            w = (favour() or adverse()) if fav_first else (adverse() or favour())
            if w is None and k-i >= max_hold: w = (payout(sgn*(cl-E)/E,margin,L,pm) - slip, 0)
            if w: break
            k += 1
        if not w: break
        st['n'] += 1; st['net'] += w[0]; st['liqs'] += w[1]; st['wins'] += w[0] > 0
        i = k+1
    return st
data = {a: json.load(open(f"{a}_1m.json")) for a in ("BTC","ETH")}
days = (data["BTC"][-1][0]-data["BTC"][0][0])/86400e3
print(f"single leg, $10 margin, stop 30% of margin, 1 bp slippage, {days:.1f} days\n")
print(f"{'mode':>6} {'lev':>4} {'tp':>4} {'N':>3} {'thr':>4} | {'n':>5} {'win%':>5} {'avg$':>6} {'liq':>4} | {'$/day':>7}")
for fade in (False, True):
  for L in (500, 200, 100, 50):
    for tp in (0.3, 0.6, 1.0):
      for N in (3, 10):
        for thr in (1.0, 2.0):
          tot = dict(n=0, wins=0, net=0.0, liqs=0)
          for a in ("BTC","ETH"):
              s = run(a, data[a], L, 0.3, tp, N, thr, fade)
              for key in tot: tot[key] += s[key]
          p = tot['n'] or 1
          print(f"{'fade' if fade else 'momo':>6} {L:>4} {tp:>4} {N:>3} {thr:>4} | {tot['n']:>5} {100*tot['wins']/p:>5.0f} {tot['net']/p:>6.2f} {tot['liqs']:>4} | {tot['net']/days:>7.2f}")
  print()

import json, sys
INST = {"BTC": dict(pm=814.598, buf=0.000476), "ETH": dict(pm=483.979, buf=0.000481)}
BASE, RM, REF, FEE, FLOOR, BE = 0.10, 15000, 100000, 0.02, 0.05, 0.01

def payout(move, margin, L, pm):
    """move = favourable fraction (>0 win, <0 loss). Mirrors legValue()."""
    if move <= 0: return max(move * margin * L, -margin)
    m = max(move - 1/50000, 0)
    if m <= 0: return 0.0
    raw = m * margin * L
    scale = (1 - BASE) / (1 + 1/(m*RM) + REF/(1e6*m*pm))
    return raw * scale * (1 - FEE)

def solve_move(target_payout, margin, L, pm):
    lo, hi = 0.0, 0.5
    for _ in range(60):
        mid = (lo+hi)/2
        if payout(mid, margin, L, pm) < target_payout: lo = mid
        else: hi = mid
    return hi

def run(asset, candles, L, stop, target, slip_bps=1.0, margin=10.0, act_filter=0.0):
    pm, buf = INST[asset]["pm"], INST[asset]["buf"]
    pair_m = 2*margin
    d_stop = stop / L                     # losing leg hits -stop% of margin
    d_liq = 1/L - buf*(1 - 1/L)           # hard bust distance
    slip = margin * L * slip_bps/1e4      # $ lost to 1-2s fill delay
    max_hold = int(min(1440, 15*1000/L))  # minutes
    # winner exit levels as favourable move fractions
    mv_floor = solve_move(FLOOR*margin, margin, L, pm)
    stats = dict(pairs=0, wins=0, net=0.0, liqs=0, hold=0)
    i, n = 15, len(candles)
    while i < n-2:
        t0,o,h,l,c = candles[i]
        if act_filter:
            rng = max(x[2] for x in candles[i-15:i]) - min(x[3] for x in candles[i-15:i])
            if rng/o < act_filter*d_stop: i += 1; continue
        E = o
        # ---- phase 1: both legs open
        j, loser, exitidx = i, None, None
        while j < n:
            _,o2,h2,l2,c2 = candles[j]
            long_hit = l2 <= E*(1-d_stop); short_hit = h2 >= E*(1+d_stop)
            if long_hit and short_hit: loser = 'long' if c2 < o2 else 'short'
            elif long_hit: loser = 'long'
            elif short_hit: loser = 'short'
            if loser: break
            if j - i >= max_hold:
                net = payout((c2-E)/E, margin, L, pm) + payout((E-c2)/E, margin, L, pm) - 2*slip
                stats['pairs'] += 1; stats['net'] += net; stats['hold'] += j-i; stats['wins'] += net > 0
                exitidx = j; break
            j += 1
        if exitidx is not None: i = exitidx+1; continue
        if loser is None: break
        # loser settlement
        adverse = (E - candles[j][3])/E if loser=='long' else (candles[j][2]-E)/E
        if adverse >= d_liq: loser_pnl, liq = -margin, 1
        else: loser_pnl, liq = -stop*margin - slip, 0
        sgn = -1 if loser=='long' else 1       # winner is short if loser is long
        # winner exit levels (favourable move fractions)
        mv_cover = solve_move(-loser_pnl, margin, L, pm)
        mv_be = solve_move(BE*pair_m - loser_pnl, margin, L, pm)
        mv_tp = solve_move(target*pair_m - loser_pnl, margin, L, pm)
        covered, k, done = False, j, False
        # rest of the loser's candle: evaluate at its close only
        fav = sgn*(candles[j][4]-E)/E
        if fav >= mv_cover: covered = True
        k = j+1
        while k < n and not done:
            _,o2,h2,l2,c2 = candles[k]
            favx = sgn*((h2 if sgn>0 else l2)-E)/E   # best favourable move in candle
            advx = sgn*((l2 if sgn>0 else h2)-E)/E   # worst
            fav_first = (c2 > o2) == (sgn > 0)
            def adverse_exit():
                if advx <= mv_floor: return payout(mv_floor, margin, L, pm) - slip
                if covered and advx <= mv_be: return payout(mv_be, margin, L, pm) - slip
                return None
            def fav_exit():
                if favx >= mv_tp: return payout(mv_tp, margin, L, pm) - slip
                return None
            w = (fav_exit() or adverse_exit()) if fav_first else (adverse_exit() or fav_exit())
            if w is None and k - i >= max_hold: w = payout(sgn*(c2-E)/E, margin, L, pm) - slip
            if w is not None:
                net = loser_pnl + w
                stats['pairs'] += 1; stats['net'] += net; stats['liqs'] += liq; stats['hold'] += k-i; stats['wins'] += net > 0
                done = True; i = k+1
            else:
                if favx >= mv_cover: covered = True
                k += 1
        if not done: break
    return stats

data = {a: json.load(open(f"{a}_1m.json")) for a in ("BTC","ETH")}
days = (data["BTC"][-1][0]-data["BTC"][0][0])/86400e3
print(f"{days:.1f} days of 1m candles. $10/leg, 1 bp slippage, floor 5%, breakeven 1%\n")
print(f"{'lev':>5} {'stop':>5} {'tgt':>5} {'filt':>4} | {'pairs':>5} {'win%':>5} {'avg$':>6} {'liq':>4} {'hold':>6} | {'$/day':>7}")
for act in (0.0, 2.0):
  for L in (1000, 500, 200, 100, 50, 25):
    for stop in (0.3, 0.5):
      for target in (0.1, 0.2, 0.3):
        tot = dict(pairs=0, wins=0, net=0.0, liqs=0, hold=0)
        for a in ("BTC","ETH"):
            s = run(a, data[a], L, stop, target, act_filter=act)
            for key in tot: tot[key] += s[key]
        p = tot['pairs'] or 1
        print(f"{L:>5} {stop:>5} {target:>5} {('x'+str(act) if act else '-'):>4} | {tot['pairs']:>5} {100*tot['wins']/p:>5.0f} {tot['net']/p:>6.2f} {tot['liqs']:>4} {tot['hold']/p:>5.0f}m | {tot['net']/days:>7.2f}")
  print()

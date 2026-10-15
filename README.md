# papertrade-bot

Hedged-pair bot for [Papertrade](https://papertrade.xyz): 1000× synthetic perps on Hyperliquid (BTC/ETH).
Platform research is in `research/`.

## Strategy

1. Pick BTC or ETH, whichever is moving more right now, weighted by how much of a win the payout haircut lets you keep.
2. Open a long and a short at the same time: $10 margin each at 100× (configurable; 1000× was the original spec).
3. When one leg reaches **−30%** of its margin, close it.
4. Ride the other leg. Each rule closes it when:
   - **Floor:** its own profit falls to +5%, so it never turns into a loss.
   - **Breakeven guard:** the pair had covered the loser's loss, and pair net then falls back to about breakeven.
   - **Take-profit:** the pair is up **+30%** of pair margin (+$6) and price is no longer running.
   - **Trailing:** price kept running past the take-profit level, and then momentum stalls or 30% of the peak profit is given back.
5. Stake any PAPER received (from losses) every 15 minutes, and claim USDC staking rewards hourly.

All thresholds are set in `.env` (see `.env.example`).

## Farm mode (`STRATEGY=farm`)

The one structure the platform's own design pays. Open the same long+short hedge, but hold it (there is no funding, so carrying a hedge is free) and close **both legs in a single intent** once price has moved `FARM_MOVE_BPS` (default 60 bps at 100×). The losing leg mints PAPER on its full loss; the winning leg returns ~85% of that loss, so PAPER costs roughly $0.006–0.008 each instead of the $0.042 of a naked loss. Staked PAPER then earns a share of all trader losses in USDC. The status line shows live cost per PAPER, the current payout yield per PAPER per day, and the implied payback.

```bash
npm run farm            # simulate farming on live prices
npm run farm:live       # real farming (needs .env)
npm run stats -- farm   # cost per PAPER from logs/journal-farm-sim.jsonl
```

This is deliberately losing money to mint; it only pays if staker payouts stay high (they depend on trading volume and on the $5M staker cap, which the team can change). PAPER cannot be transferred or sold; dividends are the only exit.

## Run

```bash
npm install
npm test           # math, signing, strategy scenarios and fault-injection tests
npm run sim        # live Hyperliquid prices, exact Papertrade payout math, no real orders
npm run stats      # success rate from logs/journal-sim.jsonl  (npm run stats -- live)
npm run live       # REAL trading (needs .env)
```

Press Ctrl+C to stop. The bot closes its open positions and stakes PAPER before exiting.

## Going live

1. Create a **fresh wallet** used only for this bot.
2. Connect it at papertrade.xyz and deposit $50 USDC. A one-time $1 activation fee applies, and 10 USDC is the minimum.
3. Copy `.env.example` to `.env` and set `WALLET_PRIVATE_KEY`.
4. Run `npm run live`. On first start the bot signs one session-key registration, which lasts 30 days and is stored in `state/`. All trades are then signed by that session key.

The session key can open and close trades but cannot withdraw funds. Withdrawals are done by you in the papertrade.xyz UI.

## Safety behaviour

- Concurrent pairs go on different assets; the same asset twice is the same bet twice.
- If prices stop arriving for 10 s while legs are open, everything is closed.
- Open intents expire at the relayer after 5 min, so a crashed bot can't get filled later with nobody watching. On start, any positions already open are closed (`ON_START_EXISTING=close`).
- A pair is only finished once every leg that filled has a confirmed settlement. A close that fails is retried every 2 s until it does; repeated open failures back off exponentially.
- If only one leg fills, the other is cancelled after 8 s and the lone leg is closed, so you're never one-sided at 1000× for long.
- Positions that disappear from the live stream (e.g. during a reconnect) are reconciled from trade history, so a liquidation is never missed.
- A crash (uncaught error) closes everything before exiting. On Ctrl+C the bot waits (up to 2 min) until all legs are confirmed closed and prints any it couldn't.
- After losing `MAX_SESSION_LOSS_USD` the bot stops opening new pairs (it still manages open ones).

## Keep the machine awake

A sleeping machine cannot manage a 1000× position. `npm run sim` / `npm run live` wrap the bot in macOS `caffeinate -dims` so the Mac stays awake while it runs, but **closing the lid still sleeps a MacBook** unless it's plugged in and lid-sleep is disabled. The bot logs `process was suspended for Ns` if it detects a gap. For anything beyond a short test, run it on an always-on machine.

## Backtest

`research/backtest/` holds a 1-minute backtest of these rules over Oct 10–13 2026 with the exchange's exact payout math. Every leverage/stop/target combination lost on average (the hedge offsets exactly, and the exchange keeps 15–40% of wins while losses are paid in full). 100× / stop 30% / target 30% was the least-bad: about −$0.23 per pair, no liquidations, ~65% win rate. 1000× lost about $4 per pair with frequent liquidations. Treat the bot as a test harness, not an edge.

## Limits to know

- The minimum margin per position is $10, set by the contract.
- At 1000×, −30% is a 3 bps price move, and liquidation (100% loss) happens at about 5.2 bps.
- Trades fill about 1–2 s after they are sent, at the mid price at that moment. In a fast market a stop can fill worse than −30%, or the leg can be liquidated.
- Losses are taken in full, while wins are reduced by a move-size haircut plus a 2% fee. The simulator applies exactly this.
- Staking requires at least 1,000 PAPER. That needs roughly $40 of losses at the current mint rate.

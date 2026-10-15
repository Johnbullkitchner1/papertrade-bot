# Papertrade: research from outside the docs (as of 2026-10-13)

Legend: **[V]** means I checked it against a primary source (an API response, on-chain data, or the official tweet text). **[S]** means it comes from secondary press (one or more outlets) and was not checked against a primary source. **[U]** means it is unverified or comes from a single weak source.

## 1. Official X account: @papertrade_xyz
- Profile [V] (from api.fxtwitter.com/papertrade_xyz): "trade with up to 1000x leverage and 0 slippage, on the first fair launched fully onchain perpetual exchange / built on hyperliquid". About 45.5k followers and only 63 tweets. The account was created 2022-05-17, so it is an older handle that was repurposed. Website: papertrade.xyz.
- Launch-timing post, 2026-10-10 09:28 UTC [V]: https://x.com/papertrade_xyz/status/2108852108766437759
  - Trading launch at **14:00 UTC 2026-10-10**, after a HyperEVM network upgrade. Deposits paused at 13:45 UTC. Joining the launch required a predeposit.
  - Expected congestion: long confirmation waits, especially for small-notional trades. The frontend relayer controls when transactions are submitted. Staking distributions run separately in big blocks. The relayer deliberately targets about 50% of gas use.
  - OI limits: the **individual atomic position limit is $10M**, and there is no cap on the number of $10M positions. **Floating OI headroom is $1bn per market/side** at launch. (DeFiprime adds: a keeper targets current OI + $1B at BBO and re-sets only when headroom leaves a $900M–$1.1B band.)
  - Asymmetric PnL fee, "inherits Rollbit's curve": baseRate 0.1, rateMultiplier 15000, rateExponent 1, referenceNotional 100000*k (k=1m), positionMultiplier 814.598 (BTC) / 483.979 (ETH), **profit deadman 0.2 bps**, meaning gains on moves under 0.2 bps pay zero.
  - Admins: 2-of-3 multisigs held by **@izebel_eth (Jez), @blurr, @UngusTrade**. There are three roles:
    - guardian: pauses opens and freezes markets. Positions in a frozen market can still close against the paused BBO mid.
    - owner: sets curve and fee parameters, relayers and keepers, lists markets, and upgrades contracts. Upgrades are behind a **7-day timelock**.
    - markets: sets OI headroom and minimum margin and position sizes.
- Post-incident statement, Sunday 2026-10-11 [S] (The Block, ChainCatcher, KuCoin, Bitcoin.com):
  - The team said the BTC and ETH manipulation came from loose launch OI caps that were meant to relieve queue pressure, and was "not an oversight in the mechanism design we spent six months working on".
  - It is **tightening limits on-chain and at the relayer level**. No new values were published.
  - It claimed the attacker returned most of the gains through new accounts, and that some users agreed to reverse manipulated trades in exchange for keeping their PAPER. The Block could not verify this.
  - It defended prioritizing larger orders, saying tiny orders would otherwise flood the relayer.
  - It said the LP is about $5M and about $25M has been paid to stakers.
- Later announcement, **dividend trigger raised from $5M to $10M on 2026-10-17** [U]: this comes only from a KuCoin flash (kucoin.com/news/flash/papertrade-early-stakers-and-arbitrage-strategies-revealed). I did not find an official tweet.
- Earlier history [S] (iq.wiki): a limited beta was announced 2026-05-17. Guardian Audits was engaged in May 2026. The launch video went out on 2026-09-29 and passed 1M views. **No audit report has been published**, and ChainCatcher reported that as of 2026-10-02 there was no public source code.

## 2. Team [S]
- **Jez** (@izebel_eth) is identified by ChainCatcher/TechFlow as **Colin Hong**, formerly at MIT and Morgan Stanley, now a Venture Partner at Standard Crypto, and a former HFT options market maker. **Blurr** is pseudonymous. The two met in New York in 2021. **UngusTrade** is the third multisig signer.
- Jez says the project is just himself and Blurr, and that the frontend was built with AI. The queue idea came from summer 2024 experiments with blackjack and coin-flip games. Funding is undisclosed.
- Whitepaper authors are listed as "Martin Galer" (a pun), "Jez @izebel eth", and "Blurr, Refund Contract Deployer".

## 3. GitHub: https://github.com/Open-Papertrade is NOT papertrade.xyz [V]
- I checked it with the GitHub API. It has 3 repos: `.github`, `Open-Papertrade` (24 stars, last pushed 2026-10-08), and `Open-Papertrade-Web`.
- It is an unrelated **open-source stock paper-trading / AI-coach app** built on Django and Next.js, using Finnhub and Yahoo data, SEC-filings RAG, and the AGPL license. Its docs live at open-papertrade.gitbook.io.
- **It has no Solidity, no Exchange.sol or QueueLib.sol, no SDK, and no EIP-712 types.** It has nothing to do with HyperEVM.
- Papertrade.xyz has **no public repo, verified source, or SDK** that I could find. The site and docs HTML contain no links to GitHub, Discord, or Telegram.
- Phase plan [S] (DeFiprime, Bankless, ChainCatcher):
  - Phase 1: trading only through whitelisted relayers and the official frontend. Users sign intents. **Direct contract interaction is closed.**
  - Later phase: direct contract access for users, bots, and agents, plus builder codes (1% to referrers) and PAPER transfers.
  - Relayer priority order is liquidations, then closes, then opens. Larger trades can jump the queue, and users can cancel queued intents.
  - Minimum deposit is $10 USDC plus a one-time $1 activation fee.
- **Implication for a bot:** for now, a bot would have to drive the official frontend/relayer intent flow. Nobody has published an API or SDK.
- Related third-party repo: https://github.com/iam-rekt/paperdao-xyz
  - **PaperDAO** is a community treasury on daos.world that raised funds around Oct 7 and farms PAPER from the first block. Its **$PULP** token is a pro-rata claim on that treasury, redeemable for PAPER after transfers open.
  - Its README states it is not affiliated with papertrade, and it publishes no contract addresses.
  - Bankless also mentions **PaperStrategy** (the PSTR token, which carries a 10% tax that buys and stakes PAPER) and **DXAP / Superclip**, which runs AI agents.

## 4. Martingaler whitepaper
Saved to `dl/martingaler.pdf` and `dl/wp.txt`. It is a 4-page paper titled "A Bootstrapping Mechanism for Sustainable Asynchronous Speculation Games of Chance".
- **Problem:** onchain casinos need a seeded or incentivized LP, cap bet size to the size of the bankroll, and carry solvency risk. The paper cites the EtherCrash LP drain and Rollbit.
- **Payout queue (FIFO):** when a wager wins and a queue exists, the wager is appended to the back. The protocol then checks the solvency rule and pays the front of the queue if the rule allows. If there is no queue, the win is paid immediately when solvent, otherwise it starts a queue of length 1.
- **Solvency Ratio Invariant:** SR = (treasury + "ETH in queue", meaning the unpaid won input stakes net of tax) / (queue liabilities, meaning the unpaid winnings).
  - SRI = 1.0 means the protocol pays only when fully solvent, so it queues everything until losses refill the treasury.
  - SRI = 0 means it always pays the front of the queue.
  - Suggested form: treasury + queued stake > Σ wagers in the queue. Under this form, queued winners can withdraw their **original stake and forfeit their winnings**, which raises solvency for everyone left in the queue. (The live product refunds margin immediately and queues only the profit [S].)
- **Yield-bearing collateral** raises solvency on its own over time.
- **Token emissions** let a game with a positive house edge present as +EV to players. Emissions decay linearly in the paper, and a wager tax funds buy-and-burn.
  - Emissions can be tied to queue length to attract volume while the protocol is insolvent.
  - The live design replaced buy-and-burn with staking plus a decaying mint [S].
- **Simulations:** 1M iterations each of a fair coin flip (no edge) and a "3/4 chance to win 4/3x" game. The queue absorbs the variance.
- **Argument:** asynchronous games beat synchronous parimutuel games, provided the LP is not a constraint.
- The reference list is mostly unrelated Chitra/Angeris CFMM papers, which looks like filler.
- **Live PAPER mint curve** [S] (ChainCatcher/TechFlow, from the docs): 100 PAPER/$ while tracked LP is below $2M. Above that the marginal rate is 100·(120M/(120M+H))², where H is cumulative LP gains above the threshold. That gives about 50 at H=$50M, 25 at $120M, 10 at $260M, and 1 at $1.08B. The asymptotic supply is about 12B. The mint rate was about 30.8/$ by Oct 12.

## 5. Launch metrics and incidents (all [S] unless marked)
- Pre-deposits: $85.3M (DefiLlama, before launch) rising to about $118–138M from 11k+ addresses.
- DefiLlama, today [V] via api.llama.fi: slug `papertrade`, category Derivatives, **TVL about $61.0M**. The listing shows the chain as "Hyperliquid L1".
- First-day activity:
  - $14.4B notional in the first 10 minutes, and over $300B (some reports say $678B) on day one.
  - KuCoin claims $804B over two days [U].
  - Peak OI was about $10–11B. It fell to about $693M by Oct 11 (−93.7%, Bitcoin.com) and to about $400M by the evening of Oct 12.
  - Margin backing those positions fell from about $20M to about $5–9M.
- Net trader losses were about $18.6M on day 1 and **$32.4M by day 2** (The Defiant).
- Stakers had received about $26.3M by day 2, but **about $23.9M of that arrived in the first 8 hours** and only about $2.4M in the next 37 hours.
- About 94–95% of the roughly 3.17B PAPER supply was staked early on.
- House pool: $3.14M shortly after launch, about $4.3–4.4M on Oct 12 (about $3.5M net of unrealized PnL). **The payout queue was empty.** Net long exposure was about $114M.
- The 2% win fee is split 50/50 between stakers and developers. The developers had collected about $1.77M (ChainCatcher).
- **BBO manipulation exploit, 2026-10-10** (The Block, https://www.theblock.co/news/defi/2026-10-11-trader-nets-1-28-million-on-new-1000x-exchange-papertrade-by-moving-hyperliquids-eth-prices-418239):
  - Wallet **0x2025137a136bea7446deba681cbfc7cf1970840e**, a Hyperliquid trader since February 2025 with about $13.1M in lifetime profit.
  - About 22:01 UTC: bought about 6,060 ETH on Hyperliquid (+0.12%), then sold about 5,210, and withdrew $1.54M from Papertrade.
  - About 23:13 UTC: opened 30 ETH shorts at 660x with about $297M notional, then sold about 6,590 ETH.
  - The price rebounded and the shorts were liquidated with a loss of about $450k, which minted about 17.6M PAPER.
  - Net result: **about +$1.28M on $3.18B of volume**, against only about $52k of Hyperliquid fees. X users Boblob and butler flagged the trades.
  - The docs themselves admit the mid can be moved with a **non-executing limit order inside the spread**.
  - Pool chart: it dipped from about $5M to about $2.4M, then recovered.
- **Wash farming** (opening both sides to mint PAPER): the founders openly acknowledge it, and Blurr suggested using AI to farm.
  - TechFlow simulated cost per 1,000 PAPER before launch: **100x ≈ $2.55 (cheapest)**, adaptive $2.81, 20x $4.38, 1000x $5.06, 3x $17.38.
  - Delphi's tempest and Blockworks' Shaunda Devens flag dilution: launch-era PAPER captured most of the early dividends.
- **Complaints:**
  - Small orders are deprioritized by the relayer.
  - Users are nervous about a 2-of-3 multisig that can pause trading or freeze markets.
  - Stale-price risk during HyperEVM pauses.
  - Critics call it a "new Perp DEX, new Ponzi".
  - The independent "PaperTrade-Simulations" (3.6M HL trades, 608 scenarios, all solvent) excluded manipulation, relayer delays, and bots, and published no integrity hash.
- **Dashboards:** paperdash.xyz (/stats) is a third-party dashboard that reports TVL, PnL, and per-wallet gains. It is a JS app with no public API that I found. I found no Dune dashboard, and no official Discord or Telegram.

## 6. Solana "papertrade.xyz (PAPERTRADE)" mint DfG8ZwbEGAm6jYsPhhDcs86Wxs9jo3MmS7mSdiXyDdiv: unaffiliated copycat [V]
- I checked it on-chain through Solana RPC and the Jupiter token API:
  - Plain SPL token with a **fixed 1,000,000,000 supply**, 6 decimals, and mint and freeze authority revoked.
  - Launched on **Raydium LaunchLab on 2026-09-22**, by dev wallet FWQpX9kRyBoboDGP91CRBmHcv7ZRU4VpeDpVY3Tm8gzE.
  - Jupiter shows holderCount 1, organicScore 0, and the tag "unknown". Dexscreener has no pairs for it.
- Real PAPER contradicts every one of these points. It lives on HyperEVM, starts at zero supply, is minted only on losses, and is **non-transferable at launch**.
- No official channel or press source references this mint. Coinbase, Phantom, and similar price pages for it are auto-listings.
- **Treat it as a scam or copycat.**

## Sources
- https://x.com/papertrade_xyz/status/2108852108766437759 (via api.fxtwitter.com)
- https://x.com/0xTraderSam/status/2054403970169242040 (2026-05-13 explainer thread)
- https://x.com/thenarrator/status/2105086343504175185 (2026-09-30 bull/bear take)
- https://www.theblock.co/news/defi/2026-10-11-trader-nets-1-28-million-on-new-1000x-exchange-papertrade-by-moving-hyperliquids-eth-prices-418239
- https://www.chaincatcher.com/en/article/2295671 , https://www.chaincatcher.com/en/article/2295451
- https://defiprime.com/papertrade-sets-launch-caps-and-profit-haircut
- https://www.bankless.com/read/what-to-know-about-papertrade-s-launch.md
- https://cryptobriefing.com/papertrade-oracle-manipulation-allegation-pool/ , https://cryptobriefing.com/papertrade-traders-lose-staking-rewards/
- https://thedefiant.io/news/defi/papertrade-trader-losses-reach-32-4-million-two-days-after-launch , https://thedefiant.io/news/defi/papertrade-says-it-is-tightening-trading-limits-after-manipulation-allegations
- https://news.bitcoin.com/featured/papertrades-wild-weekend-ends-with-93-7-open-interest-wipeout/
- https://www.kucoin.com/news/flash/papertrade-early-stakers-and-arbitrage-strategies-revealed
- https://iq.wiki/wiki/papertrade
- https://github.com/iam-rekt/paperdao-xyz , https://github.com/Open-Papertrade
- https://api.llama.fi/protocols (slug papertrade) ; https://paperdash.xyz/stats
- Solana RPC getAccountInfo + https://lite-api.jup.ag/tokens/v2/search?query=DfG8Zwb...

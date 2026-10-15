# Papertrade on-chain state (HyperEVM, chain 999)

Snapshot: block **48,424,124**, timestamp 1791886959 (**2026-10-13 10:22:39 UTC**). RPC: https://rpc.hyperliquid.xyz/evm. All calls were read-only.
USD amounts are 1e18-scaled internally (`collateralScale` = 1e12 over 6-decimal USDC; HyperCore USDC uses 8 decimals).

Files in `pt/onchain/`:
- `reconstructed_abi.txt`: the function and event signatures I found
- `selectors.txt`: full selector dump of each implementation
- `brute_out.txt`: the brute-force name matches
- `bytecode/*.hex`: implementation bytecode
- `logs_50k.jsonl`: raw Exchange logs, blocks 48,374,127 to 48,393,323
- `activity_stats.txt`: the activity numbers in section 5
- `fe/`: exchange.papertrade.xyz JS bundles. They contain no contract ABIs; the frontend reads an indexer API.

## 1. Verification and proxies

- **None of the contracts are verified.** Sourcify v2 returns `match:null` for the proxies and implementations. HyperEVMScan shows "Verify and Publish" for every implementation. Routescan says "chain not supported". The Etherscan v2 API needs a key.
- All protocol contracts are EIP-1967 transparent proxies with ProxyAdmin `0xe79c91cc682f1bb401a9cab74c900470190f0f8f`. Implementations:

| Contract | Implementation |
|---|---|
| Exchange | 0x0f3febfc94876b0c895f7acecdc8f5c863b549ee (about 23 KB) |
| BatchExecutor | 0xe0bc9cc7b067060aafccbaa3e250700c9cdd7262 |
| PriceOracle | 0x3997ffc8cbd281d4fc8d0548e505ae2fbbbd985a |
| SessionKeyManager | 0x8a5069fe303e8f81e91825436e956d595032e558 |
| DepositProxyFactory | 0x8f22a73a23a2de0dbfdf6729f4d8c07dbdc69cf0 |
| PaperToken | 0x433bd418ec92818a960585f4d5fae563e735bb4a |
| PaperStaking | 0xe6e3519455170913c5c3bfe541dd918a2d0cbb15 |
| PaperTokenomics | 0x600d1b9653fd47fc1543d1cc87f33ba2d2fdf48f |

- The Exchange owner is the Timelock 0xB915…. The pauseGuardian is the Multisig 0x6962…. The Timelock and Multisig are custom contracts: `getMinDelay` and `getThreshold` revert.
- Roles:

| Role | Address | Notes |
|---|---|---|
| Relayer | 0xc916e55b1909be6582bf1b2f017aaf82ad8eb0b4 | the only submitter seen; about 39.5 HYPE; nonce 400,567 |
| marketKeeper | 0x3721476de31190dc1af8908026abe20efe25cf99 | sets OI caps |
| Liquidator | 0x07626d8137ede6b922bcecf3b67f82a21100a612 | calls `liquidateBatch` at 1.1 gwei |
| Deposit sweeper | 0xdf1bda875c9393a663ce69bf6a7fbaa73dfd053d | |
| devFeeRecipient | 0xeef651e381e04b5ae25393b1367c19bcfd575792 | |

- `authorizedKeeper()` is 0x0.

## 2. Solvency and LP (snapshot block)

| Item | Value |
|---|---|
| Exchange USDC on HyperCore (spotClearinghouseState, token 0) | **$60,857,813.77** (EVM-side USDC balance is 0) |
| `treasury()` | $60,856,462.25 |
| `totalBalances()` (user available balances) | $49,232,396.08 |
| `totalLockedMargin()` | $7,363,950.75 |
| `devFeeAccumulator()` | $3,968.20 |
| **`lpBankrollAvailable()`** | **$4,356,678.45** |
| `queueHarvestAvailable()` | $4,356,653.03 |
| **`totalQueued()`** | **0** |
| **`sideBucket()`** | **0** |
| `queueHead()` | 4. `queueNode(1..3)` hold users with amounts 0, so only 3 queue entries ever existed and all are paid |
| `tradingPaused()` | false |
| `marketPause(0/1)` | all zero (not paused, no frozen BBO) |
| `nextPositionId()` | 441,959 |
| PaperTokenomics `trackedLpUsd()` | **$4,413,101.53** |
| `tailProgressUsd()` | $118,779,521.15. `0xcbb451da` = 120,000,000 (probably the tail target) |
| `flatRate()` | 100. Other params: `0x3886cade` = 2e6, `0xe9ed73e9` = 2e6, `0xc16017ca` = 5e6 (the $5M staker reward cap) |
| Observed mint rate | about **28 PAPER per $1 of loss** at tracked LP ≈ $4.87M. From event 0x620c26bf: loss basis 22.54 → 634.75 PAPER |
| PAPER `totalSupply()` | 6,626,185,216.46 (18 decimals) |
| PaperStaking `totalStaked()` | **6,557,344,455.87 (about 99% of supply)** |
| `rewardReserve()` | $2,401,306.90 |
| `unallocatedRewards()` | 0 |

**Verdict:** the protocol is solvent and nothing is queued. Free LP is about $4.36M, against about $57M of user balances plus locked margin. The queue has essentially never been used.

## 3. Market parameters

`instruments(uint32)` returns `(rateMultiplier, positionMultiplier, assetIndex, maxLeverage, maxPositionNotional, bustBuffer, baseRate, referenceNotional)`.

| Param | BTC (id 0, HL asset 0) | ETH (id 1, HL asset 1) |
|---|---|---|
| rateMultiplier | 15,000 | 15,000 |
| positionMultiplier | 814.598 | 483.979 |
| maxLeverage | 1000 | 1000 |
| maxPositionNotional | $10,000,000 | $10,000,000 |
| bustBuffer | 0.000476 (4.76 bps) | 0.000481 |
| baseRate | 0.10 | 0.10 |
| referenceNotional | $100,000 | $100,000 |
| price scale (raw / scale = USD) | 10 | 100 |
| longOi / shortOi (asset units) | 1838.88 / 1244.82 BTC (≈ $153.5M / $103.9M) | 44,490.6 / 24,124.0 ETH (≈ $111.6M / $60.5M) |
| longCap / shortCap (snapshot) | 1959.83 / 1330.04 BTC | 46,973.1 / 28,080.7 ETH |

- **OI caps are dynamic.** The marketKeeper calls `0x628a9fd6(uint32,uint128,uint128)` about 6 times per minute and emits `MarketOiCapsUpdated`. Over the 5.25 h window:
  - BTC long cap ranged 571 to 2765 and short cap 511 to 2597.
  - ETH long cap ranged 8.2k to 58.9k and short cap 12.0k to 41.2k.
  - Caps sit close to current OI, so headroom is often small: at the snapshot about 121 BTC long and 85 BTC short.
- **Fees:** `winFeeRate`, `lossFeeRate` and `liquidationFeeRate` are each 0.02 (2%). Fees split 50/50 between stakers and dev.
- **Minimums:** `0x1b7c1009` returns (10e18, 1000e18). This is almost certainly minimum margin $10 and minimum open notional $1,000; the smallest margins seen are $10.
- **Other constants:**
  - `maxBatchClose()` = 25
  - `0xff3bc415` = 64
  - `0x6d60ae8e` = 1e9
  - `0xafdf6702` = $62.36, probably accrued staker fees
- **Liquidation level.** At 1000x, bust sits about 5.2 bps adverse to entry: 1/leverage minus bustBuffer. Observed liquidation fills are 0 to 1 bps past bust.

## 4. Pricing

- **BBO precompile 0x…080e** returns `(uint64 bid, uint64 ask)` as raw HL perp prices: BTC raw/10, ETH raw/100. Sample: BTC 834900/834910 ($83,490.0 / $83,491.0); ETH 250790/250800 ($2,507.90 / $2,508.00).
  - Mark precompile 0x0806 returned BTC 834940, ETH 250800.
  - Oracle precompile 0x0807 returned BTC 835336, ETH 250919. The oracle runs about 4 to 5 bps above the BBO.
- **PriceOracle wrapper functions:**
  - `getOraclePrice(uint32)` 0x2af78bd1
  - `getMarkPrice(uint32)` 0xa066fae9
  - mid 0xc0182669
  - bbo 0xfb466481
  - all-in-one 0x766cd255 → (oracle, mark, bid, ask, x)
  - batch 0xa7f06462(uint32[])
- **Fills execute at the BBO mid, not at mark or oracle.** I polled the precompiles live for 40 s and matched the next 50 PositionOpened prices: **48 matched the BBO mid exactly, 0 matched mark, 0 matched oracle, 0 matched bid or ask**, and 2 matched nothing. The 2 misses were probably sampling gaps.
- **Historical eth_call of precompiles is unreliable.** On this RPC, calls with an old block tag return near-current HyperCore values. Fill prices cannot be verified retroactively; doing so produced misleading "mismatches".
- Many fills in consecutive EVM blocks share one price. The mid only updates when HyperCore state advances.
- Close mechanics:
  - Win path: rawPnl, then 0.2 bps deadband, then impact, then a 2% fee on the adjusted gain.
  - Observed adjusted/raw on wins = **0.827**. 1,544 of 24,247 closes paid exactly 0 (deadband or impact).

## 5. Activity

Window: blocks 48,374,127 to 48,393,323, 2026-10-12 20:43 to 2026-10-13 01:58 UTC, **5.25 h**, 0.984 s per block. The scan stopped at about 19k blocks because of RPC rate limits.

**Event counts:**

| Event | Count |
|---|---|
| Opens | 28,353 (**≈5,400/h**) |
| Closes | 24,247 |
| Liquidations | 4,500 |
| Cap updates | 1,945 |
| Deposits | 971 ($3.99M) |
| Withdrawals | 744 ($3.08M) |

**Traders:** 2,129 distinct traders; 1,842 opened at least one position. The top accounts open 300 to 740 times each; these are bots.

**BTC opens: 18,516, 46% long.**

| Quantile | Margin | Leverage | Notional |
|---|---|---|---|
| p10 | $10 | 75x | |
| p25 | $25 | 100x | |
| p50 | $124 | 345x | $41.7k |
| p75 | $597 | 700x | |
| p90 | $2,000 | 1000x | $600k |
| p99 | $15,000 | 1000x | $3.2M |

Total BTC notional opened: $4.54B.

**ETH opens: 9,837, 52% long.** Median margin $205, median leverage 300x, median notional $50k, p99 notional $4.04M. Total ETH notional opened: $2.95B.

**Leverage modes:** 1000x (5,264), 100x (3,807), 500x (2,594), 50x, 200x, 300x.

**Closes:** 11,580 wins, 11,123 losses and 1,544 zero.

| Close metric | Value |
|---|---|
| Sum adjusted wins | +$4.99M (raw $6.03M) |
| Sum losses | −$3.92M |
| Fees | $178k |
| Median win | $17.6 |
| Median loss | −$22.7 |

**Liquidations:** 4,500, wiping about $3.12M of margin. Median margin $50, p90 $1,000. Liquidation margin is derived from the fee fields (2% of margin, split into two 1% fields).

**Net LP result for the window:** about **+$2.0M**, made of +$3.12M from liquidations and −$1.07M from closes. 615 traders were net winners and 1,450 net losers.

**Hold times:**
- Closed positions: median **61 blocks (about 1 min)**, p10 17, p25 25, p90 1,021, p99 4,405. Median winning hold 77 blocks, median losing hold 47.
- Time to liquidation: median 102 blocks, p10 15.

**Queue:** none of the window's closes had the bool set (my reading: "queued"), and no position was opened from queued balance. No winner was queued, so the payout delay is 0.

**Staking flows:** about $120k of staker-fee pushes and $1.37M of StakingRewardCredited in the window.

## 6. BatchExecutor cadence (last 1,000 blocks)

- **1,323 batch txs in 1,000 blocks.** 848 of 1,000 blocks contained at least one batch. The median gap between batch blocks is 1 block (about 1 s) and the maximum is 9.
- Actions per batch: 1 (625 batches), 2 (326), 3 (192), 4 (90), up to 8. All actions succeeded.
- Gas:
  - All batches came from the single relayer 0xc916…, as type-2 txs with priority fee 1 wei.
  - Effective gas price was about **0.100 to 0.107 gwei**, roughly the base fee (0.113 gwei at the snapshot).
  - gasUsed per batch: median about 254k, maximum about 1.01M. One open is about 190k gas, one close about 200k.
  - The small-block gas limit is **3,000,000**, so about 12 to 15 actions fit in one block.
- **Latency.** On-chain inclusion is about every block (~1 s). Submission time is off-chain and not visible on-chain.
  - The frontend schema includes the relayer's own stats (`blockGasLimit`, `totalQueuedGas`, `saturationPct`, `queuedIntents`, `acceptedAtMs`).
  - The relayer also batches several users per tx.
  - The likely end-to-end latency is 1 to 2 s, plus queueing when blocks saturate.
- Liquidations run separately: the liquidator calls `Exchange.liquidateBatch` at 1.1 gwei, so it is priced above traders.

## 7. ABI summary (reconstructed)

See `pt/onchain/reconstructed_abi.txt` for the full list. Key events:
```
PositionOpened(uint256 indexed id, address indexed user, uint32 instrument, bool isLong, bool fromQueue, uint64 price, uint128 margin, uint32 leverage)   0x88451ea1…
PositionClosed(uint256 indexed id, address indexed user, uint64 exitPrice, int256 rawPnl, int256 adjustedPnl, bool, uint256 fee)                         0x87902ed2…
Liquidated(uint256 indexed id, address indexed user, uint64 price, uint64 bustPrice, bool, uint256 stakerFee, uint256 devFee)                           0x0c859bc5…
LiquidationBatchProcessed(uint256,uint256) 0x0bb3f42f… ; MarketOiCapsUpdated(uint32 indexed,uint128,uint128) 0xa065d6ba…
SweepRequested(address indexed,address indexed,uint64,uint64,uint32) 0x02d61879… ; Swept(address indexed,uint256) 0xc36b5179… (deposit credited)
CoreWithdrawal(address indexed,uint256,uint256) 0x95d1a939… ; StakingRewardCredited(address indexed,uint256) 0xe7fd56ed…
```
Positions are read with `positions(uint256)`, which returns (owner, instrument, entryPrice, margin, leverage, openedAt, isLong, ?, fromQueue?). The direction semantics of isLong were confirmed against price moves and PnL sign.

# Papertrade exchange: programmatic interface (reverse-engineered)

Date: 2026-10-13. Frontend build `53591f8c6c22`. Source: the exchange.papertrade.xyz SPA (Vite/TanStack, 119 JS/CSS chunks, **no source maps published**). Checked on-chain over HyperEVM RPC with read-only `eth_call`s and with read-only GETs, an SSE stream and a websocket against the live service. Nothing was POSTed and nothing was signed.

Files:
- Raw bundles: `scratchpad/pt/exchange/assets/` (untrusted, unexecuted)
- Prettified copies: `scratchpad/pt/pretty/`
- Sample responses: `scratchpad/pt/responses/`
- Runtime bytecode: `scratchpad/pt/bytecode/`

Key bundle files:
- `typed-data-MuKdbS29.js`: EIP-712 types and domains
- `deployment-CltCEkj3.js`: deployment config
- `index-DEchBvyk.js`: intents client, streams, REST
- `account-wire-BKjSOoLH.js`: wire decoders for the SSE wallet frame and `/state/trading`
- `valuation-CsZxL1aT.js`: PnL and haircut math
- `trade._coin-CzZzXe10.js`: bust preview and sizing
- `hooks-Bqfld3th.js`: deadline and TTL constants
- `focus-BQEWQrwv.js`: Hyperliquid bbo parsing

> Gotcha: `curl https://exchange.papertrade.xyz/` returns `404 Not found` unless you send `Accept: text/html`.

---

## 0. Deployment constants (from `deployment-CltCEkj3.js`)

```js
{
  environmentId: "production", chainId: 999, genesisMs: 1791326520000,
  network: { rpcUrl: "https://rpc.hyperliquid.xyz/evm", infoApiUrl: "https://api.hyperliquid.xyz/info",
             wsApiUrl: "wss://api.hyperliquid.xyz/ws", signingEnvironment: "Mainnet" },
  governance: { multisig: "0x696292762fd5ac3677a45edbe54eaece4194d1f6",
                timelock: "0xb915fa41e824d6aa31bb833ee81220c0f2c8ea0f" },   // = Exchange.owner()
  contracts: {
    exchange:            "0x6cd5661646289fb6e65ea5c032310fded797d0a2",
    paper:               "0xe40f17915daa230324030003a197cdaef2261c0e",  // PAPER token (symbol "PAPER")
    paperStaking:        "0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016",
    depositProxyFactory: "0x1629b7d46bef6e13ff754174fc9f32dea309b38f",
  },
  collateral: { address: "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24", evmDecimals: 6 }, // token() = USDC 0xb88339CB7199b77E23DB6E890353E22632Ba630f
  instruments: [ { id: 0, name: "BTC", assetIndex: 0, priceScale: 10 },
                 { id: 1, name: "ETH", assetIndex: 1, priceScale: 100 } ],
}
collateralScale = 10n ** (18n - 6n)  // 1e12; matches Exchange.collateralScale()
```

On-chain addresses (EIP-1967 implementation slots, read by me):

| Contract | Proxy | Impl | Notes |
|---|---|---|---|
| Exchange | 0x6cd5…d0a2 | 0x0f3febfc94876b0c895f7acecdc8f5c863b549ee | owner = timelock, `authorizedExecutor()` = BatchExecutor, `oracle()` = 0xa9B4c7b7Ca5835652d81E25739c870D49F39cC2e |
| BatchExecutor | 0x233F…626E | 0xe0bc9cc7b067060aafccbaa3e250700c9cdd7262 | `exchange()` = Exchange, `authorizedRelayers(addr)` |
| SessionKeyManager | 0x8326…B108 | 0x8a5069fe303e8f81e91825436e956d595032e558 | `authorizedCaller()` = Exchange |
| PaperStaking | 0xaad6…f016 | 0xe6e3519455170913c5c3bfe541dd918a2d0cbb15 | |
| PriceOracle | 0xa9B4…cC2e | 0x3997ffc8cbd281d4fc8d0548e505ae2fbbbd985a | `getMarkPrice(uint32)`, `getOraclePrice(uint32)` |

None of these contracts is verified on Sourcify.

---

## 1. Hosts, REST endpoints and streams

### Origins (from `<meta>` tags in the HTML)

| Meta | Value | Use |
|---|---|---|
| papertrade-exchange-origin | https://exchange.papertrade.xyz | **All REST endpoints and intents are same-origin here** (nginx behind Cloudflare) |
| papertrade-stream-origin | https://stream.papertrade.xyz | Centrifugo websocket `wss://stream.papertrade.xyz/connection/websocket` |
| papertrade-sign-origin | https://sign.papertrade.xyz | iframe `/signer.html` for the "legacy signer", which stores and restores session keys and does phone pairing |
| papertrade-preview-origin | https://preview.papertrade.xyz | share-card previews |

Third-party services the app calls:
- Hyperliquid info and ws, for prices
- Across (`https://app.across.to/api`): `/suggested-fees`, `/deposit/status`
- Circle Iris, for CCTP
- Public RPCs for Ethereum, Arbitrum, Solana and Robinhood Chain (`rpc.mainnet.chain.robinhood.com`; USDG deposits from Robinhood Chain go through Across)

### Auth, headers and limits

- **No API key and no auth header.** Writes are authenticated only by EIP-712 signatures inside the body.
- The intents client sends:
  - `Accept: application/json`
  - `Content-Type: application/json`
  - `X-Papertrade-Build: 53591f8c6c22`
  - `credentials: same-origin` (`include` for registration)
  - `redirect: error`
- I could not tell from the client code whether the server enforces the build header. Send it anyway.
- GET responses carry `access-control-allow-origin: *` and an `etag`. `/state/trading` is Cloudflare-cached (`cf-cache-status: HIT`).
- **Rate limits:** the server answers HTTP 429 or `{code:"rate_limited"}`, with an optional `Retry-After` that the client honours. There were no published limits or rate-limit headers on the GETs I made.
- The read client retries only on 408, 429, 5xx and network errors, at most twice.
- Timeouts:
  - GET: 10 s
  - `/state/trading`: 5 s
  - POST `/intents`: 35 s
  - `registerSessionKey` POST: 5 s
- Observed GET latency from Amsterdam: about 0.5–0.8 s.

### Write endpoints (POST, not exercised)

| Method / path | Body | Response |
|---|---|---|
| `POST /intents` | `{ action, signed, ...extra }` (see §2.4) | `{ intentId: 0x…64 lowercase, action, state, queueRevision: "<uint>" }` |
| `POST /intents/{intentId}/cancel` | signed `CancelIntent` fields minus `intentId`: `{user, deadline, v, r, s}` | `{ intentId, action, state }` |
| `POST /intents/{intentId}/onward` | `{nonce, maximumFee, createRecipient, signature:{v,r,s}}` | re-signs the onward bridge leg of a withdrawal |
| `POST /funding/deposits/check` | `{ user: "0x…" }` | `{ proxy: "0x…" }` (deposit-address registration or lookup; **creates state, not called**) |
| `POST /query/leaderboard/name` | leaderboard nickname | not analysed |
| `navigator.sendBeacon('/telemetry', …)` | client errors and `intent-timing` | — |

Valid `action` values:
- `registerSessionKey`
- `openPosition`
- `closePositions`
- `withdrawToCore`
- `paperStake`
- `paperUnstake`
- `paperClaim`
- `paperDistribute` (and `registerDeposit` in the intake pause list)

Intent states: `queued | prepared | confirmed | failed | reverted | expired | cancelled`. A wallet's operations end in one of: `succeeded | failed | expired | cancelled | unknown`.

Error codes (`code` field):
- `invalid_intent`
- `deadline_expired`
- `unauthorized_intent`
- `intent_conflict`
- `admission_rejected` (with `reason`, see below)
- `below_minimum_paper_stake` (with `minimumPaperStakeRaw`)
- `below_minimum_withdrawal` (minimum withdrawal is 10 USDC)
- `invalid_onward` (reason `signature | nonceWindow | mismatch`)
- `intake_action_paused`
- `rate_limited`
- `intent_not_found`

`admission_rejected` reasons:
- `tradingPaused`
- `marketPaused`
- `inactiveInstrument`
- `belowMinimum`
- `belowMinimumNotional`
- `leverageTooHigh`
- `positionTooLarge`
- `openInterest`
- `funding`
- `noOpenPositions`
- `paperBalance`
- `stakedBalance`
- `sessionKeyLimit` (**there is a per-wallet cap on session keys**)
- `noDeposit`
- `noRewards`
- `alreadyQueued`

### Read endpoints

All are GET on `https://exchange.papertrade.xyz`. I tested every one marked ✓, and samples are in `responses/`.

| Path | Notes |
|---|---|
| ✓ `/state/trading` | Market config and live OI. Frontend polls it every 1 s, and it is also pushed on WS `trading:current`. Format in §3. |
| ✓ `/relayer/health` | `{"service":"relayer-intake","databaseReady":true,"pricesReady":true,"ok":true,"ready":true}` |
| ✓ `/ready`, `/query/ready` | `{"status":"ready"}` |
| ✓ `/state/user/live?wallet=0x…` | **SSE** per-wallet state stream (see below). Public: any wallet can be watched. |
| ✓ `/queue-rank/accounts/{addr}` | `{ok, queueRevision:"633", entries:[{intentId, position}]}`: your intents' position in the relayer queue |
| ✓ `/query/accounts/{addr}/trades?limit=75[&cursor=][&filter=]` | Closed trades: `timestampMs, txHash, positionId, instrumentId, symbol, assetIndex, priceScaleRaw, isLong, entryPriceRaw, exitPriceRaw, marginRaw, leverage, kind(PositionClosed/Liquidated), openedAtMs, adjustedPnlRaw, userPaidFeeRaw, paperMintedRaw, paperMintBasisRaw, paperMintBatchTotalRaw`. **`limit` must be exactly 75 or you get a 400.** |
| ✓ `/query/accounts/{addr}/cashflows?limit=75` | Deposits and withdrawals (`route`, `withdrawalStatus`) |
| ✓ `/query/accounts/{addr}/staking?limit=75` | staked, unstaked and claimed |
| ✓ `/query/accounts/{addr}/queue?limit=75` | enqueued, harvested and debt_consumed |
| ✓ `/query/accounts/{addr}/queue-balances?limit=75` | FIFO payout-queue entries |
| ✓ `/query/accounts/{addr}/queue-ring` | queue placement |
| ✓ `/query/accounts/{addr}/funding` | Withdrawal and bridge records: `{items:[{id, route, destination, amount(6dp), status, createdAtMs, exchangeTxHash, burnTxHash, onward}], coreAccount}` |
| ✓ `/query/accounts/{addr}/portfolio-history?range=1h\|1d\|1w\|all` | equity and pnl columns |
| ✓ `/query/accounts/{addr}/leaderboard-badges` | |
| ✓ `/query/protocol/summary` | TVL, margin, LP, fees and PAPER tokenomics |
| ✓ `/query/protocol/market-stats` | `{markets:{"0":{volume_24h}, "1":{…}}}` |
| ✓ `/query/protocol/queue-summary` | |
| ✓ `/query/protocol/trades/recent` | Last 50 fills across all users (same shape as WS `public:trades`) |
| ✓ `/query/protocol/history?interval=1h\|1d\|1w\|all` | |
| ✓ `/query/protocol/paper/activity` | |
| ✓ `/query/notices` | `{"notices":[]}` |
| ✓ `/query/markets/{id}/price-history?fromMs&intervalMs&toMs` | Papertrade's own price history. Allowed intervals are 125 / 1000 / 60000 ms, and the window must align to a 60 s / 15 min / 6 h tile. |
| ✓ `/query/markets/{id}/liquidation-map?range=0.1\|0.25\|0.5\|1\|2\|5\|10\|25` | 150 buckets of `[longNotional, shortNotional, longCount, shortCount]` |
| ✓ `/state/house/current`, `/state/house/delta?coin=BTC`, `/state/house/history?interval=1s` (large), `/query/house/history?interval=1h`, `/query/house/staker-payouts?interval=1d` | House (LP) PnL |
| ✓ `/state/protocol/position-topology` | |
| ✓ `/state/leaderboard/accounts?window&sortKey&sortDir&page&pageSize=25[&q]` | |
| ✓ `/state/leaderboard/accounts/{addr}?window=…` | |
| ✓ `/state/leaderboard/positions?window=all` | `window` is required, otherwise nginx returns 400 |

### SSE: `/state/user/live?wallet=0x…`

The stream uses `EventSource(withCredentials)`. Events:
- `liveness`: `{"heartbeatIntervalMs":10000}`
- `heartbeat`: `null`
- `wallet`: a full frame, or a patch when the frame has `baseAccountRevision`

The client times out after 45 s of silence (or 3× the heartbeat interval).

Full frame:

```jsonc
{ "address","accountRevision","indexedThroughBlock","walletRevision","indexedThroughTimestamp",
  "sessionKeys":[["0xkey","expiryUnixSec"],…],            // sorted by key
  "queueRevision":"633","balance":"<1e18>","queued":"<1e18>","locked":"<1e18>",
  "funds":{"reservedBalance","reservedQueued","availableBalance","availableQueued"},
  "queueNodeCount", "consumableDebt",
  "paper":{"balance","staked","pendingBase","rewardDebt"},
  "lifetime":{"depositedRaw","withdrawnRaw","realizedPnlRaw","feesPaidRaw","tradedNotionalRaw","paperRewardsClaimedRaw"},
  "operations":[[intentId, action, instrumentId|null, isLong|null, useDebt|null, amount|null, leverage|null, acceptedAtMs, deadline, closeIds|null]],
  "openPositions":[[positionId, instrumentId, isLong, useDebt, entryPriceRaw, marginRaw, leverage, bustPriceRaw, openedAtMs, intentId|null]] }
```

Real example position: `["439249",0,true,false,"834615","5000000000000000000000",333,"832505",1791884841000,"0x…"]`. That is BTC long, entry $83,461.5, $5,000 margin, 333x, bust $83,250.5.

A patch frame has these fields:
- `address`
- `accountRevision`
- `baseAccountRevision`
- `state` (partial)
- `lifetime`
- `closedPositions`: `[[id, inst, isLong, margin, lev, liquidated, netPnl, paperMinted]]`
- `intentOutcomes`: `[[intentId, outcome]]`
- `addedPositions`
- `removedPositionIds`
- `addedOperations`
- `removedOperationIds`

For `withdrawToCore` operations, `amount` is in 6-decimal USDC units. The frontend multiplies it by 1e12.

### Centrifugo websocket: `wss://stream.papertrade.xyz/connection/websocket`

Centrifugo 6.9.4 OSS speaks the JSON protocol. Connections are anonymous and need no token.

```
→ {"id":1,"connect":{}}
→ {"id":2,"subscribe":{"channel":"public:trades"}}
→ {"id":3,"subscribe":{"channel":"trading:current"}}       // same payload as GET /state/trading
→ {"id":4,"subscribe":{"channel":"pressure:current"}}      // client uses delta:"fossil"; recoverable
← {"push":{"channel":"public:trades","pub":{"data":[{seq,ts,wallet,instrument,instrumentId,instrumentTerminal,side,leverage,notionalUsd,entry,exit,intentId,positionId,kind:"open|close|liq",pnlUsd}]}}}
← {"push":{"channel":"pressure:current","pub":{"data":{"queueRevision":"<uuid>:519810","snapshot":{schemaVersion:1,ok,stale,ts,source:"relayer-postgres",
     blockGasLimit:"3000000",totalQueuedGas,totalSubmittedGas,totalPendingGas,saturationPct,pendingCount,activeIntents,submittedIntents,queuedIntents,
     chain:{latestBlock:{number,timestampMs,gasUsed,gasLimit,usagePct}}, queuePreview:[{intentId,action,priorityClass,estimatedGas,acceptedAtMs}] /*≤10*/}}}}}
```

Pressure snapshots arrive about every 0.5 s. A snapshot is stale once it is more than 5 s old.

**Latency hint:** the relayer packs intents into HyperEVM **small blocks with a 3,000,000 gas limit**. Estimated gas is about 335k for an open and about 285k for a close, so roughly 9 operations fit per block. In my sample there were 15–20 intents queued at any moment, and `saturationPct` ranged from 0 to 40%.

### Prices

There is no Papertrade price websocket. The frontend uses **Hyperliquid's** `wss://api.hyperliquid.xyz/ws`:

```
{"method":"subscribe","subscription":{"type":"bbo","coin":"BTC"}}
```

It also subscribes to `candle` with an `interval`. The display price is computed as follows:
- `midpointRaw = (bidRaw + askRaw)/2`, where `xRaw = px * priceScale`, which must be an exact integer.
- `price` is the size-weighted micro-price.

On-chain, `PriceOracle.getMarkPrice(id)` / `getOraclePrice(id)` return HyperCore mark/oracle prices × priceScale. For example, I read BTC mark = 834309, i.e. $83,430.9, which matched HL allMids.

---

## 2. EIP-712 signing

### 2.1 Domains (`typed-data-MuKdbS29.js`, verified on-chain)

```js
const DOMAINS = {
  exchange:     { name: "String",                   version: "1", chainId: 999, verifyingContract: "0x6cd5661646289fb6e65ea5c032310fded797d0a2" },
  paperStaking: { name: "PaperStaking",             version: "1", chainId: 999, verifyingContract: "0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016" },
  cancellation: { name: "PaperTrade Intent Cancel", version: "2", chainId: 999, verifyingContract: "0x6cd5661646289fb6e65ea5c032310fded797d0a2" },
};
```

**The Exchange domain's name really is the literal string `"String"`.** I checked this on-chain three ways:
- `SessionKeyManager.DOMAIN_SEPARATOR()` = `0x53a2ab5a…7e77`, which is exactly `keccak(EIP712Domain typehash, keccak("String"), keccak("1"), 999, Exchange)`. Note that the `verifyingContract` is the **Exchange**, not the SKM.
- `PaperStaking.DOMAIN_SEPARATOR()` = `0x71706d56…7eb0`, which matches `PaperStaking/1/999/staking`.
- The SKM implementation bytecode contains `keccak("String")`, and its `initialize(address,string,string,uint256,address)` takes the name as a parameter. This looks like a deploy-script slip that is now permanent.

The cancellation domain is checked only by the relayer, off-chain. Its typehash is not in any of the contracts' bytecode.

### 2.2 Types (exact, from the bundle)

The OpenPosition, Close, RegisterSessionKey and WithdrawToCore typehashes and the EIP712Domain typehash all appear in the Exchange impl bytecode.

```js
const TYPES = {
  RegisterSessionKey: [ {name:"user",type:"address"}, {name:"key",type:"address"}, {name:"expiry",type:"uint64"},
                        {name:"feeAddress",type:"address"}, {name:"nonce",type:"uint256"}, {name:"deadline",type:"uint64"} ],
  OpenPosition:       [ {name:"user",type:"address"}, {name:"instrumentId",type:"uint32"}, {name:"isLong",type:"bool"},
                        {name:"size",type:"uint128"}, {name:"leverage",type:"uint32"}, {name:"useDebt",type:"bool"},
                        {name:"nonce",type:"uint256"}, {name:"deadline",type:"uint64"} ],
  Close:              [ {name:"user",type:"address"}, {name:"positionIds",type:"uint256[]"},
                        {name:"nonce",type:"uint256"}, {name:"deadline",type:"uint64"} ],
  WithdrawToCore:     [ {name:"user",type:"address"}, {name:"amount",type:"uint256"}, {name:"nonce",type:"uint256"}, {name:"deadline",type:"uint64"} ],
  Stake:              [ {name:"user",type:"address"}, {name:"amount",type:"uint256"}, {name:"nonce",type:"uint256"}, {name:"deadline",type:"uint64"} ],
  Unstake:            [ {name:"user",type:"address"}, {name:"amount",type:"uint256"}, {name:"nonce",type:"uint256"}, {name:"deadline",type:"uint64"} ],
  Claim:              [ {name:"user",type:"address"}, {name:"nonce",type:"uint256"}, {name:"deadline",type:"uint64"} ],
  Distribute:         [ {name:"user",type:"address"}, {name:"nonce",type:"uint256"}, {name:"deadline",type:"uint64"} ],
  CancelIntent:       [ {name:"user",type:"address"}, {name:"intentId",type:"bytes32"}, {name:"deadline",type:"uint256"} ],
};
// Each signature uses only ONE primary type: types = { [primaryType]: TYPES[primaryType] } (+ EIP712Domain)
```

### 2.3 Who signs what

| Action | Primary type | Domain | Signer |
|---|---|---|---|
| registerSessionKey | RegisterSessionKey | exchange | **main wallet** (the relayer checks that the recovered signer equals `user`) |
| openPosition | OpenPosition | exchange | **session key** |
| closePositions | Close | exchange | **session key** (1–12 distinct ids per intent; the UI chunks larger closes) |
| withdrawToCore | WithdrawToCore | exchange | **main wallet** |
| paperStake / paperUnstake / paperClaim | Stake / Unstake / Claim | paperStaking | **main wallet** |
| cancel | CancelIntent | cancellation | **session key** (only `openPosition` and `closePositions` are cancellable, plus stake/unstake per UI metadata) |

### 2.4 Field semantics, encoding and the `/intents` body

**`user`** is the main wallet address, lowercase.

**`deadline`** is `floor(now_ms/1000) + 3600`, i.e. a 1-hour validity. It is a uint64 Unix timestamp in seconds. The frontend treats an unconfirmed intent as dead once `indexedThroughTimestamp > deadline`.

**`expiry`** (session key) is `floor((now + 30 days)/1000)` (TTL `2592e6` ms). Details:
- A key is treated as usable only if its expiry is more than 3660 s ahead, taken as `min(on-chain expiry, local expiry)`.
- On-chain lookup is `SessionKeyManager.sessionKeys(user,key) → uint256 expiry`. For example, I read 1794235019.
- The live SSE frame also lists `sessionKeys`.

**`feeAddress`** is `0x0000000000000000000000000000000000000000` (the frontend constant `Sc`).

**`nonce`** is an unordered random nonce, not a counter:
- The client picks `random24bit * 256` on first use, then increments it.
- It persists the value in localStorage under `papertrade.clientNonce.v1:999:<verifyingContract>:<session|paper>:<user>`.
- On-chain replay protection is `isNonceUsed(address,uint256)`, which exists on both the SKM and PaperStaking. Any fresh uint256 works.

**`size`** (OpenPosition) is the **margin**, not the notional. It is USD with 18 decimals: `parseUnits(margin, 18)`. Notional is `size × leverage`.

**`leverage`** is a plain integer, uint32, with `1 ≤ lev ≤ maxLeverage`. `maxLeverage` is currently 1000 for both BTC and ETH.

**`useDebt`**: `true` funds the margin from the user's *queued* balance (FIFO payout-queue IOUs) instead of the cash balance. This is capped by `consumableDebt` (about the 50 most recent queue entries).

**`amount`**:
- WithdrawToCore: in **USDC 6-decimals**.
- Stake / Unstake: PAPER with 18 decimals.

**Signature normalisation (`Fy`)**:
- uint values become decimal strings.
- address and bytes values become lowercase hex.
- bools stay JSON booleans.
- `uint256[]` becomes an array of decimal strings.
- Append `v: "27"|"28"` (string), plus `r` and `s` as lowercase 0x-hex.

```jsonc
POST /intents
{ "action": "openPosition",
  "signed": { "user":"0x…", "instrumentId":0, "isLong":true, "size":"100000000000000000000", "leverage":50,
              "useDebt":false, "nonce":"1234567", "deadline":"1791890000", "v":"28", "r":"0x…", "s":"0x…" } }

POST /intents   // withdrawals add:
{ "action":"withdrawToCore", "signed":{…}, "withdrawal": { "route":"hypercore|hyperevm|ethereum|arbitrum|solana",
                                                          "destination":"…" /*omitted for hypercore/hyperevm*/,
                                                          "onward": {nonce,maximumFee,createRecipient,signature} /*non-hypercore*/ } }
```

**`intentId`** is computed client-side and must equal the server's value:

```js
digest   = hashTypedData({domain, types:{[T]:TYPES[T]}, primaryType:T, message})
signer   = recoverAddress(digest, sig).toLowerCase()
intentId = keccak256( concat([ keccak256(utf8("papertrade:intent-id:v2")), digest, signer /*20 bytes*/ ]) )
```

**Session key custody.** The session key is a plain secp256k1 private key:
- Browser storage is localStorage `papertrade.tradingKey.v1:999:<exchange>:<master>`, as `{privateKey, expiresAtMs}`.
- It can optionally be mirrored or wrapped through the sign.papertrade.xyz iframe.
- For a bot, generate any key and register it with a wallet-signed `RegisterSessionKey`.
- There is a `sessionKeyLimit` per wallet. The sample whale has 8 live keys. `revokeSessionKey(address)` exists on the SKM.

---

## 3. Instruments, units and limits

### `/state/trading` (decoder in `account-wire-BKjSOoLH.js`)

```jsonc
{ "schemaVersion":1, "indexedThroughBlock":48423986, "tradingPaused":false,
  "minimumTradeSizeRaw":"10000000000000000000",        // min MARGIN = $10
  "minimumOpenNotionalRaw":"1000000000000000000000",   // min margin*leverage = $1,000
  "accRewardPerShareRaw":"…",
  "instruments":[ [ id, symbol, assetIndex, priceScale, active, paused, retired, closeOnly, terminal,
                    frozenBidRaw|null, frozenAskRaw|null, pausedAtMs|null,
                    rateMultiplierRaw, positionMultiplierRaw, maxLeverage, maxPositionNotionalRaw,
                    bustBufferRaw, baseRateRaw, referenceNotionalRaw, longOiRaw, shortOiRaw, longCapRaw, shortCapRaw ] ],
  "intake":[ revision, minimumPaperStakeRaw, maximumNetOpenInterestRaw, [pausedActions…] ] }
```

Live values, 2026-10-13:

| Field | BTC (id 0) | ETH (id 1) |
|---|---|---|
| priceScale | 10 ($0.1 tick) | 100 ($0.01 tick) |
| rateMultiplier | 15000e18 | 15000e18 |
| positionMultiplier | 814.598e18 | 483.979e18 |
| maxLeverage | 1000 | 1000 |
| maxPositionNotional | $10,000,000 | $10,000,000 |
| bustBuffer | 4.7604e-4 (0.0476 %) | 4.8130e-4 |
| baseRate | 0.1 (10 %) | 0.1 |
| referenceNotional | $100,000 | $100,000 |
| long/short OI | $1.84M / $1.12M | $34.9M / $27.6M |
| long/short cap | $1.96M / $1.24M | $39.0M / $31.5M |

Intake: `minimumPaperStakeRaw` is 1000 PAPER, `maximumNetOpenInterestRaw` is $60M, and no actions are paused.

Units:
- **All USD amounts are 18-decimal internally**: margin, balances, PnL, fees and notional.
- USDC on-chain is 6-decimal (`collateralScale` = 1e12).
- **Prices are integers equal to USD × priceScale** (uint64 in the contract).
- Leverage is a plain uint32.

### Exchange-side checks (frontend pre-checks that mirror the relayer's admission reasons)

- margin ≥ `minimumTradeSizeRaw` and margin < 2^128
- margin × leverage ≥ `minimumOpenNotionalRaw`
- margin × leverage ≤ `maxPositionNotionalRaw`
- leverage ≤ `maxLeverage`
- OI cap headroom: `(cap − sideOI)` and `maximumNetOpenInterest × priceScale / mark` give the maximum margin = headroom / lev
- available balance ≥ margin, where available = balance − reservedBalance − margin of pending opens

Fees:
- `Exchange.winFeeRate()` is **2 % of positive PnL**, deducted at payout.
- `liquidationFeeRate()` is 2e16.
- `setFeeRates(uint256,uint256,uint256)` exists. Per-trade `userPaidFeeRaw` appears in the trade history.

---

## 4. Valuation math used by the frontend

### Bust price (preview, `trade._coin`, function `Jn`)

The value matches live positions exactly. For example, entry 834615 at 333x gives bust 832505.

```js
// all bigint; entry in price units; buffer = bustBufferRaw (1e18-scaled)
function bustPrice(entry, lev, isLong, buffer) {
  const d = entry / BigInt(lev);
  const a = isLong ? entry - d : entry + d;
  return isLong ? a + (a * buffer) / 10n**18n : a - (a * buffer) / 10n**18n;
}
```

The position is liquidated when mark ≤ bust (long) or mark ≥ bust (short). It is a **hard bust**: the full isolated margin is lost. Keepers call `liquidate(uint256)` or `liquidateBatch(uint256[])`. There is no funding rate.

### PnL with impact haircut (`valuation-CsZxL1aT.js`)

The haircut is a function of the instrument tuple and the size of the move only.

```js
const E = 10n**18n;
function pnl(pos /*entryPriceRaw, marginRaw, leverage, isLong*/, mark, inst) {
  const i = pos.entryPriceRaw, s = i / 50000n;            // 2 bp dead-band around entry
  let c = mark;
  if (pos.isLong) { if (mark > i + s) c = mark - s; else if (mark > i) c = i; }
  else            { if (mark + s < i) c = mark + s; else if (mark < i) c = i; }
  const l = pos.isLong ? c - i : i - c;
  const raw = pos.marginRaw * BigInt(pos.leverage) * l / i;              // 18-dp USD
  if (raw <= 0n) return { raw, adjusted: raw < -pos.marginRaw ? -pos.marginRaw : raw };
  const d = (abs(l) * E) / i;                                            // |move| fraction, 1e18
  const f = d * inst.rateMultiplierRaw / E;
  const p = 1000000n * d * inst.positionMultiplierRaw / E;
  if (f === 0n || p === 0n) return { raw, adjusted: 0n };
  const m = E*E / f, h = inst.referenceNotionalRaw * E / p;
  if (m > E*E || h > E*E) return { raw, adjusted: 0n };
  const g = (E - inst.baseRateRaw) * E / (E + m + h);                    // profit multiplier
  return { raw, adjusted: raw * g / E };
}
// payout = adjusted > 0 ? adjusted - adjusted*winFeeRate/1e18 : adjusted
```

Interpreted as fractions, profits are multiplied by `(1 − baseRate) / (1 + 1/(rateMult·d) + ref/(1e6·posMult·d))`.

At current BTC parameters:

| Move d | Profit kept (before the 2 % win fee) |
|---|---|
| 0.1 % | about 75 % |
| 1 % | about 88 % |
| Asymptote | 90 % |

The win fee comes on top. **Small scalps are punished heavily.**

### Mark used for display and valuation

- Display: the HL bbo midpoint × priceScale.
- Terminal markets: `(frozenBid + frozenAsk) / 2`.
- Fills happen on-chain at the oracle price when the relayer batch executes, typically a few seconds after signing. They are not filled at the price you saw.
- Risk % = `(entry − mark)/(entry − bust)` for longs.

### Equity

`totalEquity = availableBalance + availableQueued + lockedMargin(+reserved) + Σ adjustedPnl`

---

## 5. ABI fragments

### In the bundle

The frontend reads almost nothing on-chain. It relies on the indexer and SSE.

```
Exchange:            function winFeeRate() view returns (uint256)
DepositProxyFactory: function computeProxyAddress(address user) view returns (address)
Collateral wrapper:  function token() view returns (address)
ERC20:               allowance/approve/balanceOf/decimals/symbol/transfer; event Transfer(address indexed,address indexed,uint256)
CCTP/Hyperliquid:    function depositFor(address recipient,uint256 amount,uint32 destinationDex)
                     function calculateCrossChainWithdrawalFee(bool shouldForward,uint32 destinationDomain) view returns (uint256)
Robinhood/Across:    makeCallWithBalance(address,bytes,uint256,(address,uint256)[])
```

There are also Hyperliquid L1 action types for funding: `HyperliquidTransaction:SendAsset`, `:SendToEvmWithData`, `:SpotSend` and `:UsdClassTransfer`, with domain `HyperliquidSignTransaction` v1 and verifyingContract 0x0.

### From deployed bytecode

The contracts are unverified. I extracted selectors from the bytecode and resolved them with openchain, so `?` means unknown.

**Exchange** (98 selectors). The useful ones:

```
balances(address)            getUserOpenPositionIds(address) → uint256[]   positions(uint256)   positionOwner(uint256)
nextPositionId()             instrumentCount()             tradingPaused()     totalBalances()   totalLockedMargin()   totalQueued()
queueHead()  queueNode(uint256)  userQueueHead(address)    harvest(uint256)    sideBucket()
close(uint256[])             liquidate(uint256)            liquidateBatch(uint256[])
winFeeRate()  liquidationFeeRate()  setFeeRates(uint256,uint256,uint256)   collateralScale()
oracle()  sessionKeyManager()  authorizedExecutor()  authorizedKeeper()  proxyFactory()  paperTokenomics()  treasury()  owner()
pauseMarket(uint32) unpauseMarket(uint32) setTradingPaused(bool) creditStakingReward(address,uint256) sweep/requestSweep(address)
```

`positions(id)` returns 9 words: `(owner, instrumentId, entryPrice, margin, leverage, openedAtSec, isLong, useDebt, active?)`.

**BatchExecutor:**

```
exchange()  sessionKeyManager()  authorizedRelayers(address)  setAuthorizedRelayer(address,bool)  owner()
```

It also has 5 unknown selectors, which are the batch entry points.

**SessionKeyManager:**

```
DOMAIN_SEPARATOR() domainSeparatorV4() OPEN_POSITION_TYPEHASH() CLOSE_TYPEHASH()
sessionKeys(address user,address key) → expiry   isNonceUsed(address,uint256)   nonces(address)
revokeSessionKey(address)   recoverSigner(bytes32,uint8,bytes32,bytes32)
authorizedCaller() authorizedSubmitters(address) setAuthorizedSubmitter(address,bool)
initialize(address,string,string,uint256,address)
```

**PaperStaking:**

```
stake(uint256) unstake(uint256) claim() distribute()
stakedBalance(address) pendingReward(address) pendingRewards(address) rewardDebt(address)
totalStaked() accRewardPerShare() rewardReserve() unallocatedRewards()
STAKE_TYPEHASH() UNSTAKE_TYPEHASH() CLAIM_TYPEHASH() DOMAIN_SEPARATOR() isNonceUsed(address,uint256) nonces(address)
stakeToken() rewardToken() exchange() authorizedExecutor()
```

**PriceOracle:**

```
getMarkPrice(uint32) → uint256   getOraclePrice(uint32) → uint256
```

Both return USD × priceScale. There are 4 unknown selectors.

---

## 6. Deposits

Each user gets a **deterministic deposit proxy**, `DepositProxyFactory.computeProxyAddress(user)` (CREATE2).
- `POST /funding/deposits/check {user}` returns `{proxy}` and registers or activates the proxy with the relayer. I did not call it, because it may create state.
- USDC sent to the proxy is credited to the account. Deposit routes are hypercore, hyperevm, ethereum, arbitrum, solana (CCTP) and robinhood (USDG via Across).

Withdrawals:
- Minimum withdrawal is 10 USDC.
- Status is reported at `/query/accounts/{addr}/funding`.
- Only one pending withdrawal is allowed at a time.

---

## 7. Notes and surprises for the bot

1. **The EIP-712 name is `"String"`**, not "Papertrade". Signing with any other name is rejected. The cancellation domain differs: `"PaperTrade Intent Cancel"` v2.
2. **`size` in OpenPosition is the margin** (18-dec USD), not the notional.
3. **Nonces are random and unordered**, and checked through `isNonceUsed`. Any unique uint256 works, so there is no sequencing problem across parallel intents.
4. The whole account state is public: the SSE stream needs no auth for any wallet, and so do the WS trades and queue preview. This also makes it possible to watch other traders and the relayer queue live.
5. Execution is delayed and FIFO-batched by the relayer into 3M-gas HyperEVM small blocks, with about 15–20 intents queued. The price is set on-chain by HyperCore's mark/oracle at execution time, not by the HL bbo the UI shows.
6. Profit is haircut by ≥ 10 % plus a dead-band, then a 2 % win fee. Losses are taken in full, and the bust is a hard total-margin loss slightly *inside* the 1/lev distance because of the bust buffer.
7. The session key is a raw private key. Its expiry is enforced on-chain, and there is a per-wallet session-key cap.
8. The read API is strict about query params. For example, history endpoints require `limit=75` exactly, and `/state/leaderboard/positions` requires `window`.

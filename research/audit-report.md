# papertrade-bot pre-live audit

Date: 2026-10-13. Scope: everything in `src/` and `test/`, checked against `research/exchange_api.md`, `docs_full.txt`, `onchain_state.md`, the prettified frontend bundles, and read-only probes of the live exchange (GETs and the public SSE stream; nothing was posted or signed).

Baseline: `npm test` 8/8 pass, `npx tsc --noEmit -p .` clean.

Evidence scripts (throwaway, not part of the project): `scratchpad/audit/strategy_repro.mts` (fault-injected sim reproducing H1 and H3), `ws_deadpeer.mjs` (M3), `ws_throw.mjs` (L1), `probe_sse.mjs` / `probe_positions.mjs` / `probe_rest2.mjs` (wire-format checks), `math_probe.ts` (payout formula vs. frontend bigint math).

## What was verified as correct (no action needed)

- **Signing and wire format match the frontend byte-for-byte.** The bundle's normaliser (`Py` in `index-DEchBvyk.js`) turns every `uint*` into a decimal string (including `uint32`, so the doc's `"instrumentId": 0` example is hand-written and wrong), `uint256[]` into decimal strings, `address`/`bytes` to lowercase, bools untouched, `v` as `"27"|"28"`, `r`/`s` lowercase. `signing.ts` does exactly this. The intentId derivation, the three domains (incl. the literal `"String"` name and cancel domain v2) and all type definitions match. The cancel body (`signed` minus `intentId`, POSTed to `/intents/{id}/cancel`) matches the bundle.
- **SSE parsing.** The live stream uses `\n\n` framing with no `\r`; `accountRevision`/`baseAccountRevision` are JSON numbers, so the strict-equality patch sync check works; patches carry `addedPositions`, `removedPositionIds`, `intentOutcomes`, partial `state`; the `closedPositions` and `openPositions` tuple layouts match `toClosed`/`toPos` (checked against the zod schemas `En`/`Tn` in `account-wire`). Multi-line `data:` is joined with `\n` per spec. 10/10 live positions sampled carry a non-null `intentId`, so open-fill matching by intentId is sound.
- **`/state/trading` row indices** used by `markets.ts` (12, 13, 16, 17, 18) match the live payload.
- **`/query/accounts/{addr}/trades?limit=75`** returns `items` newest-first with `kind` in `{PositionClosed, Liquidated}`, string raw fields and boolean `isLong`, as `reconcileClosed` assumes.
- **math.ts** reproduces the frontend's bigint `pnl()` (deadband `entry/50000`, impact `(1-baseRate)/(1+1/(d*rateMult)+ref/(1e6*d*posMult))` on the post-deadband move, 2 % win fee, loss capped at margin) to 4 decimals across 0.3-10 bps. `bustPriceRaw` matches the documented formula and the live example.

---

## Confirmed defects, by severity

### H1. A pair is marked `done` while legs are still open (orphaned positions) — `src/strategy.ts:84-88`, `:255-260`, `:152-160`

`flatten()` and `closeBoth()` call `finish()` with only the *fulfilled* close results; a rejected close is silently dropped. `openPair()` does the same for the lone leg when the partner leg fails to open (`r` undefined -> `finish(p,'open-failed',[])`). `finish()` sets `state='done'`, after which the pair is invisible to `activePairs()`, to the stale-feed re-trigger, to `trader.stop()`'s flatten, and to `handleLiquidation()` (which only scans active pairs).

Scenario (reproduced with a fault-injecting sim, `strategy_repro.mts`):
1. Pair in `both`; HL feed goes stale 10 s -> `flatten('feed-stale')`.
2. Relayer is congested / returns 5xx; both `ex.close()` calls reject (in live this is the 60 s `close not confirmed within timeout` or an `ApiError`).
3. Result: `activePairs()=0`, sim still holds 2 open legs, `stats` records a "loss" with net $0. Closes are never retried. The legs sit at 1000x until liquidation (-$10 each), and because the pair is done, those liquidations are never counted, so `maxSessionLossUsd` is not enforced against them. In live, only Ctrl+C (`LiveExecutor.shutdown()` closing `ours`) would ever clean them up.

Same outcome for `closeBoth` on `max-hold` with one failed close (1 orphan leg) and for the open-failed lone leg when its close rejects.

Fix: never `finish()` a pair that still has an unsettled leg. In `flatten`/`closeBoth`, after `allSettled`, attach the fulfilled results and, if any leg is still unsettled, leave the pair in `closing` with `lastCloseAttempt=now` and let a periodic retry (the existing 250 ms timer can call a `retryClosing()` that re-issues `ex.close` for unsettled legs when `now - lastCloseAttempt >= closeRetryMs`) drive it to completion; only then `finish`. For the open-failed path, keep the pair active with the lone leg as `winner`, `loserResult = {netPnl:0,...}` and let the same retry loop close it. Also make `handleLiquidation` consult every non-done pair (it already does) so a liquidation during the retry window settles the leg.

### H2. An open whose POST fails after the relayer accepted it is never tracked — `src/executor/live.ts:125-137`

`postIntent()` can throw after the request was sent: the 35 s `AbortSignal.timeout`, a 5xx/502 from Cloudflare after the relayer enqueued the intent, a reset connection. `open()` then rejects, `openPair` treats the leg as never opened (closes the partner leg, counts `aborted`), but the intent is still live at the relayer for `OPEN_DEADLINE_SEC` (300 s) and can fill. The filled position is not in `pendingOpens`, not in `abandoned`, not in `ours`, so `onState` ignores it and `shutdown()` won't close it. It is a naked 1000x position with nobody watching.

Fix: the local `intentId` is computed before the POST and verified to equal the relayer's, so on *any* failure after the request is sent (timeout, non-ApiError, 5xx) add `intentId` to `abandoned` and fire `cancelIntent(intentId)`. As a backstop, on every full frame treat any position whose `intentId` is one we signed this session (keep a `Set` of signed open intentIds) but is not in `ours` as a late fill and close it.

### H3. Loser-stop retries are ungated: one close intent per tick while the relayer rejects — `src/strategy.ts:176-177`, `:213-226`

`evaluate()`'s `both` branch calls `stopLoser` whenever the leg is at or below `-loserStopPct`, with no `closeRetryMs` check (the `riding` branch has one at `:208`). On failure `stopLoser` resets `state='both'`, so the next tick fires again. HL bbo ticks arrive many times per second.

Scenario (reproduced): long at -35 %, relayer answering 5xx/`invalid_intent`/network error -> 50 `close()` calls in 1.05 s. In live each is a fresh signed intent; this will trip `rate_limited`, and the 429 back-off inside `postIntent` then also delays the one close that matters. README's "a close that fails is retried every 2 s" is only true for the winner.

Fix: in the `both` branch require `now - p.lastCloseAttempt >= cfg.closeRetryMs` before calling `stopLoser` (and `closeBoth`), and set `lastCloseAttempt = Date.now()` in the failure path.

### M1. Session key may expire mid-session; every close then fails — `src/executor/live.ts:88`, no runtime handling

A stored key is accepted if it has more than 3660 s left (mirrors the frontend, which re-signs interactively). The bot never re-checks and has no handler for `unauthorized_intent`. A key with 2 h left passes the check; after 1 h every open *and close* is rejected by the relayer. Combined with H3 this becomes a close-spam loop, and the open legs can only exit by liquidation.

Fix: require at least `max(24 h, 2*maxPairHoldMs)` remaining at startup (register a fresh key otherwise; the main wallet is available), re-check expiry on a timer and stop opening pairs when under a few hours, and on `unauthorized_intent` from a close: re-register (main wallet signs) then retry.

### M2. `PriceFeed.healthy()` is satisfied by pong replies and is not per-asset — `src/prices.ts:54-56`, `:72`

`lastMsgAt` is bumped on every message, including the `pong` to the 30 s ping and subscription acks. `healthy()` therefore means "socket delivered something in the last 5 s", not "we have fresh ticks". Consequences: (a) after a pong, `watchFeed()` resets `feedStaleSince=0` and `maybeStartPair()` may open a pair using up to 30 s-old history for activity scoring; (b) one asset's bbo stream can go quiet while the other keeps the feed "healthy", and since `evaluate()` is only tick-driven, a pair on the quiet asset gets no exit checks at all (no floor, no `max-hold`, no stall). The watchdog at 20 s does catch a fully dead subscription, so the exposure is bounded to the pong cadence, but the semantics are wrong for a safety check.

Fix: keep `lastTickAt[asset]`; make `healthy(asset?)` use tick time; have the 250 ms timer also run `evaluate(p, feed.latest(p.asset))` for pairs whose last evaluation is older than ~1 s so time-based exits fire without a tick.

### M3. Price-feed watchdog can never reconnect if the close handshake does not complete — `src/prices.ts:67-69`, `:85-89`

The watchdog's only action is `ws.close()`, and reconnection happens in `onclose`. Confirmed with `ws_deadpeer.mjs`: against a peer that stops answering (half-open TCP, stalled Cloudflare edge), Node's WebSocket stays in `CLOSING` forever and `onclose` never fires. The watchdog keeps calling `close()` (a no-op in CLOSING). The feed is dead for the rest of the process: `watchFeed` flattens (so no loss), `maybeStartPair` never fires again, and the bot sits idle with no error after the first "price feed stale" warning.

Fix: on watchdog fire, detach the old socket's handlers (`ws.onclose = ws.onmessage = null`), call `ws.close()` best-effort, and immediately `connect()` a new socket; add a connect timeout. (Same pattern for `WalletStream`: `abort()` does work for `fetch`, so that side is fine.)

### M4. A filled leg sits unmanaged for up to 60 s while the partner open hangs — `src/strategy.ts:145`, `src/executor/live.ts:17`, `:141-149`

`openPair` awaits `Promise.allSettled` of both opens. If one leg fills in 1-2 s and the other is stuck in the relayer queue, the filled leg is a naked 1000x position for up to `OPEN_TIMEOUT_MS` (60 s) with no stop, and `handleLiquidation` ignores it because the pair is still `opening` (`:268-284` only handle `both`/`stopping`/winner). After 60 s the stuck leg is cancelled and the filled leg closed, by which time it may have been liquidated (-$10) with the loss never attributed.

Fix: once the first leg resolves, start a short grace timer (e.g. 5-8 s, which already covers normal relayer latency); if the second has not filled, cancel it (`cancelIntent`) and close the filled leg. Let `handleLiquidation` settle a filled leg of an `opening` pair (record result, mark pair aborted when the open completes).

### M5. Liquidations/closes that happen during a stream reconnect are never reported — `src/executor/live.ts:201-217`, `:239-246`

`WalletStream` drops `state` on any error and reconnects with a fresh full frame; the `closedPositions`/`intentOutcomes` from the gap are lost. `onState` reconciles only *pending closes*; a position in `ours` that vanished from the full frame produces no `liqCbs` call. The strategy keeps evaluating a dead leg; in `both` it eventually sees -100 % and issues a close, which the relayer rejects with `noOpenPositions`, which triggers `reconcileClosed` (3 s wait + history GET) and finally resolves as liquidated. It works by accident with a 4-6 s delay, and in `riding` it only resolves when some exit rule fires. `mintedSession` is also undercounted.

Fix: on each full frame, for every `id` in `ours` not present in `positions`, run `reconcileClosed(id)` and let `onClosed` fire `liqCbs` (or a generic "settled" callback) when there is no pending close. Also lost in the gap: an `intentOutcomes` failure for a pending open, which then waits the full 60 s instead of failing fast; reconcile pending opens against `operations` in the full frame.

### L1. Uncaught exceptions in event handlers crash the process — `src/prices.ts:71-84`, `src/strategy.ts:303`, `src/index.ts:66-78`

Confirmed (`ws_throw.mjs`): a throw inside `WebSocket.onmessage` reaches `uncaughtException` and kills the process. `onmessage` does `JSON.parse` unguarded, and every `'tick'` listener (sim keeper, `PairTrader.evaluate`, `finish`, `journal.write` -> `appendFileSync`, which throws on ENOSPC/EACCES) runs inside that handler. Likewise `void this.flatten()` / `void this.stopLoser()` reject on a `journal.write` throw, and Node 22 terminates on unhandled rejections; the async SIGINT handler has the same exposure. A crash with open 1000x legs is the worst outcome here, and the 300 s open deadline does not help closes.

Fix: `try/catch` around `JSON.parse` and around `this.emit('tick', ...)` in `onmessage`; wrap `journal.write` in try/catch; `process.on('unhandledRejection'|'uncaughtException')` handlers that log and attempt a best-effort flatten before exit.

### L2. `ensureSessionKey` dereferences `stream.state!` after an await — `src/executor/live.ts:86`

Between `ready()` and this line there is a network round trip (`/state/trading`); `WalletStream` sets `state = undefined` on any reconnect, so a blip at startup is a `TypeError` -> `process.exit(1)`. Fix: `const s = await this.stream.ready()` right before use (and in the registration wait loop).

### L3. `shutdown()`'s backstop reads the stream snapshot — `src/executor/live.ts:304`

If Ctrl+C lands while the stream is reconnecting (`state` undefined, 1 s sleep + handshake), `open` is `[]` and nothing in `ours` is closed by the executor; only the strategy's `flatten` closes known legs (which H1 shows can be incomplete). Fix: keep `ours` as a `Map<id, LivePosition>` filled from fills and close from that.

### L4. Rate-limit responses that are not HTTP 429 are treated as success — `src/papertrade/api.ts:29-36`

The doc says the relayer answers "HTTP 429 or `{code:"rate_limited"}`". A 200 body with `code` but no `error`/`ok:false` passes the success check; `open()` then falls back to the local intentId and waits 60 s for a fill that never comes (and the next intent is signed while the previous one may still be admitted). Fix: treat any body with a `code` field (or without `intentId`) as an `ApiError`.

### L5. `WalletStream.ready()` can hang forever at startup — `src/papertrade/api.ts:95-99`, `:111`

The watchdog is gated on `lastEventAt` being non-zero, which only happens after the first response, and the `fetch` has no connect timeout. A stalled first connection blocks `init()` indefinitely with no log line. Fix: set `lastEventAt = Date.now()` before the fetch, or race the connect with `AbortSignal.timeout`.

### L6. Unknown `instrumentId` crashes `toPosition` — `src/executor/live.ts:193-194`

`ASSET_BY_ID[lp.instrumentId]` is undefined for any market other than 0/1, and `INSTRUMENTS[undefined].priceScale` throws. It is reachable from `init()` with `ON_START_EXISTING=close` (a wallet holding a position on a newly listed market), from `shutdown()`, and from the abandoned-fill path. Fix: skip and warn on unknown instruments.

---

## Not defects, but worth knowing

- `strategy.ts:163` `if (p.state !== 'opening') return; // flattened during open` is dead: `flatten` skips `opening` pairs, so this never fires. After `stop()` a pair that fills transitions to `both` and `evaluate` keeps running (the tick listener is never removed) until `process.exit`; harmless today because of `pendingCloses` dedup.
- `live.close()` timeout (60 s) leaves the original close intent queued (1 h deadline). The strategy then submits a fresh close every ~62 s; later ones revert on-chain (`failed` outcome). Cancel the stale intent on timeout.
- `freeBalance()` subtracts pending-open margin on top of `availableBalance`, which already excludes `reservedBalance` once the relayer reserves it. Double-counts briefly, in the conservative direction.
- Sim-only: `flatten` during `stopping`/`closing` calls `SimExecutor.close` twice for the same id; the second call clears `closing` early so the keeper can liquidate mid-close. Not reachable in live (dedup via `pendingCloses`).
- `abandoned` is never pruned (grows by one entry per timed-out open). Negligible.

## Improvement suggestions

1. Add a per-pair "closing retry" state machine (fixes H1 and gives one place to add backoff) and a test with a fault-injecting executor; the current strategy tests only cover the happy path.
2. Treat relayer admission codes explicitly: `noOpenPositions` already reconciles; `unauthorized_intent` should re-register the session key; `rate_limited` should pause opens; `tradingPaused`/`marketPaused` should stop opens but keep closing.
3. Log every outgoing intent (action, intentId, position ids) and every stream outcome at `info`, so a live incident can be reconstructed from `logs/`. Currently a rejected close is a one-line warn with no intentId.
4. Make `evaluate` run on the 250 ms timer as well as on ticks (M2), so time-based exits and `max-hold` do not depend on bbo cadence.
5. Lower `OPEN_TIMEOUT_MS` to something near observed relayer latency (p99 of a few seconds) and cancel aggressively; a 60 s unmanaged naked leg is the single largest tail risk in the design.
6. Keep `ours` as a map populated from fills and reconcile it against every full frame (M5, L3), independent of the strategy's view.
7. Install `uncaughtException`/`unhandledRejection` handlers that attempt a flatten before exiting, and guard `journal.write`.

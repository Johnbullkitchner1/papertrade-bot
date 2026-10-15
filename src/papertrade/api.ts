// Papertrade relayer REST + per-wallet live state stream (SSE).

import { EventEmitter } from 'node:events';
import { FRONTEND_BUILD, URLS } from '../constants.ts';
import { log } from '../log.ts';

const HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Papertrade-Build': FRONTEND_BUILD };

export class ApiError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(`${status} ${body.code ?? body.error ?? ''}${body.reason ? ` (${body.reason})` : ''}${body.message ? `: ${body.message}` : ''}`);
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(URLS.exchange + path, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
  const body = await res.json();
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export async function postIntent(action: string, signed: Record<string, unknown>, extra: object = {}, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(URLS.exchange + '/intents', {
      method: 'POST', headers: HEADERS, body: JSON.stringify({ action, signed, ...extra }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if ((res.status === 429 || body.code === 'rate_limited') && attempt < 3) {
      const wait = Math.min(Number(res.headers.get('retry-after') ?? 1) * 1000, 10_000);
      log.warn(`rate limited, retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok || body.error || body.ok === false || body.code) throw new ApiError(res.status, body);
    return body as { intentId: string; action: string; state: string };
  }
}

export async function postJson(path: string, body: object) {
  const res = await fetch(URLS.exchange + path, {
    method: 'POST', headers: HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok || json.error || json.ok === false || json.code) throw new ApiError(res.status, json);
  return json;
}

// ---------- live wallet state ----------

export interface LivePosition {
  positionId: string; instrumentId: number; isLong: boolean; entryPriceRaw: bigint; marginRaw: bigint;
  leverage: number; bustPriceRaw: bigint; openedAtMs: number; intentId: string | null;
}
export interface ClosedPosition {
  positionId: string; instrumentId: number; isLong: boolean; marginRaw: bigint; leverage: number;
  liquidated: boolean; netPnlRaw: bigint; paperMintedRaw: bigint;
}
export interface WalletState {
  accountRevision: number;
  sessionKeys: [string, number][];
  balance: bigint;
  funds: { availableBalance: bigint; reservedBalance: bigint };
  paper: { balance: bigint; staked: bigint };
  lifetimeRealizedPnl: bigint;
  positions: Map<string, LivePosition>;
}

const toPos = (t: unknown[]): LivePosition => ({
  positionId: String(t[0]), instrumentId: Number(t[1]), isLong: Boolean(t[2]), entryPriceRaw: BigInt(t[4] as string),
  marginRaw: BigInt(t[5] as string), leverage: Number(t[6]), bustPriceRaw: BigInt(t[7] as string),
  openedAtMs: Number(t[8]), intentId: (t[9] as string | null)?.toLowerCase() ?? null,
});
const toClosed = (t: unknown[]): ClosedPosition => ({
  positionId: String(t[0]), instrumentId: Number(t[1]), isLong: Boolean(t[2]), marginRaw: BigInt(t[3] as string),
  leverage: Number(t[4]), liquidated: Boolean(t[5]), netPnlRaw: BigInt(t[6] as string), paperMintedRaw: BigInt(t[7] as string),
});
const big = (v: unknown, fallback: bigint) => (v === undefined || v === null ? fallback : BigInt(v as string));

/**
 * Emits:
 *  'state'   (WalletState)            after every full frame / patch
 *  'closed'  (ClosedPosition)         a position was closed or liquidated
 *  'outcome' (intentId, outcome)      an intent finished (succeeded/failed/expired/cancelled/unknown)
 */
export class WalletStream extends EventEmitter {
  state?: WalletState;
  private abort?: AbortController;
  private stopped = false;
  private lastEventAt = 0;
  private watchdog?: NodeJS.Timeout;

  constructor(private wallet: string) { super(); }

  start() {
    this.watchdog = setInterval(() => {
      if (this.lastEventAt && Date.now() - this.lastEventAt > 45_000) { log.warn('wallet stream silent, reconnecting'); this.abort?.abort(); }
    }, 5_000);
    void this.loop();
  }

  stop() { this.stopped = true; clearInterval(this.watchdog); this.abort?.abort(); }

  ready(): Promise<WalletState> {
    return this.state ? Promise.resolve(this.state) : new Promise((r) => this.once('state', r));
  }

  private async loop() {
    while (!this.stopped) {
      try {
        this.abort = new AbortController();
        const ctl = this.abort;
        const connectTimer = setTimeout(() => ctl.abort(), 15_000); // headers must arrive promptly; the watchdog takes over after
        let res: Response;
        try {
          res = await fetch(`${URLS.exchange}/state/user/live?wallet=${this.wallet}`, {
            headers: { Accept: 'text/event-stream', 'X-Papertrade-Build': FRONTEND_BUILD }, signal: ctl.signal,
          });
        } finally {
          clearTimeout(connectTimer);
        }
        if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
        this.lastEventAt = Date.now();
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            this.lastEventAt = Date.now();
            let event = 'message';
            const data: string[] = [];
            for (const line of raw.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
            }
            if (event === 'wallet' && data.length) this.onWallet(JSON.parse(data.join('\n')));
          }
        }
      } catch (e) {
        if (this.stopped) return;
        log.warn('wallet stream error, reconnecting:', (e as Error).message);
      }
      this.state = undefined; // force a fresh full frame
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private onWallet(f: Record<string, any>) {
    if (Object.hasOwn(f, 'baseAccountRevision')) {
      if (!this.state || f.baseAccountRevision !== this.state.accountRevision) {
        log.warn('wallet stream out of sync, reconnecting');
        this.abort?.abort();
        return;
      }
      const s = this.state;
      const st = f.state ?? {};
      s.accountRevision = Number(f.accountRevision);
      if (st.sessionKeys) s.sessionKeys = st.sessionKeys.map((k: [string, string]) => [k[0].toLowerCase(), Number(k[1])]);
      s.balance = big(st.balance, s.balance);
      if (st.funds) s.funds = { availableBalance: big(st.funds.availableBalance, s.funds.availableBalance), reservedBalance: big(st.funds.reservedBalance, s.funds.reservedBalance) };
      if (st.paper) s.paper = { balance: big(st.paper.balance, s.paper.balance), staked: big(st.paper.staked, s.paper.staked) };
      if (f.lifetime?.realizedPnlRaw !== undefined) s.lifetimeRealizedPnl = BigInt(f.lifetime.realizedPnlRaw);
      for (const id of f.removedPositionIds ?? []) s.positions.delete(String(id));
      for (const t of f.addedPositions ?? []) { const p = toPos(t); s.positions.set(p.positionId, p); }
      this.emit('state', s);
      for (const t of f.closedPositions ?? []) this.emit('closed', toClosed(t));
      for (const [id, outcome] of f.intentOutcomes ?? []) this.emit('outcome', String(id).toLowerCase(), outcome);
      return;
    }
    this.state = {
      accountRevision: Number(f.accountRevision),
      sessionKeys: (f.sessionKeys ?? []).map((k: [string, string]) => [k[0].toLowerCase(), Number(k[1])]),
      balance: BigInt(f.balance),
      funds: { availableBalance: BigInt(f.funds.availableBalance), reservedBalance: BigInt(f.funds.reservedBalance) },
      paper: { balance: BigInt(f.paper.balance), staked: BigInt(f.paper.staked) },
      lifetimeRealizedPnl: BigInt(f.lifetime?.realizedPnlRaw ?? '0'),
      positions: new Map((f.openPositions ?? []).map((t: unknown[]) => { const p = toPos(t); return [p.positionId, p]; })),
    };
    this.emit('state', this.state);
  }
}

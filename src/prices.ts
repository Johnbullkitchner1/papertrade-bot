// Live Hyperliquid BBO feed. Papertrade fills at the HL BBO mid, so this is the same price source.

import { EventEmitter } from 'node:events';
import { URLS, ASSETS, type Asset } from './constants.ts';
import { log } from './log.ts';

export interface Tick { t: number; mid: number; bid: number; ask: number }

const HISTORY_MS = 5 * 60_000;
const SILENCE_RECONNECT_MS = 6_000; // HL bbo ticks every ~100 ms; 6 s of silence means the socket is dead

export class PriceFeed extends EventEmitter {
  private ws?: WebSocket;
  private generation = 0;
  private history: Record<Asset, Tick[]> = { BTC: [], ETH: [] };
  private lastTickAt: Record<Asset, number> = { BTC: 0, ETH: 0 };
  private lastMsgAt = 0;
  private pingTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private closed = false;

  start(): Promise<void> {
    this.connect();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastMsgAt > SILENCE_RECONNECT_MS) { log.warn('price feed silent, reconnecting'); this.reconnect(); }
    }, 1_000);
    return new Promise((resolve) => {
      const check = () => (ASSETS.every((a) => this.latest(a)) ? resolve() : setTimeout(check, 100));
      check();
    });
  }

  stop() {
    this.closed = true;
    clearInterval(this.pingTimer);
    clearInterval(this.watchdog);
    clearTimeout(this.reconnectTimer);
    this.detach();
  }

  latest(asset: Asset): Tick | undefined {
    const h = this.history[asset];
    return h[h.length - 1];
  }

  /** Mid price at or just before time t (falls back to the oldest tick). */
  midAt(asset: Asset, t: number): number | undefined {
    const h = this.history[asset];
    for (let i = h.length - 1; i >= 0; i--) if (h[i].t <= t) return h[i].mid;
    return h[0]?.mid;
  }

  ticksSince(asset: Asset, t: number): Tick[] {
    const h = this.history[asset];
    let i = h.length;
    while (i > 0 && h[i - 1].t >= t) i--;
    return h.slice(i);
  }

  /** True when real price ticks (not just pings) arrived recently, for one asset or for all. */
  healthy(maxAgeMs = 10_000, asset?: Asset): boolean {
    const now = Date.now();
    const fresh = (a: Asset) => now - this.lastTickAt[a] < maxAgeMs;
    return asset ? fresh(asset) : ASSETS.every(fresh);
  }

  private detach() {
    const ws = this.ws;
    if (!ws) return;
    this.ws = undefined;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch { /* ignore */ }
  }

  /** Drop the current socket (even if it is stuck in CLOSING) and open a fresh one. */
  private reconnect() {
    if (this.closed) return;
    this.detach();
    this.lastMsgAt = Date.now(); // give the new socket a full silence window
    this.connect();
  }

  private connect() {
    const gen = ++this.generation;
    const ws = new WebSocket(URLS.hlWs);
    this.ws = ws;
    ws.onopen = () => {
      if (gen !== this.generation) return;
      log.info('price feed connected');
      this.lastMsgAt = Date.now();
      for (const coin of ASSETS) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'bbo', coin } }));
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => { if (ws.readyState === ws.OPEN) ws.send('{"method":"ping"}'); }, 30_000);
    };
    ws.onmessage = (ev) => {
      if (gen !== this.generation) return;
      this.lastMsgAt = Date.now();
      let tick: Tick | undefined, coin: Asset | undefined;
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.channel !== 'bbo') return;
        const { coin: c, bbo } = msg.data;
        if (!ASSETS.includes(c) || !bbo?.[0] || !bbo?.[1]) return;
        const bid = Number(bbo[0].px), ask = Number(bbo[1].px);
        if (!(bid > 0) || !(ask >= bid)) return;
        coin = c as Asset;
        tick = { t: Date.now(), bid, ask, mid: (bid + ask) / 2 };
        const h = this.history[coin];
        h.push(tick);
        while (h.length && h[0].t < tick.t - HISTORY_MS) h.shift();
        this.lastTickAt[coin] = tick.t;
      } catch (e) {
        log.warn('bad price message', (e as Error).message);
        return;
      }
      try { this.emit('tick', coin, tick); } catch (e) { log.error('tick listener error', e); }
    };
    ws.onclose = () => {
      if (gen !== this.generation || this.closed) return;
      clearInterval(this.pingTimer);
      log.warn('price feed closed, reconnecting in 1s');
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.reconnect(), 1000);
    };
    ws.onerror = () => { /* onclose / watchdog handle reconnect */ };
  }
}

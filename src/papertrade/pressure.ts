// Relayer queue depth from the public Centrifugo `pressure:current` channel.
//
// The relayer executes intents FIFO in 3M-gas small blocks. When hundreds are queued, a close can
// wait minutes in line, long enough for a 100x leg to be liquidated. The farmer reads depth() to
// avoid opening new cycles into a backed-up queue.

import { URLS } from '../constants.ts';
import { log } from '../log.ts';

const STALE_MS = 15_000;

export class QueuePressure {
  private pending?: number;
  private at = 0;
  private ws?: WebSocket;
  private stopped = false;

  start() {
    if (this.stopped) return;
    const ws = new WebSocket(URLS.stream);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, connect: {} }));
      ws.send(JSON.stringify({ id: 2, subscribe: { channel: 'pressure:current' } }));
    };
    ws.onmessage = (m) => {
      for (const line of String(m.data).split('\n')) {
        if (!line) continue;
        if (line === '{}') { ws.send('{}'); continue; } // Centrifugo ping
        try {
          const j = JSON.parse(line);
          const d = j.push?.pub?.data ?? j.subscribe?.publications?.at(-1)?.data;
          const n = Number(d?.snapshot?.pendingCount);
          if (d?.snapshot?.ok && !d.snapshot.stale && Number.isFinite(n)) { this.pending = n; this.at = Date.now(); }
        } catch { /* ignore malformed frames */ }
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.stopped) return;
      log.warn('queue pressure stream closed, reconnecting');
      setTimeout(() => this.start(), 3000).unref();
    };
  }

  stop() { this.stopped = true; this.ws?.close(); }

  /** Intents currently queued at the relayer, or undefined if unknown/stale. */
  depth(): number | undefined { return Date.now() - this.at < STALE_MS ? this.pending : undefined; }
}

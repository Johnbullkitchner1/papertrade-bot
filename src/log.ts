import { appendFileSync, mkdirSync } from 'node:fs';
import { format } from 'node:util';

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 23);

let file: string | undefined;
const out = (stream: 'log' | 'warn' | 'error', mark: string, a: unknown[]) => {
  const t = ts();
  console[stream](t, mark, ...a);
  // Mirror to a file so an incident can be reconstructed after the terminal is gone.
  if (file) try { appendFileSync(file, `${t} ${mark} ${format(...a)}\n`); } catch { /* never let logging kill the bot */ }
};

export const log = {
  info: (...a: unknown[]) => out('log', '·', a),
  warn: (...a: unknown[]) => out('warn', '!', a),
  error: (...a: unknown[]) => out('error', '✗', a),
  toFile(path: string) { mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true }); file = path; },
};

/** Append-only JSONL journal of pair outcomes, used for success-rate stats. */
export class Journal {
  constructor(private path: string) {
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  }
  write(record: object) {
    appendFileSync(this.path, JSON.stringify({ t: new Date().toISOString(), ...record }) + '\n');
  }
}

import { appendFileSync, mkdirSync } from 'node:fs';

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 23);

export const log = {
  info: (...a: unknown[]) => console.log(ts(), '·', ...a),
  warn: (...a: unknown[]) => console.warn(ts(), '!', ...a),
  error: (...a: unknown[]) => console.error(ts(), '✗', ...a),
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

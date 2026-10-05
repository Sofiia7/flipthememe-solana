/**
 * One JSON object per line on stdout. bigint values are written as decimal strings.
 * Never pass key material here: the keeper logs addresses and signatures only.
 */
export type LogFields = Record<string, unknown>;
export type Logger = (fields: LogFields) => void;

export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
}

export const log: Logger = (fields) => {
  process.stdout.write(`${toJson({ t: new Date().toISOString(), ...fields })}\n`);
};

/** The host of an RPC URL, so API keys in paths or query strings never reach the log. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

/** Emits a line at most once per `everyMs` for the same key (for conditions that persist). */
export function throttled(logger: Logger, everyMs: number): (key: string, fields: LogFields) => void {
  const last = new Map<string, number>();
  return (key, fields) => {
    const now = Date.now();
    const at = last.get(key);
    if (at !== undefined && now - at < everyMs) return;
    last.set(key, now);
    logger(fields);
  };
}

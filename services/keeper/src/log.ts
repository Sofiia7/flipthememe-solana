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

/**
 * Error text that is safe to log: URLs (RPC endpoints carry API keys in their path or query) become
 * `<url>`, and a `key=value` pair for a secret-looking key or a bearer token that is left over
 * (a message that quotes only the query string) loses its value.
 */
export function redact(text: string): string {
  return text
    .replace(/(?:https?|wss?):\/\/[^\s"'`<>]+/gi, '<url>')
    .replace(/\b(api[-_]?key|apikey|access[-_]?token|auth[-_]?token|token|secret|password|key|auth|authorization)=[^&\s"'`<>]*/gi, '$1=<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>');
}

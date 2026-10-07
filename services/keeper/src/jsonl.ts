/**
 * A bounded JSON-lines file: one object per line, appended as they come. Once the file holds more than
 * `maxLines` plus a slack of 5 %, it is cut back to its last `maxLines` lines (a temp file, then a rename),
 * so the disk use stays bounded without a rewrite on every append. Used for shadow.jsonl and rounds.jsonl.
 *
 * Reading skips lines that are not JSON objects (a crash in the middle of an append leaves half a line);
 * the next append starts on a fresh line either way.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { toJson } from './log.ts';

/** A file bigger than this is read from its tail only (the last 16 MB); nothing here comes close. */
export const MAX_READ_BYTES = 16 * 1024 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The last `MAX_READ_BYTES` of a file as text (a first partial line is dropped). */
function readTail(path: string): string {
  const { size } = statSync(path);
  const start = Math.max(0, size - MAX_READ_BYTES);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    const text = buffer.subarray(0, read).toString('utf8');
    if (start === 0) return text;
    const firstBreak = text.indexOf('\n');
    return firstBreak < 0 ? '' : text.slice(firstBreak + 1);
  } finally {
    closeSync(fd);
  }
}

export class JsonlFile {
  readonly path: string;
  private readonly maxLines: number;
  private readonly slack: number;
  /** Lines in the file as far as this process knows (null until the first append counted them). */
  private count: number | null = null;

  constructor(path: string, maxLines: number, slack: number = Math.max(20, Math.floor(maxLines / 20))) {
    this.path = path;
    this.maxLines = Math.max(1, maxLines);
    this.slack = slack;
  }

  /** The JSON objects of the last `limit` lines (all when omitted), oldest first; a line that is not an object is skipped. */
  read(limit: number = Number.POSITIVE_INFINITY): Record<string, unknown>[] {
    if (!existsSync(this.path)) return [];
    const lines = readTail(this.path).split('\n').filter((l) => l.trim() !== '');
    const out: Record<string, unknown>[] = [];
    for (const line of Number.isFinite(limit) ? lines.slice(-limit) : lines) {
      try {
        const value: unknown = JSON.parse(line);
        if (isRecord(value)) out.push(value);
      } catch {
        // half a line from a crash, or not ours
      }
    }
    return out;
  }

  /** Appends one object as a line. Throws when the disk refuses (the caller decides what a failed log write is worth). */
  append(value: unknown): void {
    mkdirSync(dirname(this.path), { recursive: true });
    if (this.count === null) this.count = this.startUp();
    appendFileSync(this.path, `${toJson(value)}\n`);
    this.count++;
    if (this.count > this.maxLines + this.slack) this.trim();
  }

  /** Counts the lines, and makes sure the file ends with a newline so the next line does not join a half one. */
  private startUp(): number {
    if (!existsSync(this.path)) return 0;
    const text = readTail(this.path);
    if (text !== '' && !text.endsWith('\n')) appendFileSync(this.path, '\n');
    return text.split('\n').filter((l) => l.trim() !== '').length;
  }

  private trim(): void {
    const lines = readTail(this.path).split('\n').filter((l) => l.trim() !== '');
    const kept = lines.slice(-this.maxLines);
    const tmp = `${this.path}.tmp`;
    const body = `${kept.join('\n')}\n`;
    writeFileSync(tmp, body);
    try {
      renameSync(tmp, this.path);
    } catch {
      // Windows refuses to replace a file another process holds open; fall back to a plain write.
      writeFileSync(this.path, body);
    }
    this.count = kept.length;
  }
}

import fs from 'fs';
import { writeFileAtomicSync } from './atomicFile';

/**
 * Persistent LRU store for DeepSeek reasoning_content, keyed by tool-call id.
 *
 * DeepSeek's thinking API requires reasoning_content on every assistant
 * tool-call message. The proxy replays it from an in-memory cache, but that
 * cache dies with the process: after an app restart the historical reasoning
 * falls back to an empty string, a mid-history byte change that breaks
 * DeepSeek's cached prefix from that message on. Persisting the cache to a
 * JSONL file in the user-data directory keeps the replayed bytes identical
 * across restarts (Reasonix keeps reasoning in its persisted session log for
 * the same reason).
 *
 * Storage format: one JSON record per line (`{"id","reasoning"}`), appended
 * on every set and compacted (atomic rewrite) when the tail grows past
 * 2x the entry cap. Later lines win on load; corrupt lines are skipped.
 */
export class DeepSeekReasoningStore {
  private readonly entries = new Map<string, string>();
  private filePath: string | null = null;
  private appendedSinceCompact = 0;

  constructor(private readonly maxEntries = 1024) {}

  /** Bind to a backing file and load its contents (last maxEntries records win). */
  load(filePath: string): void {
    this.filePath = filePath;
    if (!fs.existsSync(filePath)) {
      return;
    }
    let lineCount = 0;
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      if (!line.trim()) {
        continue;
      }
      lineCount += 1;
      try {
        const record = JSON.parse(line) as { id?: unknown; reasoning?: unknown };
        if (
          typeof record?.id === 'string' && record.id
          && typeof record?.reasoning === 'string' && record.reasoning
        ) {
          // Re-insert to refresh recency; later lines represent newer writes.
          this.entries.delete(record.id);
          this.entries.set(record.id, record.reasoning);
        }
      } catch {
        // Skip corrupt lines; the rest of the cache is still usable.
      }
    }
    this.evictOldest();
    if (lineCount > this.maxEntries * 2) {
      this.compact();
    }
  }

  get(id: string): string | undefined {
    return this.entries.get(id);
  }

  set(id: string, reasoning: string): void {
    if (!id || !reasoning.trim()) {
      return;
    }
    this.entries.delete(id);
    this.entries.set(id, reasoning);
    this.evictOldest();
    if (!this.filePath) {
      return;
    }
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify({ id, reasoning })}\n`);
      this.appendedSinceCompact += 1;
      if (this.appendedSinceCompact > this.maxEntries) {
        this.compact();
      }
    } catch {
      // Persistence is best-effort; the in-memory entry still serves this run.
    }
  }

  /** Clear memory and remove the backing file (test isolation / cache reset). */
  clear(): void {
    this.entries.clear();
    this.appendedSinceCompact = 0;
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        fs.unlinkSync(this.filePath);
      } catch {
        // Best effort.
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private evictOldest(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== 'string') {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  private compact(): void {
    if (!this.filePath) {
      return;
    }
    const lines = [...this.entries]
      .map(([id, reasoning]) => JSON.stringify({ id, reasoning }))
      .join('\n');
    try {
      writeFileAtomicSync(this.filePath, Buffer.from(lines ? `${lines}\n` : ''));
      this.appendedSinceCompact = 0;
    } catch {
      // Best effort; the append-only file stays valid (just longer).
    }
  }
}

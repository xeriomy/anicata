export const CACHE_MAX_ENTRIES = 10_000;

export type Freshness = 'fresh' | 'stale';

export interface CacheEntry<T> {
  value: T;
  freshUntil: number;
  staleUntil: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  stale: number;
}

interface WrapOptions {
  ttlMs: number;
  staleMs: number;
}

interface StoredEntry {
  value: unknown;
  freshUntil: number;
  staleUntil: number;
}

interface TTLCacheOptions {
  maxEntries?: number;
  now?: () => number;
}

export class TTLCache {
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, StoredEntry>();
  private readonly inflight = new Map<string, Promise<{ value: unknown; freshness: Freshness }>>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;
  private staleHits = 0;

  constructor(opts?: TTLCacheOptions) {
    this.maxEntries = opts?.maxEntries ?? CACHE_MAX_ENTRIES;
    this.now = opts?.now ?? Date.now;
  }

  get<T>(key: string): { value: T; freshness: Freshness } | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return undefined;
    }
    const current = this.now();
    if (current >= entry.staleUntil) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (current < entry.freshUntil) {
      this.hits += 1;
      return { value: entry.value as T, freshness: 'fresh' };
    }
    this.staleHits += 1;
    return { value: entry.value as T, freshness: 'stale' };
  }

  set<T>(key: string, value: T, opts: WrapOptions): void {
    const current = this.now();
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      freshUntil: current + opts.ttlMs,
      staleUntil: current + opts.ttlMs + opts.staleMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }

  async wrap<T>(
    key: string,
    opts: WrapOptions,
    fn: () => Promise<T>,
  ): Promise<{ value: T; freshness: Freshness }> {
    const hit = this.get<T>(key);
    if (hit !== undefined) {
      if (hit.freshness === 'fresh') {
        return hit;
      }
      this.refresh(key, opts, fn);
      return hit;
    }
    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      return (await existing) as { value: T; freshness: Freshness };
    }
    const task: Promise<{ value: T; freshness: Freshness }> = fn().then((value) => {
      this.set(key, value, opts);
      return { value, freshness: 'fresh' as Freshness };
    });
    this.inflight.set(key, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(key);
    }
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, stale: this.staleHits };
  }

  /**
   * Runs `fn` at most once per `key` among concurrent callers: the first
   * caller runs it, the rest await the same promise. Unlike `wrap`, nothing is
   * stored under `key` — it is only the rendezvous, so callers whose stored
   * key is decided by the loader's own result (e.g. the serving source) can
   * still share one flight. A rejection is passed to every waiter and never
   * cached, so the next call retries.
   */
  async dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing !== undefined) {
      return (await existing) as T;
    }
    const task: Promise<T> = fn();
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.staleHits = 0;
  }

  size(): number {
    return this.entries.size;
  }

  private refresh<T>(key: string, opts: WrapOptions, fn: () => Promise<T>): void {
    if (this.inflight.has(key)) {
      return;
    }
    const task: Promise<{ value: unknown; freshness: Freshness }> = fn().then((value) => {
      this.set(key, value, opts);
      return { value, freshness: 'fresh' as Freshness };
    });
    this.inflight.set(key, task);
    void task.then(
      () => {
        this.inflight.delete(key);
      },
      () => {
        this.inflight.delete(key);
      },
    );
  }
}

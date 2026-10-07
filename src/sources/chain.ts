import type { Anime } from '../domain/anime.js';
import { SourceError } from '../domain/errors.js';
import type { CircuitBreaker } from '../net/breaker.js';
import { Deadline } from '../net/deadline.js';
import { permitsFallback } from './fallback-policy.js';
import type { AnimeSource, PageRequest, SourceId, SourcePage } from './types.js';

export interface ChainDeps {
  sources: AnimeSource[]; // ordered; index 0 is primary
  breakers: Map<SourceId, CircuitBreaker>;
  budgetMs?: number; // default 4000
  now?: () => number;
  stickyTtlMs?: number; // default 600_000
}

export interface ChainResult {
  items: Anime[];
  total: number;
  sourceId: SourceId;
  fromFallback: boolean;
}

interface StickyEntry {
  sourceId: SourceId;
  expiresAt: number;
}

const DEFAULT_BUDGET_MS = 4000;
const DEFAULT_STICKY_TTL_MS = 600_000;

export class SourceChain {
  private readonly sources: AnimeSource[];
  private readonly breakers: Map<SourceId, CircuitBreaker>;
  private readonly budgetMs: number;
  private readonly now: () => number;
  private readonly stickyTtlMs: number;
  private readonly sticky = new Map<string, StickyEntry>();

  constructor(deps: ChainDeps) {
    this.sources = [...deps.sources];
    this.breakers = deps.breakers;
    this.budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
    this.now = deps.now ?? Date.now;
    this.stickyTtlMs = deps.stickyTtlMs ?? DEFAULT_STICKY_TTL_MS;
  }

  peekSticky(stickyKey: string): SourceId | undefined {
    this.pruneSticky();
    return this.sticky.get(stickyKey)?.sourceId;
  }

  async fetchPage(
    catalogId: string,
    req: PageRequest,
    stickyKey?: string,
  ): Promise<ChainResult> {
    void catalogId;
    return this.execute(stickyKey, (source, remainingMs) => {
      // Rebuild rather than spread: the inbound req may carry a stale
      // timeoutMs from a previous attempt, and the remaining budget is the
      // only bound that matters for this attempt.
      const attempt: PageRequest = { catalogId: req.catalogId, skip: req.skip, limit: req.limit };
      if (req.genre !== undefined) {
        attempt.genre = req.genre;
      }
      attempt.timeoutMs = remainingMs;
      return source.fetchPage(attempt);
    });
  }

  async search(
    term: string,
    skip: number,
    limit: number,
    stickyKey?: string,
  ): Promise<ChainResult> {
    return this.execute(stickyKey, (source, remainingMs) =>
      source.search(term, skip, limit, remainingMs),
    );
  }

  /**
   * One walk for every source-agnostic call: honour the sticky source if set
   * and its breaker is closed, otherwise walk `sources` in order, skipping any
   * whose breaker is open, giving each only the remaining budget. Shared so
   * `fetchPage` and `search` cannot drift.
   */
  private async execute(
    stickyKey: string | undefined,
    call: (source: AnimeSource, remainingMs: number) => Promise<SourcePage>,
  ): Promise<ChainResult> {
    const deadline = new Deadline(this.budgetMs, this.now);
    let lastError: unknown;
    for (const source of this.orderFor(stickyKey)) {
      // An exhausted deadline never starts another source: each source gets
      // only the remaining budget, never a fresh one.
      if (deadline.expired) {
        break;
      }
      const breaker = this.breakers.get(source.id);
      // An open breaker means no network call at all — that is its point.
      if (breaker !== undefined && !breaker.canAttempt()) {
        continue;
      }
      try {
        const page = await deadline.run((remainingMs) => call(source, remainingMs));
        breaker?.recordSuccess();
        if (stickyKey !== undefined) {
          this.stick(stickyKey, source.id);
        }
        return {
          items: page.items,
          total: page.total,
          sourceId: source.id,
          fromFallback: source !== this.sources[0],
        };
      } catch (err) {
        lastError = err;
        if (err instanceof SourceError && !permitsFallback(err.kind)) {
          // not_found and rate_limited (and invalid_request) mean the source
          // is healthy: record success and stop, never fall back.
          breaker?.recordSuccess();
          throw err;
        }
        breaker?.recordFailure();
      }
    }
    if (lastError instanceof SourceError) {
      throw lastError;
    }
    if (lastError !== undefined) {
      throw new SourceError(
        'server_error',
        lastError instanceof Error ? lastError.message : 'all sources failed',
      );
    }
    if (deadline.expired) {
      throw new SourceError('timeout', `deadline of ${String(this.budgetMs)}ms exceeded`);
    }
    throw new SourceError('server_error', 'all sources unavailable (breakers open)');
  }

  /**
   * Takes a FULL namespaced id (`'anilist:21'`, `'kitsu:1376'`) because the chain
   * must route on the namespace before it knows which source to ask. It parses
   * the namespace, then calls that source's `fetchById(id: number)`. The string
   * here and the number on the port are not a contradiction — they are two
   * different layers.
   */
  async fetchById(id: string): Promise<{ anime: Anime | null; sourceId: SourceId }> {
    const sep = id.indexOf(':');
    const namespace = sep < 0 ? '' : id.slice(0, sep);
    const raw = sep < 0 ? '' : id.slice(sep + 1);
    const numeric = Number(raw);
    const source = this.sources.find((s) => s.id === namespace);
    if (source === undefined || raw.length === 0 || !Number.isInteger(numeric)) {
      throw new SourceError('invalid_request', `unroutable id: ${id}`);
    }
    const breaker = this.breakers.get(source.id);
    if (breaker !== undefined && !breaker.canAttempt()) {
      throw new SourceError('server_error', `${source.id} unavailable (breaker open)`);
    }
    const deadline = new Deadline(this.budgetMs, this.now);
    try {
      const anime = await deadline.run((remainingMs) => source.fetchById(numeric, remainingMs));
      breaker?.recordSuccess();
      return { anime, sourceId: source.id };
    } catch (err) {
      if (err instanceof SourceError && !permitsFallback(err.kind)) {
        breaker?.recordSuccess();
        throw err;
      }
      breaker?.recordFailure();
      if (err instanceof SourceError) {
        throw err;
      }
      throw new SourceError(
        'server_error',
        err instanceof Error ? err.message : 'source failed',
      );
    }
  }

  private orderFor(stickyKey: string | undefined): AnimeSource[] {
    if (stickyKey === undefined) {
      return [...this.sources];
    }
    this.pruneSticky();
    const entry = this.sticky.get(stickyKey);
    if (entry === undefined) {
      return [...this.sources];
    }
    const stickySource = this.sources.find((s) => s.id === entry.sourceId);
    if (stickySource === undefined || stickySource === this.sources[0]) {
      return [...this.sources];
    }
    // Read state without side effects: canAttempt() on a half-open breaker
    // claims the single probe, so only the walk loop may call it (exactly
    // once per source). An open sticky source falls back to normal order and
    // the loop then skips it without a network call.
    if (this.breakers.get(stickySource.id)?.state === 'open') {
      return [...this.sources];
    }
    return [stickySource, ...this.sources.filter((s) => s.id !== stickySource.id)];
  }

  private stick(key: string, sourceId: SourceId): void {
    this.pruneSticky();
    this.sticky.set(key, { sourceId, expiresAt: this.now() + this.stickyTtlMs });
  }

  private pruneSticky(): void {
    const now = this.now();
    for (const [key, entry] of this.sticky) {
      if (entry.expiresAt <= now) {
        this.sticky.delete(key);
      }
    }
  }
}

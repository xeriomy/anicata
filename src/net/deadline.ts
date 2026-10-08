import { SourceError } from '../domain/errors.js';

export class Deadline {
  private readonly budgetMs: number;
  private readonly now: () => number;
  private readonly startMs: number;

  constructor(budgetMs: number, now?: () => number) {
    this.budgetMs = budgetMs;
    this.now = now ?? Date.now;
    this.startMs = this.now();
  }

  get remainingMs(): number {
    return Math.max(0, this.startMs + this.budgetMs - this.now());
  }

  get expired(): boolean {
    return this.remainingMs <= 0;
  }

  /** Resolves `fn`'s result, or rejects with a `timeout` SourceError at the deadline. */
  run<T>(fn: (remainingMs: number) => Promise<T>): Promise<T> {
    const remaining = this.remainingMs;
    if (remaining <= 0) {
      // No budget left: reject without invoking fn — a source must never run
      // past the shared wall-clock deadline.
      return Promise.reject(new SourceError('timeout', `deadline of ${this.budgetMs}ms exceeded`));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new SourceError('timeout', `deadline of ${this.budgetMs}ms exceeded`)),
        remaining,
      );
    });
    // The timer is cleared on settle so a resolved promise never holds the
    // event loop (which would hang the test runner).
    return Promise.race([fn(remaining), timeout]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
  }
}

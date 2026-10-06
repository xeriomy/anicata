interface TokenBucketOptions {
  capacity: number;
  refillPerMinute: number;
  now?: () => number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMinute: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity;
    this.refillPerMinute = opts.refillPerMinute;
    this.now = opts.now ?? Date.now;
    this.tokens = opts.capacity;
    this.lastRefillMs = this.now();
  }

  private refill(): void {
    const current = this.now();
    const elapsedMs = current - this.lastRefillMs;
    if (elapsedMs <= 0) {
      return;
    }
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (elapsedMs / 60000) * this.refillPerMinute,
    );
    this.lastRefillMs = current;
  }

  tryAcquire(): boolean {
    this.refill();
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }

  available(): number {
    this.refill();
    return this.tokens;
  }

  msUntilNextToken(): number {
    this.refill();
    if (this.tokens >= 1) {
      return 0;
    }
    const tokensPerMs = this.refillPerMinute / 60000;
    return Math.ceil((1 - this.tokens) / tokensPerMs);
  }
}

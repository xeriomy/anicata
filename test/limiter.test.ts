import { describe, it, expect } from 'vitest';
import { TokenBucket } from '../src/net/limiter.js';

describe('TokenBucket', () => {
  it('allows capacity tokens then refuses', () => {
    const b = new TokenBucket({ capacity: 3, refillPerMinute: 60 });
    expect([b.tryAcquire(), b.tryAcquire(), b.tryAcquire()]).toEqual([true, true, true]);
    expect(b.tryAcquire()).toBe(false);
  });

  it('refills continuously using the injected clock', () => {
    let now = 0;
    const b = new TokenBucket({ capacity: 1, refillPerMinute: 60, now: () => now });
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    now += 1_100; // 1.1s at 1 token/sec == 1.1 tokens
    expect(b.tryAcquire()).toBe(true);
  });

  it('reports ms until the next token is available', () => {
    const b = new TokenBucket({ capacity: 1, refillPerMinute: 60 });
    b.tryAcquire();
    expect(b.msUntilNextToken()).toBeGreaterThan(900);
    expect(b.msUntilNextToken()).toBeLessThanOrEqual(1000);
  });
});

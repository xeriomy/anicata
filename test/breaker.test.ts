import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../src/net/breaker.js';

describe('CircuitBreaker', () => {
  it('starts closed and allows attempts', () => {
    const b = new CircuitBreaker();
    expect(b.state).toBe('closed');
    expect(b.canAttempt()).toBe(true);
  });

  it('opens after 5 consecutive failures and blocks attempts without a network call', () => {
    const now = 0;
    const b = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000, now: () => now });
    for (let i = 0; i < 4; i += 1) {
      b.recordFailure();
      expect(b.state).toBe('closed');
      expect(b.canAttempt()).toBe(true);
    }
    b.recordFailure();
    expect(b.state).toBe('open');
    expect(b.canAttempt()).toBe(false);
  });

  it('becomes half_open after the cooldown and allows exactly one probe', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000, now: () => now });
    for (let i = 0; i < 5; i += 1) {
      b.recordFailure();
    }
    expect(b.state).toBe('open');
    now += 30_000;
    expect(b.state).toBe('half_open');
    expect(b.canAttempt()).toBe(true);
    // The probe is in flight; a second attempt before it settles is refused.
    expect(b.canAttempt()).toBe(false);
  });

  it('closes on probe success and resets the failure count', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000, now: () => now });
    for (let i = 0; i < 5; i += 1) {
      b.recordFailure();
    }
    now += 30_000;
    expect(b.canAttempt()).toBe(true);
    b.recordSuccess();
    expect(b.state).toBe('closed');
    expect(b.canAttempt()).toBe(true);
    // Count reset: four more failures must not reopen it.
    for (let i = 0; i < 4; i += 1) {
      b.recordFailure();
    }
    expect(b.state).toBe('closed');
  });

  it('reopens when the half-open probe fails', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000, now: () => now });
    for (let i = 0; i < 5; i += 1) {
      b.recordFailure();
    }
    now += 30_000;
    expect(b.canAttempt()).toBe(true);
    b.recordFailure();
    expect(b.state).toBe('open');
    expect(b.canAttempt()).toBe(false);
    // A full cooldown is required again before the next probe.
    now += 29_999;
    expect(b.canAttempt()).toBe(false);
    now += 1;
    expect(b.state).toBe('half_open');
    expect(b.canAttempt()).toBe(true);
  });

  it('treats healthy answers (not_found, rate_limited) as success: they never open the breaker', () => {
    // The caller classifies: a source answering 404 or 429 is responding, so
    // the chain drives recordSuccess for those kinds. Only genuine upstream
    // failures reach recordFailure.
    const now = 0;
    const b = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000, now: () => now });
    for (let i = 0; i < 20; i += 1) {
      b.recordSuccess();
    }
    expect(b.state).toBe('closed');
    expect(b.canAttempt()).toBe(true);
  });

  it('a success resets the failure count from closed', () => {
    const now = 0;
    const b = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000, now: () => now });
    for (let i = 0; i < 4; i += 1) {
      b.recordFailure();
    }
    b.recordSuccess();
    for (let i = 0; i < 4; i += 1) {
      b.recordFailure();
    }
    expect(b.state).toBe('closed');
  });
});

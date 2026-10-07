import { describe, it, expect, vi } from 'vitest';
import { Deadline } from '../src/net/deadline.js';
import { SourceError } from '../src/domain/errors.js';

describe('Deadline', () => {
  it('remainingMs counts down from the budget using the injected clock', () => {
    let now = 1000;
    const d = new Deadline(4000, () => now);
    expect(d.remainingMs).toBe(4000);
    expect(d.expired).toBe(false);
    now += 1500;
    expect(d.remainingMs).toBe(2500);
    expect(d.expired).toBe(false);
    now += 2500;
    expect(d.remainingMs).toBe(0);
    expect(d.expired).toBe(true);
  });

  it('run resolves normally when fn finishes within budget', async () => {
    const d = new Deadline(4000);
    await expect(d.run(async () => 42)).resolves.toBe(42);
  });

  it('run rejects with a timeout SourceError when fn outlives the budget', async () => {
    const d = new Deadline(50);
    const err = await d.run(() => new Promise<string>(() => {})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).kind).toBe('timeout');
  });

  it('run passes the remaining budget to fn, never a fresh full one', async () => {
    let now = 0;
    const d = new Deadline(4000, () => now);
    now += 2500;
    let seen = -1;
    await d.run((remainingMs) => {
      seen = remainingMs;
      return Promise.resolve('ok');
    });
    expect(seen).toBe(1500);
  });

  it('run propagates fn rejections without converting them to timeout', async () => {
    const d = new Deadline(4000);
    const cause = new SourceError('server_error', 'upstream unwell');
    await expect(d.run(() => Promise.reject(cause))).rejects.toBe(cause);
  });

  it('clears its timer when fn settles first, on both resolve and reject', async () => {
    // A leaked setTimeout would keep the event loop alive and hang the
    // runner. Spy on the timer globals and require our own long-delay timer
    // to be cleared on both settle paths. Only long delays are tracked, so
    // short ambient timers from the runner cannot pollute the assertion.
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const expectOwnTimerCleared = (): void => {
      const own: Array<unknown> = [];
      setSpy.mock.calls.forEach((args, index) => {
        const delay: unknown = args[1];
        if (typeof delay === 'number' && delay > 30_000) {
          const res = setSpy.mock.results[index];
          if (res?.type === 'return') {
            own.push(res.value);
          }
        }
      });
      expect(own).toHaveLength(1);
      const cleared = clearSpy.mock.calls.map((args) => args[0]);
      expect(cleared).toContain(own[0]);
    };
    try {
      const d = new Deadline(60_000);
      await expect(d.run(async () => 'ok')).resolves.toBe('ok');
      expectOwnTimerCleared();
      setSpy.mockClear();
      clearSpy.mockClear();
      const cause = new SourceError('network', 'boom');
      await expect(d.run(() => Promise.reject(cause))).rejects.toBe(cause);
      expectOwnTimerCleared();
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});

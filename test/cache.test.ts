import { describe, it, expect, vi } from 'vitest';
import { TTLCache } from '../src/cache/store.js';

describe('TTLCache', () => {
  it('serves a fresh value without calling the loader', async () => {
    let now = 0;
    const c = new TTLCache({ now: () => now });
    const fn = vi.fn().mockResolvedValue('v');
    expect((await c.wrap('k', { ttlMs: 1000, staleMs: 5000 }, fn)).value).toBe('v');
    now += 500;
    expect((await c.wrap('k', { ttlMs: 1000, staleMs: 5000 }, fn)).freshness).toBe('fresh');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('serves stale immediately past ttl and refreshes in the background', async () => {
    let now = 0;
    const c = new TTLCache({ now: () => now });
    const fn = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    await c.wrap('k', { ttlMs: 1000, staleMs: 10_000 }, fn);
    now += 2000; // past fresh, within stale
    const r = await c.wrap('k', { ttlMs: 1000, staleMs: 10_000 }, fn);
    expect(r.value).toBe('first');
    expect(r.freshness).toBe('stale');
    await new Promise(res => setImmediate(res));
    expect(fn).toHaveBeenCalledTimes(2);
    expect((await c.wrap('k', { ttlMs: 1000, staleMs: 10_000 }, fn)).value).toBe('second');
  });

  it('drops the entry entirely past staleMs', async () => {
    let now = 0;
    const c = new TTLCache({ now: () => now });
    const fn = vi.fn().mockResolvedValue('v');
    await c.wrap('k', { ttlMs: 1000, staleMs: 2000 }, fn);
    now += 5000;
    expect(c.get('k')).toBeUndefined();
  });

  it('coalesces 10 concurrent misses into exactly one loader call', async () => {
    const c = new TTLCache();
    let calls = 0;
    const fn = vi.fn(async () => { calls++; await new Promise(r => setTimeout(r, 10)); return 'v'; });
    await Promise.all(Array.from({ length: 10 }, () => c.wrap('k', { ttlMs: 1000, staleMs: 1000 }, fn)));
    expect(calls).toBe(1);
  });

  it('does not cache a rejected loader', async () => {
    const c = new TTLCache();
    const fn = vi.fn().mockRejectedValue(new Error('upstream down'));
    await expect(c.wrap('k', { ttlMs: 1000, staleMs: 1000 }, fn)).rejects.toThrow();
    await expect(c.wrap('k', { ttlMs: 1000, staleMs: 1000 }, fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('evicts least-recently-used entries beyond maxEntries', async () => {
    const c = new TTLCache({ maxEntries: 2 });
    c.set('a', 1, { ttlMs: 10_000, staleMs: 10_000 });
    c.set('b', 2, { ttlMs: 10_000, staleMs: 10_000 });
    c.get('a');
    c.set('c', 3, { ttlMs: 10_000, staleMs: 10_000 });
    expect(c.size()).toBe(2);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBeDefined();
  });
});

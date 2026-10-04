import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from '../src/util/logger.js';

describe('createLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes one JSON line to stdout with level, message and fields', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    createLogger('info').info('catalog.page', { items: 100, skip: 0 });
    expect(write).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(write.mock.calls[0]![0]));
    expect(line).toMatchObject({ level: 'info', msg: 'catalog.page', items: 100, skip: 0 });
    expect(line.ts).toBeTypeOf('number');
  });

  it('serialises an Error without throwing', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(() => createLogger('info').info('boom', { err: new Error('nope') })).not.toThrow();
    expect(String(write.mock.calls[0]![0])).toContain('nope');
  });
});

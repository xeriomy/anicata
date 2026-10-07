import { describe, it, expect } from 'vitest';
import { permitsFallback } from '../src/sources/fallback-policy.js';
import type { SourceErrorKind } from '../src/domain/errors.js';

describe('permitsFallback', () => {
  const cases: Array<[SourceErrorKind, boolean]> = [
    // Transient: a different operator may be fine.
    ['server_error', true],
    ['timeout', true],
    ['network', true],
    // Primary returned something unusable.
    ['parse', true],
    // Our own budget is spent; another source cannot fix it, and calling it
    // wastes the shared deadline.
    ['rate_limited', false],
    // A genuinely absent title is a valid answer; falling back would
    // resurrect titles that do not exist and fire a pointless upstream call
    // for every miss.
    ['not_found', false],
    // Our bug, not the source's.
    ['invalid_request', false],
  ];

  for (const [kind, expected] of cases) {
    it(`${kind} -> ${String(expected)}`, () => {
      expect(permitsFallback(kind)).toBe(expected);
    });
  }

  it('covers every SourceErrorKind exactly once', () => {
    const all: SourceErrorKind[] = [
      'not_found',
      'invalid_request',
      'rate_limited',
      'server_error',
      'timeout',
      'network',
      'parse',
    ];
    expect(cases.map(([kind]) => kind).sort()).toEqual([...all].sort());
  });
});

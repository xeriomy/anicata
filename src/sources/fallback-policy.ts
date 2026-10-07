import type { SourceErrorKind } from '../domain/errors.js';

// Only transient failures trigger fallback (extends ADR-011). Membership is
// the whole policy: rate_limited, not_found and invalid_request are absent
// deliberately — see the test table for why each row fails closed.
const FALLBACK_ELIGIBLE: ReadonlySet<SourceErrorKind> = new Set([
  'server_error',
  'timeout',
  'network',
  'parse',
]);

export function permitsFallback(kind: SourceErrorKind): boolean {
  return FALLBACK_ELIGIBLE.has(kind);
}

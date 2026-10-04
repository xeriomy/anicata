export type SourceErrorKind =
  | 'not_found'
  | 'invalid_request'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'parse';

export class SourceError extends Error {
  constructor(
    readonly kind: SourceErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

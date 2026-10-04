import { SourceError } from '../domain/errors.js';

export interface HttpResult<T> {
  data: T;
  headers: Record<string, string>;
  status: number;
}

export interface GetJsonOptions extends RequestInit {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_USER_AGENT = 'anicata-anime-addon/0.1';
const MAX_BODY_EXCERPT = 500;

interface HttpClientOptions {
  timeoutMs?: number;
  userAgent?: string;
}

export class HttpClient {
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(opts?: HttpClientOptions) {
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = opts?.userAgent ?? DEFAULT_USER_AGENT;
  }

  async getJson<T>(url: string, init?: RequestInit & GetJsonOptions): Promise<HttpResult<T>> {
    const timeoutMs = init?.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const mergedHeaders: Record<string, string> = { ...(init?.headers ?? {}) };
      if (mergedHeaders['user-agent'] === undefined && mergedHeaders['User-Agent'] === undefined) {
        mergedHeaders['User-Agent'] = this.userAgent;
      }
      const fetchInit: RequestInit = { ...init, headers: mergedHeaders, signal: controller.signal };
      delete (fetchInit as Partial<GetJsonOptions>).timeoutMs;

      let res: Response;
      try {
        res = await fetch(url, fetchInit);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new SourceError('timeout', `GET ${url} timed out after ${timeoutMs}ms`);
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new SourceError('network', `GET ${url} failed: ${reason}`);
      }

      const headersOut: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headersOut[key.toLowerCase()] = value;
      });

      const text = await res.text();

      if (res.status === 429) {
        throw new SourceError(
          'rate_limited',
          `GET ${url} rate limited (429): ${excerpt(text)}`,
          res.status,
          parseRetryAfter(res.headers.get('retry-after')),
        );
      }
      if (res.status >= 500) {
        throw new SourceError(
          'server_error',
          `GET ${url} failed with status ${res.status}: ${excerpt(text)}`,
          res.status,
        );
      }
      if (res.status >= 400) {
        throw new SourceError(
          'invalid_request',
          `GET ${url} failed with status ${res.status}: ${excerpt(text)}`,
          res.status,
        );
      }

      try {
        const data = JSON.parse(text) as T;
        return { data, headers: headersOut, status: res.status };
      } catch {
        throw new SourceError(
          'parse',
          `GET ${url} returned invalid JSON: ${excerpt(text)}`,
          res.status,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function excerpt(text: string): string {
  return text.length > MAX_BODY_EXCERPT ? text.slice(0, MAX_BODY_EXCERPT) : text;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return undefined;
}

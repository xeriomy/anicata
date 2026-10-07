export interface BreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
}

export type BreakerState = 'closed' | 'open' | 'half_open';

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000;

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private failures = 0;
  private openedAt: number | undefined;
  private probeInFlight = false;

  constructor(opts?: BreakerOptions) {
    this.failureThreshold = opts?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = opts?.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.openedAt === undefined) {
      return 'closed';
    }
    return this.now() - this.openedAt >= this.cooldownMs ? 'half_open' : 'open';
  }

  canAttempt(): boolean {
    const current = this.state;
    if (current === 'closed') {
      return true;
    }
    if (current === 'open') {
      return false;
    }
    // half_open: allow exactly one probe per cooldown. The breaker does not
    // run the probe itself; the chain does, and settles it via
    // recordSuccess/recordFailure.
    if (this.probeInFlight) {
      return false;
    }
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    // Any success proves the source healthy and resets the count — including
    // healthy answers the caller classifies as success (not_found,
    // rate_limited): a source answering at all is not a dead source.
    // invalid_request likewise never reaches recordFailure.
    this.failures = 0;
    this.openedAt = undefined;
    this.probeInFlight = false;
  }

  recordFailure(): void {
    if (this.openedAt !== undefined) {
      // Probe failed while half_open: reopen for a full cooldown.
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.openedAt = this.now();
        this.probeInFlight = false;
      }
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.openedAt = this.now();
    }
  }
}

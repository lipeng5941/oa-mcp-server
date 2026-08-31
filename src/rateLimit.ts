// ============ 每用户令牌桶限流 ============

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private rps: number) {}

  /** 返回是否放行 */
  allow(key: string): boolean {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.rps, updatedAt: now };
      this.buckets.set(key, b);
    }
    // 回填
    const elapsed = (now - b.updatedAt) / 1000;
    b.tokens = Math.min(this.rps, b.tokens + elapsed * this.rps);
    b.updatedAt = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  /** 周期清理空桶，防止无界增长 */
  sweep(): void {
    const now = Date.now();
    for (const [k, b] of this.buckets) {
      if (now - b.updatedAt > 60_000) this.buckets.delete(k);
    }
  }
}

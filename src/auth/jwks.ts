// ============ JWKS 获取与缓存（RFC 7517） ============
// 仅依赖 node:crypto，无第三方 JWT 库。

import { createPublicKey, KeyObject } from 'crypto';

interface JwksCache {
  keys: Map<string, KeyObject>;   // kid -> public key
  fetchedAt: number;
}

const CACHE_TTL_MS = 3600_000;    // 1 小时
let cache: JwksCache | null = null;
let inflight: Promise<JwksCache> | null = null;

async function fetchJwks(jwksUrl: string): Promise<JwksCache> {
  const res = await fetch(jwksUrl, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`JWKS 拉取失败: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { keys?: Array<Record<string, unknown>> };
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error('JWKS 内容为空');
  }
  const keys = new Map<string, KeyObject>();
  for (const jwk of body.keys) {
    if (jwk.kty !== 'RSA') continue; // 仅 RS256 场景
    const kid = typeof jwk.kid === 'string' ? jwk.kid : '';
    try {
      const key = createPublicKey({ key: jwk as any, format: 'jwk' });
      keys.set(kid, key);
    } catch {
      // 单个 key 解析失败不影响其它
    }
  }
  if (keys.size === 0) throw new Error('JWKS 中无可用 RSA 公钥');
  return { keys, fetchedAt: Date.now() };
}

async function getCache(jwksUrl: string, force: boolean): Promise<JwksCache> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;
  if (!inflight) {
    inflight = fetchJwks(jwksUrl)
      .then(c => { cache = c; return c; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** 按 kid 取公钥；未知 kid 时强制刷新一次（支持密钥轮换） */
export async function getJwkPublicKey(kid: string | undefined, jwksUrl: string): Promise<KeyObject> {
  let c = await getCache(jwksUrl, false);
  if (kid && c.keys.has(kid)) return c.keys.get(kid)!;
  // kid 未知：强制刷新一次
  c = await getCache(jwksUrl, true);
  if (kid && c.keys.has(kid)) return c.keys.get(kid)!;
  if (!kid && c.keys.size === 1) return c.keys.values().next().value as KeyObject;
  throw new Error(kid ? `JWKS 中找不到 kid=${kid}` : 'JWKS 中无匹配公钥');
}

/** 测试/运维：清空缓存 */
export function clearJwksCache(): void {
  cache = null;
}

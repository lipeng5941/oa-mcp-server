// ============ 令牌校验（方案A: JWT/JWKS 验签；方案A': opaque + userinfo） ============
// 红线：员工编号只能来自已验证令牌的 Claim，绝不接受工具入参或未签名 header。

import { createVerify, createHash } from 'crypto';
import { ServerConfig } from '../config';
import { getJwkPublicKey } from './jwks';

export type AuthFailReason =
  | 'missing_token'
  | 'malformed_token'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'bad_issuer'
  | 'bad_audience'
  | 'bad_algorithm'
  | 'userinfo_rejected'
  | 'no_employee_no'
  | 'token_introspection_failed';

export class AuthError extends Error {
  constructor(public reason: AuthFailReason, description: string) {
    super(description);
  }
}

export interface VerifiedIdentity {
  employeeNo: string;       // 来自已验证令牌
  subject: string;          // sub
  clientId: string;         // azp / client_id / aud（审计用）
  raw: Record<string, unknown>; // 已验证的 claims / userinfo（内部使用，禁止入日志）
}

function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  return Buffer.from(s, 'base64');
}

function decodeJwtPart(part: string): Record<string, unknown> {
  try {
    return JSON.parse(b64urlDecode(part).toString('utf8'));
  } catch {
    throw new AuthError('malformed_token', 'JWT 分段无法解析');
  }
}

function extractEmployeeNo(
  profile: Record<string, unknown>,
  cfg: ServerConfig
): { employeeNo: string; subject: string; clientId: string } {
  const subject = typeof profile.sub === 'string' ? profile.sub : '';
  let employeeNo = profile[cfg.employeeNoClaim];
  if (typeof employeeNo !== 'string' || employeeNo.trim() === '') {
    if (cfg.employeeNoFallbackSub && subject) {
      employeeNo = subject;
    } else {
      throw new AuthError(
        'no_employee_no',
        `令牌中缺少员工编号 Claim（${cfg.employeeNoClaim}）`
      );
    }
  }
  const clientId =
    (typeof profile.azp === 'string' && profile.azp) ||
    (typeof profile.client_id === 'string' && profile.client_id) ||
    (typeof profile.clientId === 'string' && profile.clientId) ||
    cfg.clientId;
  return { employeeNo: String(employeeNo).trim(), subject, clientId: String(clientId) };
}

/** 从 MaxKey 响应体中提取用户属性（兼容 {data:{...}} / {result:{...}} 包裹形态） */
function pickProfile(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    for (const wrap of ['data', 'result', 'user', 'userinfo']) {
      const inner = o[wrap];
      if (inner && typeof inner === 'object') return inner as Record<string, unknown>;
    }
    return o;
  }
  throw new AuthError('userinfo_rejected', 'userinfo 响应非 JSON 对象');
}

// ---------- 方案 A：JWT 验签 ----------

async function verifyJwt(token: string, cfg: ServerConfig): Promise<VerifiedIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('malformed_token', '令牌不是有效的 JWT 结构');

  const header = decodeJwtPart(parts[0]);
  if (header.alg !== 'RS256') {
    throw new AuthError('bad_algorithm', `仅支持 RS256，收到 ${String(header.alg)}`);
  }
  const payload = decodeJwtPart(parts[1]);

  // 1) 验签
  const key = await getJwkPublicKey(typeof header.kid === 'string' ? header.kid : undefined, cfg.jwksUrl);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  let sigOk = false;
  try {
    sigOk = verifier.verify(key, b64urlDecode(parts[2]));
  } catch {
    sigOk = false;
  }
  if (!sigOk) throw new AuthError('bad_signature', '签名校验失败');

  // 2) 标准声明校验（含时钟偏移容忍）
  const now = Math.floor(Date.now() / 1000);
  const skew = cfg.clockSkewSec;
  const iss = payload.iss;
  if (iss !== cfg.issuer) {
    throw new AuthError('bad_issuer', '签发方不匹配');
  }
  const aud = payload.aud;
  const audList = Array.isArray(aud) ? aud.map(String) : typeof aud === 'string' ? [aud] : [];
  if (!audList.includes(cfg.audience) && !audList.includes(cfg.clientId)) {
    throw new AuthError('bad_audience', 'audience 不匹配');
  }
  const exp = typeof payload.exp === 'number' ? payload.exp : NaN;
  if (Number.isNaN(exp) || exp + skew < now) {
    throw new AuthError('expired', '令牌已过期');
  }
  if (typeof payload.nbf === 'number' && payload.nbf - skew > now) {
    throw new AuthError('not_yet_valid', '令牌尚未生效');
  }

  // 3) 提取员工编号（只信已验证 Claim）
  const { employeeNo, subject, clientId } = extractEmployeeNo(payload, cfg);
  return { employeeNo, subject, clientId, raw: payload };
}

// ---------- 方案 A'：opaque token + userinfo 校验 ----------

interface UserinfoCacheEntry {
  profile: Record<string, unknown>;
  expiresAt: number;
}
const userinfoCache = new Map<string, UserinfoCacheEntry>();

async function verifyViaUserinfo(token: string, cfg: ServerConfig): Promise<VerifiedIdentity> {
  const cacheKey = createHash('sha256').update(token).digest('hex');
  const hit = userinfoCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    const { employeeNo, subject, clientId } = extractEmployeeNo(hit.profile, cfg);
    return { employeeNo, subject, clientId, raw: hit.profile };
  }

  let url = cfg.userinfoUrl;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (cfg.userinfoTokenMethod === 'bearer') {
    headers.authorization = `Bearer ${token}`;
  } else {
    url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
  }

  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch {
    throw new AuthError('token_introspection_failed', 'userinfo 端点不可达');
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthError('userinfo_rejected', '令牌被 userinfo 端点拒绝');
  }
  if (!res.ok) {
    throw new AuthError('token_introspection_failed', `userinfo 端点返回 ${res.status}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AuthError('userinfo_rejected', 'userinfo 响应不是 JSON');
  }
  const profile = pickProfile(body);

  userinfoCache.set(cacheKey, { profile, expiresAt: Date.now() + cfg.userinfoCacheTtlMs });
  // 简单防膨胀
  if (userinfoCache.size > 1000) {
    const oldest = userinfoCache.keys().next().value;
    if (oldest) userinfoCache.delete(oldest);
  }

  const { employeeNo, subject, clientId } = extractEmployeeNo(profile, cfg);
  return { employeeNo, subject, clientId, raw: profile };
}

// ---------- 统一入口 ----------

export async function verifyBearerToken(token: string, cfg: ServerConfig): Promise<VerifiedIdentity> {
  if (!token || token.trim() === '') throw new AuthError('missing_token', '缺少令牌');
  if (cfg.authMode === 'oidc') {
    return verifyJwt(token.trim(), cfg);
  }
  return verifyViaUserinfo(token.trim(), cfg);
}

/** 从 Authorization 头解析 Bearer 令牌 */
export function parseAuthorizationHeader(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

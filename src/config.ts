// ============ 统一认证版配置加载（严格校验，无默认密钥） ============
// 红线：任何凭据（client_secret / 服务 JWT / 静态 API Key）不得有硬编码默认值。

export type AuthMode = 'oidc' | 'oauth2-userinfo';

// 监听地址白名单：默认回环；显式 0.0.0.0 才绑所有网卡（对外暴露需单独审批，见 docs/对外暴露与鉴权说明_V1.0.md）
export const BIND_ADDRS = ['127.0.0.1', '0.0.0.0'] as const;
export type BindAddr = typeof BIND_ADDRS[number];
export const DEFAULT_BIND_ADDR: BindAddr = '127.0.0.1';

export interface ServerConfig {
  port: number;
  bindAddr: BindAddr;             // MCP_BIND_ADDR，默认 127.0.0.1（只监听本机回环）
  publicUrl: string;              // MCP_PUBLIC_URL，对外完整 URL（PRM / metadata 用）
  authMode: AuthMode;             // oidc = 方案A（JWT+JWKS 验签）；oauth2-userinfo = 方案A'（userinfo 校验）
  issuer: string;                 // MAXKEY_ISSUER，如 https://pttest.sgscf.com/sign
  authorizeUrl: string;           // MaxKey 授权端点
  tokenUrl: string;               // MaxKey 令牌端点
  userinfoUrl: string;            // MaxKey 用户属性端点（/sign/api/oauth/v20/me）
  jwksUrl: string;                // 方案A 必填：JWT 验签密钥集
  clientId: string;               // MaxKey 注册的应用 ID
  audience: string;               // 令牌 audience（aud 校验值，默认=clientId）
  employeeNoClaim: string;        // 员工编号 Claim 名（以 MaxKey Claim Mapper 配置为准）
  employeeNoFallbackSub: boolean; // 员工编号 Claim 缺失时是否允许退回 sub（默认 false）
  adapterUrl: string;             // OA 内部适配层基址（仅内网）
  adapterServiceJwt: string;      // 服务间 JWT（密钥托管注入，禁止入库）
  adapterTimeoutMs: number;
  ledgerExportMaxRows: number;    // 在投业务台账单次全量取数硬上限
  ledgerExportPageSize: number;   // 全量取数上游分页大小
  auditLogPath: string;
  auditHashSalt: string;
  rateLimitRps: number;
  corsAllowedOrigins: string[];
  corsAllowAll: boolean;
  userinfoCacheTtlMs: number;
  userinfoTokenMethod: 'bearer' | 'query';
  clockSkewSec: number;
  stdioEnabled: boolean;          // stdio 仅限本地开发联调，生产一律 HTTP + OAuth
}

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`配置错误:\n- ${problems.join('\n- ')}`);
  }
}

function requireEnv(env: NodeJS.ProcessEnv, name: string, problems: string[]): string {
  const v = (env[name] || '').trim();
  if (!v) problems.push(`缺少必填环境变量 ${name}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const problems: string[] = [];

  const authModeRaw = (env.AUTH_MODE || '').trim();
  if (authModeRaw !== 'oidc' && authModeRaw !== 'oauth2-userinfo') {
    problems.push(`AUTH_MODE 必须为 oidc（方案A）或 oauth2-userinfo（方案A'），当前值: "${authModeRaw}"`);
  }
  const authMode = authModeRaw as AuthMode;

  const publicUrl = requireEnv(env, 'MCP_PUBLIC_URL', problems);
  if (publicUrl && !/^https?:\/\/[^\s]+$/i.test(publicUrl)) {
    problems.push(`MCP_PUBLIC_URL 必须为完整 http(s) URL，当前值: "${publicUrl}"`);
  }

  const issuer = requireEnv(env, 'MAXKEY_ISSUER', problems);
  const authorizeUrl = requireEnv(env, 'MAXKEY_AUTHORIZE_URL', problems);
  const tokenUrl = requireEnv(env, 'MAXKEY_TOKEN_URL', problems);
  const clientId = requireEnv(env, 'MCP_CLIENT_ID', problems);
  const adapterUrl = requireEnv(env, 'OA_ADAPTER_URL', problems);
  const adapterServiceJwt = requireEnv(env, 'OA_ADAPTER_SERVICE_JWT', problems);

  let jwksUrl = (env.MAXKEY_JWKS_URL || '').trim();
  if (authMode === 'oidc' && !jwksUrl) {
    problems.push('AUTH_MODE=oidc 时 MAXKEY_JWKS_URL 必填（JWT 验签密钥集地址）');
  }

  let userinfoUrl = (env.MAXKEY_USERINFO_URL || '').trim();
  if (authMode === 'oauth2-userinfo' && !userinfoUrl) {
    problems.push("AUTH_MODE=oauth2-userinfo 时 MAXKEY_USERINFO_URL 必填（如 .../sign/api/oauth/v20/me）");
  }

  const auditLogPath = (env.AUDIT_LOG_PATH || '').trim() || './logs/audit.log';

  const rateLimitRaw = (env.RATE_LIMIT_RPS || '10').trim();
  const rateLimitRps = Number(rateLimitRaw);
  if (!Number.isInteger(rateLimitRps) || rateLimitRps <= 0) {
    problems.push(`RATE_LIMIT_RPS 必须为正整数，当前值: "${rateLimitRaw}"`);
  }

  const portRaw = (env.MCP_PORT || env.PORT || '3000').trim();
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    problems.push(`MCP_PORT 非法: "${portRaw}"`);
  }

  const bindAddrRaw = (env.MCP_BIND_ADDR || '').trim() || DEFAULT_BIND_ADDR;
  if (!(BIND_ADDRS as readonly string[]).includes(bindAddrRaw)) {
    problems.push(`MCP_BIND_ADDR 只允许 ${BIND_ADDRS.join(' / ')}，当前值: "${bindAddrRaw}"`);
  }
  const bindAddr = bindAddrRaw as BindAddr;

  const corsRaw = (env.CORS_ALLOWED_ORIGINS || '').trim();
  const corsAllowAll = corsRaw === '*';
  const corsAllowedOrigins = corsAllowAll ? [] : corsRaw.split(',').map(s => s.trim()).filter(Boolean);

  const userinfoTokenMethodRaw = (env.USERINFO_TOKEN_METHOD || 'bearer').trim().toLowerCase();
  if (userinfoTokenMethodRaw !== 'bearer' && userinfoTokenMethodRaw !== 'query') {
    problems.push(`USERINFO_TOKEN_METHOD 必须为 bearer 或 query，当前值: "${userinfoTokenMethodRaw}"`);
  }

  const ledgerExportMaxRows = Number((env.LEDGER_EXPORT_MAX_ROWS || '10000').trim());
  if (!Number.isInteger(ledgerExportMaxRows) || ledgerExportMaxRows < 1 || ledgerExportMaxRows > 10000) {
    problems.push('LEDGER_EXPORT_MAX_ROWS 必须是 1-10000 的整数');
  }
  const ledgerExportPageSize = Number((env.LEDGER_EXPORT_PAGE_SIZE || '200').trim());
  if (!Number.isInteger(ledgerExportPageSize) || ledgerExportPageSize < 1 || ledgerExportPageSize > 200) {
    problems.push('LEDGER_EXPORT_PAGE_SIZE 必须是 1-200 的整数');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    port,
    bindAddr,
    publicUrl: publicUrl.replace(/\/+$/, ''),
    authMode,
    issuer,
    authorizeUrl,
    tokenUrl,
    userinfoUrl,
    jwksUrl,
    clientId,
    audience: (env.MAXKEY_AUDIENCE || '').trim() || clientId,
    employeeNoClaim: (env.EMPLOYEE_NO_CLAIM || '').trim() || 'employeeNumber',
    employeeNoFallbackSub: ((env.EMPLOYEE_NO_FALLBACK_SUB || 'false').trim().toLowerCase() === 'true'),
    adapterUrl: adapterUrl.replace(/\/+$/, ''),
    adapterServiceJwt,
    adapterTimeoutMs: Number((env.OA_ADAPTER_TIMEOUT_MS || '30000').trim()) || 30000,
    ledgerExportMaxRows,
    ledgerExportPageSize,
    auditLogPath,
    auditHashSalt: (env.AUDIT_HASH_SALT || '').trim(),
    rateLimitRps,
    corsAllowedOrigins,
    corsAllowAll,
    userinfoCacheTtlMs: Number((env.USERINFO_CACHE_TTL_MS || '60000').trim()) || 60000,
    userinfoTokenMethod: userinfoTokenMethodRaw as 'bearer' | 'query',
    clockSkewSec: Number((env.CLOCK_SKEW_SEC || '30').trim()) || 30,
    stdioEnabled: ((env.STDIO_ENABLED || 'false').trim().toLowerCase() === 'true'),
  };
}

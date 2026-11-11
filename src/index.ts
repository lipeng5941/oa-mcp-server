// ============ 数智办公 MCP Server（统一认证版 2.0.0） ============
// 认证模型（方案A / A'）：
//   Agent → POST /mcp 无令牌 → 401 + WWW-Authenticate: Bearer resource_metadata=...
//   Agent → GET /.well-known/oauth-protected-resource（RFC 9728）→ 指向 MaxKey
//   Agent → MaxKey 授权码 + PKCE 登录（密码只提交给 MaxKey）→ 拿到令牌
//   Agent → Bearer 令牌 → MCP 校验（方案A: JWT/JWKS 验签；方案A': userinfo）→ 提取员工编号
//   MCP → 服务 JWT + X-Employee-No → OA 内部适配层（仅内网）→ OA 行级权限数据
// 红线：员工编号只来自已验证令牌；禁止记录令牌/Cookie/密码；废弃共享 Key/共享 Cookie/WebBridge。

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { randomBytes, randomUUID } from 'crypto';
import { connect as netConnect } from 'net';
import { z } from 'zod';
import { loadConfig, ServerConfig, ConfigError } from './config';
import { AuditLogger } from './audit';
import { RateLimiter } from './rateLimit';
import { verifyBearerToken, parseAuthorizationHeader, AuthError, VerifiedIdentity } from './auth/verify';
import { buildMetadataRouter, wwwAuthenticateHeader } from './auth/metadata';
import { searchOffice, getOfficeDetail } from './api/office';
import { searchRoom, getRoomDetail } from './api/room';
import { searchInvestmentLedger, exportInvestmentLedger, getInvestmentLedgerSchema, LedgerDataError } from './api/ledger';
import { LEDGER_SORT_FIELDS } from './api/ledgerSchema';
import { OfficeSearchParams } from './types/office';
import { RoomSearchParams } from './types/room';

const SERVER_NAME = 'sgs-oa-mcp';
const SERVER_VERSION = '2.0.0';

function newReqId(): string {
  return randomBytes(8).toString('hex');
}

// ---------- MCP 工具注册（每个请求按已验证身份构建，身份经闭包绑定） ----------

function buildMcpServer(
  cfg: ServerConfig,
  audit: AuditLogger,
  identity: VerifiedIdentity,
  reqId: string
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const empHash = audit.hashEmployee(identity.employeeNo);

  const runTool = async (
    tool: string,
    fn: () => Promise<unknown>
  ): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> => {
    const t0 = Date.now();
    try {
      const result = await fn();
      audit.log({
        event: 'tool_call', reqId, transport: 'mcp', tool,
        employeeNoHash: empHash, clientId: identity.clientId,
        status: 'ok', latencyMs: Date.now() - t0,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'unknown error';
      audit.log({
        event: 'tool_call', reqId, transport: 'mcp', tool,
        employeeNoHash: empHash, clientId: identity.clientId,
        status: 'error', latencyMs: Date.now() - t0, detail: msg,
      });
      return { content: [{ type: 'text' as const, text: `查询失败：${msg}` }], isError: true };
    }
  };

  server.registerTool('search_office', {
    title: '查询办公场所',
    description: '查询山钢资本数智办公平台的办公场所列表。可按名称、地址筛选。返回本人权限范围内的数据。',
    inputSchema: {
      officenm: z.string().optional().describe('办公场所名称'),
      address: z.string().optional().describe('地址'),
      current: z.number().default(1).describe('页码'),
      size: z.number().default(15).describe('每页条数'),
    },
  }, async ({ officenm, address, current, size }) =>
    runTool('search_office', () => searchOffice(cfg, identity, { officenm, address, current, size }, reqId)));

  server.registerTool('search_room', {
    title: '查询会议室',
    description: '查询会议室列表。可按名称、容纳人数、楼宇筛选。返回本人权限范围内的数据。',
    inputSchema: {
      roomnm: z.string().optional().describe('会议室名称'),
      capacity: z.number().optional().describe('最低容纳人数'),
      building: z.string().optional().describe('楼宇'),
      current: z.number().default(1).describe('页码'),
      size: z.number().default(15).describe('每页条数'),
    },
  }, async ({ roomnm, capacity, building, current, size }) =>
    runTool('search_room', () => searchRoom(cfg, identity, { roomnm, capacity, building, current, size }, reqId)));

  server.registerTool('get_office_detail', {
    title: '获取办公场所详情',
    description: '根据场所ID获取详细信息',
    inputSchema: { officeid: z.string().describe('办公场所ID') },
  }, async ({ officeid }) =>
    runTool('get_office_detail', () => getOfficeDetail(cfg, identity, officeid, reqId)));

  server.registerTool('get_room_detail', {
    title: '获取会议室详情',
    description: '根据会议室ID获取详细信息',
    inputSchema: { roomid: z.string().describe('会议室ID') },
  }, async ({ roomid }) =>
    runTool('get_room_detail', () => getRoomDetail(cfg, identity, roomid, reqId)));

  const ledgerFilterShape = {
    projectnm: z.string().trim().max(200).optional().describe('项目名称，模糊查询'),
    projectno: z.string().trim().max(200).optional().describe('项目编号'),
    cusnm: z.string().trim().max(200).optional().describe('客户名称'),
    ctrtcode: z.string().trim().max(200).optional().describe('合同编号'),
    compcusnm: z.string().trim().max(200).optional().describe('所属集团/核心企业/付款人'),
    site: z.string().trim().max(200).optional().describe('项目所在地'),
    actsts: z.enum(['1', '2', '3']).optional().describe('项目状态：1=正常，2=逾期，3=已结清；不传表示全部'),
    dealdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('截至该日期未结清项目，YYYY-MM-DD'),
  };
  const ledgerViewSchema = z.enum(['raw', 'display', 'both']).default('both')
    .describe('raw=OA原始字段，display=页面49列，both=两者都返回');

  server.registerTool('get_investment_ledger_schema', {
    title: '获取在投业务台账字段与字典',
    description: '获取统一数据管理→投后数据统计→在投业务台账的49个页面列、查询条件、排序字段和状态/业务类型字典。',
    inputSchema: {},
  }, async () => runTool('get_investment_ledger_schema', async () => getInvestmentLedgerSchema()));

  server.registerTool('search_investment_ledger', {
    title: '查询在投业务台账',
    description: '按当前登录人的OA权限查询在投业务台账。支持项目、客户、合同、所在地、状态筛选与分页；默认同时返回原始字段和页面展示值。',
    inputSchema: {
      ...ledgerFilterShape,
      current: z.number().int().min(1).default(1).describe('页码，从1开始'),
      size: z.number().int().min(1).max(100).default(15).describe('每页条数，最大100'),
      sort: z.enum(LEDGER_SORT_FIELDS).optional().describe('排序字段'),
      order: z.enum(['asc', 'desc']).optional().describe('排序方向'),
      view: ledgerViewSchema,
    },
  }, async (args) => runTool('search_investment_ledger', () => searchInvestmentLedger(cfg, identity, args, reqId)));

  server.registerTool('export_investment_ledger', {
    title: '获取全部在投业务台账',
    description: '自动顺序翻完当前筛选条件下的全部台账，直到上游返回空页。校验总数变化、重复页与缺失ID；不静默截断。适合批量取数，日常问答优先使用分页查询。',
    inputSchema: {
      ...ledgerFilterShape,
      view: ledgerViewSchema,
      maxRows: z.number().int().min(1).max(10000).optional().describe('安全上限，默认取服务端配置；超过上限直接报错，不返回截断数据'),
    },
  }, async (args) => runTool('export_investment_ledger', () => exportInvestmentLedger(cfg, identity, args, reqId)));

  return server;
}

// ---------- 鉴权中间件 ----------

interface AuthedRequest extends express.Request {
  identity?: VerifiedIdentity;
  reqId?: string;
}

function authenticate(cfg: ServerConfig, audit: AuditLogger, limiter: RateLimiter) {
  return async (req: AuthedRequest, res: express.Response, next: express.NextFunction) => {
    const reqId = newReqId();
    req.reqId = reqId;
    const clientIp = req.ip || 'unknown';

    const token = parseAuthorizationHeader(req.headers.authorization);
    if (!token) {
      // 未认证探测限流（防暴力探测），键为 IP
      if (!limiter.allow(`anon:${clientIp}`)) {
        audit.log({ event: 'rate_limited', reqId, path: req.path });
        res.set('retry-after', '1');
        return res.status(429).json({ error: 'TooManyRequests' });
      }
      audit.log({ event: 'auth_fail', reqId, path: req.path, reason: 'missing_token' });
      res.set('www-authenticate', wwwAuthenticateHeader(cfg));
      return res.status(401).json({ error: 'Unauthorized', message: '缺少 Bearer 令牌，请先完成 OAuth 授权' });
    }

    try {
      const identity = await verifyBearerToken(token, cfg);
      req.identity = identity;

      // 已认证用户按员工编号限流
      const empHash = audit.hashEmployee(identity.employeeNo);
      if (!limiter.allow(`user:${empHash}`)) {
        audit.log({ event: 'rate_limited', reqId, path: req.path, employeeNoHash: empHash });
        res.set('retry-after', '1');
        return res.status(429).json({ error: 'TooManyRequests' });
      }

      audit.log({
        event: 'auth_ok', reqId, path: req.path,
        employeeNoHash: empHash, clientId: identity.clientId,
      });
      return next();
    } catch (e) {
      const reason = e instanceof AuthError ? e.reason : 'malformed_token';
      audit.log({ event: 'auth_fail', reqId, path: req.path, reason });
      res.set('www-authenticate', wwwAuthenticateHeader(cfg, 'invalid_token'));
      // 不泄漏内部细节
      return res.status(401).json({ error: 'Unauthorized', message: '令牌无效或已过期' });
    }
  };
}

// ---------- CORS（受限白名单，供浏览器型 OAuth 客户端读取元数据） ----------

function corsMiddleware(cfg: ServerConfig) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const origin = req.headers.origin;
    if (origin && (cfg.corsAllowAll || cfg.corsAllowedOrigins.includes(origin))) {
      res.set('access-control-allow-origin', origin);
      res.set('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
      res.set('access-control-allow-headers', 'Authorization,Content-Type,Mcp-Session-Id');
      res.set('access-control-expose-headers', 'WWW-Authenticate,Mcp-Session-Id');
      if (req.method === 'OPTIONS') return res.status(204).end();
    }
    next();
  };
}

// ---------- 适配层可达性探测（仅状态字面量，不回显 URL/JWT） ----------

export type AdapterState = 'configured' | 'unreachable';

const ADAPTER_PROBE_TIMEOUT_MS = 1500;
const ADAPTER_PROBE_TTL_MS = 5000;
let adapterProbeCache: { at: number; state: AdapterState } | null = null;

// 只做 TCP 连接探测：不发送服务 JWT、不带员工身份、不读上游错误体。
function tcpProbe(hostname: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = netConnect({ host: hostname, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// configured = 已配置 OA_ADAPTER_URL 且端口可达；unreachable = 探测失败（未接入/网络不通/服务异常）。
// 返回值只有这两种字面量，健康检查响应中不出现适配层地址、服务 JWT 或上游错误内容。
export async function probeAdapter(cfg: ServerConfig): Promise<AdapterState> {
  if (!cfg.adapterUrl) return 'unreachable';
  const now = Date.now();
  if (adapterProbeCache && now - adapterProbeCache.at < ADAPTER_PROBE_TTL_MS) {
    return adapterProbeCache.state;
  }
  let state: AdapterState = 'unreachable';
  try {
    const parsed = new URL(cfg.adapterUrl);
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
    state = (await tcpProbe(parsed.hostname, port, ADAPTER_PROBE_TIMEOUT_MS)) ? 'configured' : 'unreachable';
  } catch {
    state = 'unreachable';
  }
  adapterProbeCache = { at: now, state };
  return state;
}

// ---------- HTTP 服务 ----------

async function startHttpServer(cfg: ServerConfig): Promise<void> {
  const audit = new AuditLogger(cfg.auditLogPath, cfg.auditHashSalt);
  const limiter = new RateLimiter(cfg.rateLimitRps);
  setInterval(() => limiter.sweep(), 60_000).unref();

  const app = express();
  app.set('trust proxy', false);
  app.use(express.json());
  app.use(corsMiddleware(cfg));

  // 无鉴权：健康检查与 OAuth 元数据
  // adapter 只暴露状态字面量：configured（已配置且端口可达）/ unreachable（未接入或探测失败）。
  // 不返回适配层 URL、服务 JWT、上游错误体——本次加固不对外部署，探测结果不代表数据可用。
  app.get('/health', async (_req, res) => {
    const adapter = await probeAdapter(cfg);
    res.json({ status: 'ok', version: SERVER_VERSION, authMode: cfg.authMode, adapter });
  });
  app.use(buildMetadataRouter(cfg));

  const auth = authenticate(cfg, audit, limiter);

  // ---------- MCP Streamable HTTP 端点（有状态会话：身份在 initialize 时绑定） ----------
  // 会话 ↔ 身份绑定：会话创建时的令牌身份即该会话身份；
  // 后续请求必须携带同一员工的令牌，否则 401（防止会话被他人令牌复用）。
  interface McpSession {
    transport: StreamableHTTPServerTransport;
    server: McpServer;
    empHash: string;
  }
  const sessions = new Map<string, McpSession>();

  app.all('/mcp', auth, async (req: AuthedRequest, res: express.Response) => {
    const identity = req.identity!;
    const reqId = req.reqId!;
    const empHash = audit.hashEmployee(identity.employeeNo);

    if (req.method === 'POST') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId) {
        // 新会话：必须是 initialize 请求；身份在此刻绑定
        const server = buildMcpServer(cfg, audit, identity, reqId);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server, empHash });
          },
          onsessionclosed: (sid) => {
            sessions.delete(sid);
          },
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      const entry = sessions.get(sessionId);
      if (!entry) {
        return res.status(404).json({ error: 'SessionNotFound', message: '会话不存在或已关闭' });
      }
      if (entry.empHash !== empHash) {
        audit.log({
          event: 'auth_fail', reqId, path: '/mcp', reason: 'session_identity_mismatch',
          employeeNoHash: empHash,
        });
        res.set('www-authenticate', wwwAuthenticateHeader(cfg, 'invalid_token'));
        return res.status(401).json({ error: 'Unauthorized', message: '令牌身份与会话不匹配' });
      }
      await entry.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method === 'GET') {
      // SSE 流：仅允许已存在且身份匹配的会话
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const entry = sessionId ? sessions.get(sessionId) : undefined;
      if (!entry) return res.status(400).json({ error: 'BadRequest', message: '缺少有效会话' });
      if (entry.empHash !== empHash) {
        res.set('www-authenticate', wwwAuthenticateHeader(cfg, 'invalid_token'));
        return res.status(401).json({ error: 'Unauthorized' });
      }
      await entry.transport.handleRequest(req, res);
      return;
    }

    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const entry = sessionId ? sessions.get(sessionId) : undefined;
      if (!entry) return res.status(404).json({ error: 'SessionNotFound' });
      if (entry.empHash !== empHash) {
        res.set('www-authenticate', wwwAuthenticateHeader(cfg, 'invalid_token'));
        return res.status(401).json({ error: 'Unauthorized' });
      }
      await entry.transport.handleRequest(req, res);
      sessions.delete(sessionId!);
      return;
    }

    return res.status(405).json({ error: 'MethodNotAllowed' });
  });

  // REST 工具端点（与 /mcp 同一鉴权与身份）
  const restCall = (tool: string, fn: (req: AuthedRequest) => Promise<unknown>) =>
    async (req: AuthedRequest, res: express.Response) => {
      const identity = req.identity!;
      const reqId = req.reqId!;
      const empHash = audit.hashEmployee(identity.employeeNo);
      const t0 = Date.now();
      try {
        const data = await fn(req);
        audit.log({
          event: 'tool_call', reqId, transport: 'rest', tool,
          employeeNoHash: empHash, clientId: identity.clientId,
          status: 'ok', latencyMs: Date.now() - t0,
        });
        res.json({ success: true, data });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'unknown error';
        audit.log({
          event: 'tool_call', reqId, transport: 'rest', tool,
          employeeNoHash: empHash, clientId: identity.clientId,
          status: 'error', latencyMs: Date.now() - t0, detail: msg,
        });
        const invalidArgument = error instanceof LedgerDataError;
        res.status(invalidArgument ? 400 : 502).json({
          success: false,
          error: msg,
          code: invalidArgument ? 'INVALID_ARGUMENT' : 'UPSTREAM_ERROR',
        });
      }
    };

  app.post('/api/v1/tools/search_office', auth, restCall('search_office', (req) => {
    const params: OfficeSearchParams = {
      officenm: req.body.officenm,
      address: req.body.address,
      current: req.body.current || 1,
      size: req.body.size || 15,
    };
    return searchOffice(cfg, req.identity!, params, req.reqId!).then(r => (r as any)?.result ?? r);
  }));

  app.post('/api/v1/tools/get_office_detail', auth, restCall('get_office_detail', (req) =>
    getOfficeDetail(cfg, req.identity!, req.body.officeid, req.reqId!)));

  app.post('/api/v1/tools/search_room', auth, restCall('search_room', (req) => {
    const params: RoomSearchParams = {
      roomnm: req.body.roomnm,
      capacity: req.body.capacity,
      building: req.body.building,
      current: req.body.current || 1,
      size: req.body.size || 15,
    };
    return searchRoom(cfg, req.identity!, params, req.reqId!).then(r => (r as any)?.result ?? r);
  }));

  app.post('/api/v1/tools/get_room_detail', auth, restCall('get_room_detail', (req) =>
    getRoomDetail(cfg, req.identity!, req.body.roomid, req.reqId!)));

  app.get('/api/v1/tools/investment_ledger/schema', auth, restCall('get_investment_ledger_schema', async () =>
    getInvestmentLedgerSchema()));

  app.post('/api/v1/tools/search_investment_ledger', auth, restCall('search_investment_ledger', (req) =>
    searchInvestmentLedger(cfg, req.identity!, req.body || {}, req.reqId!)));

  app.post('/api/v1/tools/export_investment_ledger', auth, restCall('export_investment_ledger', (req) =>
    exportInvestmentLedger(cfg, req.identity!, req.body || {}, req.reqId!)));

  app.get('/api/v1/tools', auth, (req, res) => {
    res.json({
      success: true,
      tools: [
        { name: 'search_office', description: '查询办公场所列表（本人权限）', params: { officenm: 'string (可选)', address: 'string (可选)', current: 'number', size: 'number' } },
        { name: 'get_office_detail', description: '获取办公场所详情', params: { officeid: 'string (必填)' } },
        { name: 'search_room', description: '查询会议室列表（本人权限）', params: { roomnm: 'string (可选)', capacity: 'number (可选)', building: 'string (可选)', current: 'number', size: 'number' } },
        { name: 'get_room_detail', description: '获取会议室详情', params: { roomid: 'string (必填)' } },
        { name: 'get_investment_ledger_schema', description: '获取在投业务台账49列、筛选项和字典', params: {} },
        { name: 'search_investment_ledger', description: '按本人OA权限筛选并分页查询在投业务台账', params: { current: 'number', size: 'number (最大100)', view: 'raw|display|both' } },
        { name: 'export_investment_ledger', description: '自动翻完在投业务台账全部页面并做完整性检查', params: { view: 'raw|display|both', maxRows: 'number (可选)' } },
      ],
    });
  });

  app.listen(cfg.port, cfg.bindAddr, () => {
    audit.log({ event: 'server_start', detail: `mode=${cfg.authMode} bind=${cfg.bindAddr} port=${cfg.port}` });
    console.log(`SGS OA MCP Server ${SERVER_VERSION} (unified-auth, ${cfg.authMode}) listening on ${cfg.bindAddr}:${cfg.port}`);
    if (cfg.bindAddr === '0.0.0.0') {
      console.warn('警告：MCP_BIND_ADDR=0.0.0.0 会把服务暴露到所有网卡，仅在明确批准的对外暴露场景使用。');
    }
  });
}

// ---------- stdio 模式（仅本地开发联调，显式开关） ----------

async function startStdioServer(cfg: ServerConfig): Promise<void> {
  const devEmployee = (process.env.STDIO_DEV_EMPLOYEE_NO || '').trim();
  if (!devEmployee) {
    console.error('stdio 模式仅限本地开发：必须显式设置 STDIO_DEV_EMPLOYEE_NO（本人员工编号）。生产请使用 HTTP + OAuth。');
    process.exit(2);
  }
  const audit = new AuditLogger(cfg.auditLogPath, cfg.auditHashSalt);
  const identity: VerifiedIdentity = { employeeNo: devEmployee, subject: `stdio-dev:${devEmployee}`, clientId: 'stdio-local-dev', raw: {} };
  const mcpServer = buildMcpServer(cfg, audit, identity, newReqId());
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error(`SGS OA MCP Server ${SERVER_VERSION} stdio dev mode (employee=${devEmployee})`);
}

// ---------- 入口 ----------

function main(): void {
  let cfg: ServerConfig;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }

  const transport = process.argv[2] || 'http';
  if (transport === 'stdio') {
    if (!cfg.stdioEnabled) {
      console.error('stdio 模式未启用：如确需本地联调，设置 STDIO_ENABLED=true 与 STDIO_DEV_EMPLOYEE_NO。');
      process.exit(2);
    }
    startStdioServer(cfg).catch(e => {
      console.error('stdio 启动失败:', e);
      process.exit(1);
    });
    return;
  }

  startHttpServer(cfg).catch(e => {
    console.error('HTTP 启动失败:', e);
    process.exit(1);
  });
}

main();

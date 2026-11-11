#!/usr/bin/env node
/**
 * E2E 验收测试：统一认证版（方案A: JWT/JWKS）
 * 组成：
 *  - mock MaxKey IdP（真 RSA 密钥对 + JWKS 端点，签发 RS256 JWT）→ 模拟 pttest.sgscf.com/sign
 *  - mock OA 适配层（按 X-Employee-No 返回不同行级数据）→ 模拟 OA 内部适配层
 *  - 被测服务：dist/index.js（AUTH_MODE=oidc）
 * 验收项（《统一认证改造验收结果清单》六项）：
 *  1 有效身份访问  2 无凭证401  3 错误/过期凭证拒绝  4 双账号行级隔离
 *  5 重启后配置生效  6 审计日志可追踪（不含敏感信息）
 */
import { createServer } from 'http';
import { generateKeyPairSync, createSign, createVerify, createPublicKey, randomBytes } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const IDP_PORT = 3101;
const ADAPTER_PORT = 3102;
const MCP_PORT = 3100;
const IDP_ISSUER = `http://127.0.0.1:${IDP_PORT}/sign`;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}`;
const CLIENT_ID = 'mcp-test-client';
const KID = 'maxkey_rsa_test';

// ---------- 结果收集 ----------
const results = [];
function check(id, name, pass, evidence) {
  results.push({ id, name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${name} :: ${evidence}`);
}

// ---------- 1. Mock MaxKey IdP（真 RSA + JWKS） ----------
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubJwk = publicKey.export({ format: 'jwk' });
pubJwk.kid = KID;
pubJwk.alg = 'RS256';
pubJwk.use = 'sig';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signJwt(payload, { header = {} } = {}) {
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID, ...header }));
  const p = b64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${h}.${p}`);
  const sig = b64url(signer.sign(privateKey));
  return `${h}.${p}.${sig}`;
}

const now = () => Math.floor(Date.now() / 1000);

function mintToken({ employeeNo, sub, ttl = 900, aud = CLIENT_ID, extra = {} }) {
  return signJwt({
    iss: IDP_ISSUER,
    aud,
    sub,
    exp: now() + ttl,
    iat: now(),
    nbf: now() - 1,
    employeeNumber: employeeNo,
    azp: CLIENT_ID,
    ...extra,
  });
}

const idpServer = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/sign/jwks') {
    res.end(JSON.stringify({ keys: [pubJwk] }));
  } else if (req.url === '/sign/.well-known/openid-configuration') {
    res.end(JSON.stringify({ issuer: IDP_ISSUER, jwks_uri: `${IDP_ISSUER}/jwks` }));
  } else if (req.url?.startsWith('/sign/api/oauth/v20/me')) {
    // 模拟 MaxKey userinfo：Bearer 令牌验签通过后返回 claims（兼容 {data:{}} 包裹）
    const auth = req.headers.authorization || '';
    const urlToken = (req.url.split('access_token=')[1] || '').split('&')[0];
    const token = auth.replace(/^Bearer\s+/i, '') || decodeURIComponent(urlToken || '');
    try {
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error('bad token');
      const signer = createVerify('RSA-SHA256');
      signer.update(`${parts[0]}.${parts[1]}`);
      if (!signer.verify(publicKey, Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64'))) {
        throw new Error('bad sig');
      }
      const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        res.statusCode = 401;
        return res.end('{"error":"expired"}');
      }
      res.end(JSON.stringify({ code: 0, data: payload }));
    } catch {
      res.statusCode = 401;
      res.end('{"error":"invalid_token"}');
    }
  } else {
    res.statusCode = 404;
    res.end('{}');
  }
});

// ---------- 2. Mock OA 适配层（行级隔离：不同员工看到不同数据） ----------
const OA_DATA = {
  'E1001': { rows: [{ officeid: 'OF-001', officenm: '济南总部1801会议室所在楼层' }], totalCount: 1 },
  'E2002': { rows: [{ officeid: 'OF-001', officenm: '济南总部1801会议室所在楼层' }, { officeid: 'OF-002', officenm: '青岛分部办公区' }], totalCount: 2 },
};
const ledgerBase = {
  cusid: 'C-TEST', cusnm: '测试客户', projectnm: '测试台账项目', projectno: '',
  projtype: '0', sgtype: '12', actsts: '1', biztype: '1', rettyp: '1',
  projamt: 10000, avlblc: 8000, takeamt: 2000, realpayint: 25, yield: 3.5,
};
const LEDGER_DATA = {
  E1001: [
    { ...ledgerBase, actbasid: 'LA-001', projectid: 'LP-001', projectnm: '台账项目A1' },
    { ...ledgerBase, actbasid: 'LA-002', projectid: 'LP-002', projectnm: '台账项目A2' },
    { ...ledgerBase, actbasid: 'LA-003', projectid: 'LP-003', projectnm: '台账项目A3' },
  ],
  E2002: [
    { ...ledgerBase, actbasid: 'LA-001', projectid: 'LP-001', projectnm: '台账项目A1' },
    { ...ledgerBase, actbasid: 'LB-001', projectid: 'LP-B01', projectnm: '台账项目B1' },
  ],
};
const adapterCalls = [];
const adapterServer = createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const emp = req.headers['x-employee-no'];
    const svcAuth = req.headers['authorization'];
    adapterCalls.push({ path: req.url, emp, hasSvcJwt: /^Bearer .+$/.test(svcAuth || ''), reqId: req.headers['x-request-id'] });
    res.setHeader('content-type', 'application/json');
    // 服务 JWT 校验（模拟适配层拒绝匿名服务调用）
    if (!/^Bearer .+$/.test(svcAuth || '')) {
      res.statusCode = 401;
      return res.end('{"error":"missing service jwt"}');
    }
    if (!emp) {
      res.statusCode = 400;
      return res.end('{"error":"missing x-employee-no"}');
    }
    if (req.url === '/v1/investment-ledger/list') {
      const ledgerRows = LEDGER_DATA[emp];
      if (!ledgerRows) {
        res.statusCode = 404;
        return res.end('{"error":"employee not mapped"}');
      }
      const params = JSON.parse(body || '{}');
      const current = params.current || 1;
      const size = params.size || 15;
      const start = (current - 1) * size;
      return res.end(JSON.stringify({
        total: ledgerRows.length,
        rows: ledgerRows.slice(start, start + size),
      }));
    }
    const data = OA_DATA[emp];
    if (!data) {
      res.statusCode = 404;
      return res.end('{"error":"employee not mapped"}');
    }
    res.end(JSON.stringify({ result: data, status: 200 }));
  });
});

// ---------- 3. 启动被测服务 ----------
function startMcpServer(envExtra, auditPath) {
  const env = {
    ...process.env,
    MCP_PORT: String(MCP_PORT),
    MCP_PUBLIC_URL: MCP_URL,
    AUTH_MODE: 'oidc',
    MAXKEY_ISSUER: IDP_ISSUER,
    MAXKEY_AUTHORIZE_URL: `${IDP_ISSUER}/authz/oauth/v20/authorize`,
    MAXKEY_TOKEN_URL: `${IDP_ISSUER}/authz/oauth/v20/token`,
    MAXKEY_USERINFO_URL: `${IDP_ISSUER}/api/oauth/v20/me`,
    MAXKEY_JWKS_URL: `${IDP_ISSUER}/jwks`,
    MCP_CLIENT_ID: CLIENT_ID,
    EMPLOYEE_NO_CLAIM: 'employeeNumber',
    OA_ADAPTER_URL: `http://127.0.0.1:${ADAPTER_PORT}`,
    OA_ADAPTER_SERVICE_JWT: 'svc-jwt-' + randomBytes(12).toString('hex'),
    AUDIT_LOG_PATH: auditPath,
    AUDIT_HASH_SALT: 'test-salt',
    RATE_LIMIT_RPS: '10',
    LEDGER_EXPORT_PAGE_SIZE: '2',
    LEDGER_EXPORT_MAX_ROWS: '100',
    ...envExtra,
  };
  const child = spawn(process.execPath, [path.join(REPO, 'dist/index.js'), 'http'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: REPO,
  });
  child.stdout.on('data', d => process.stdout.write(`[mcp:out] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[mcp:err] ${d}`));
  return child;
}

async function waitHttp(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch (error) {
      if (i === tries - 1) console.error(`waitHttp last error for ${url}:`, error);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

function kill(child) {
  return new Promise(resolve => {
    if (!child) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 2000);
  });
}

// MCP initialize/tools 流程
async function mcpInitialize(token) {
  const r = await fetch(`${MCP_URL}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-test', version: '1.0' } },
    }),
  });
  const sid = r.headers.get('mcp-session-id');
  const body = await r.text();
  // 协议要求：initialize 之后发送 initialized 通知
  if (r.status === 200 && sid) {
    await fetch(`${MCP_URL}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'mcp-session-id': sid,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  }
  return { status: r.status, sid, body };
}

async function mcpCallTool(token, sid, name, args, id = 42) {
  const r = await fetch(`${MCP_URL}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      ...(sid ? { 'mcp-session-id': sid } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  return { status: r.status, body: await r.text() };
}

function toolPayload(response) {
  const rpc = JSON.parse(response.body);
  if (rpc.error) throw new Error(JSON.stringify(rpc.error));
  return JSON.parse(rpc.result.content[0].text);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgs-oa-mcp-e2e-'));
  const auditPath = path.join(tmpDir, 'audit.log');

  await new Promise(r => idpServer.listen(IDP_PORT, r));
  await new Promise(r => adapterServer.listen(ADAPTER_PORT, r));

  let child = startMcpServer({}, auditPath);
  const up = await waitHttp(`${MCP_URL}/health`);
  if (!up) {
    console.error('FATAL: MCP server failed to start');
    process.exit(2);
  }

  try {
    // ===== 前置：健康检查与元数据 =====
    const health = await fetch(`${MCP_URL}/health`).then(r => r.json());
    check('P0a', '健康检查无鉴权可用', health.status === 'ok' && health.version === '2.0.0', JSON.stringify(health));

    const prmRes = await fetch(`${MCP_URL}/.well-known/oauth-protected-resource`);
    const prm = await prmRes.json();
    check('P0b', 'RFC 9728 PRM 可获取且指向授权服务器',
      prmRes.status === 200 && prm.resource === MCP_URL && Array.isArray(prm.authorization_servers) && prm.authorization_servers[0] === IDP_ISSUER,
      JSON.stringify(prm));

    const asmRes = await fetch(`${MCP_URL}/.well-known/oauth-authorization-server/sign`);
    const asm = await asmRes.json();
    check('P0c', 'RFC 8414 AS 元数据镜像（含 PKCE S256）',
      asmRes.status === 200 && asm.issuer === IDP_ISSUER && (asm.code_challenge_methods_supported || []).includes('S256'),
      JSON.stringify(asm));

    // ===== 验收项2：无凭证 401 + WWW-Authenticate =====
    const noTok = await fetch(`${MCP_URL}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const wa = noTok.headers.get('www-authenticate') || '';
    check(2, '无凭证访问返回 401 且带 WWW-Authenticate(resource_metadata)',
      noTok.status === 401 && wa.includes('Bearer') && wa.includes(`${MCP_URL}/.well-known/oauth-protected-resource`),
      `status=${noTok.status} www-authenticate=${wa}`);

    // ===== 验收项1：有效身份访问（账号A: E1001） =====
    const tokenA = mintToken({ employeeNo: 'E1001', sub: 'user-a-uuid' });
    const initA = await mcpInitialize(tokenA);
    let pass1 = initA.status === 200 && !!initA.sid;
    let dataA = null;
    if (pass1) {
      const callA = await mcpCallTool(tokenA, initA.sid, 'search_office', { current: 1, size: 15 });
      pass1 = callA.status === 200 && callA.body.includes('OF-001');
      dataA = callA.body;
    }
    check(1, '有效身份访问：账号A令牌→initialize+tools/call 返回本人数据',
      pass1, `init=${initA.status} sid=${initA.sid} tool响应含OF-001=${String(dataA || '').includes('OF-001')}`);

    const schemaResponse = await mcpCallTool(tokenA, initA.sid, 'get_investment_ledger_schema', {});
    const ledgerSchema = toolPayload(schemaResponse);
    check('L1', '在投业务台账 schema 工具返回49列、8个筛选项与字典',
      schemaResponse.status === 200 && ledgerSchema.columns.length === 49 && ledgerSchema.filters.length === 8 && ledgerSchema.codeSets.SG002['2'] === '逾期',
      `columns=${ledgerSchema.columns.length} filters=${ledgerSchema.filters.length}`);

    const ledgerSearchResponse = await mcpCallTool(tokenA, initA.sid, 'search_investment_ledger', { current: 1, size: 2, view: 'both' });
    const ledgerSearch = toolPayload(ledgerSearchResponse);
    const firstLedgerRow = ledgerSearch.rows[0];
    check('L2', '在投业务台账分页查询同时返回 raw/display 且不泄漏B账号项目',
      ledgerSearch.pagination.total === 3 && ledgerSearch.rows.length === 2 &&
      firstLedgerRow.raw.projectid === 'LP-001' && firstLedgerRow.display.actsts === '正常' &&
      firstLedgerRow.display.projamt === '10,000 元' && !ledgerSearchResponse.body.includes('LP-B01'),
      `total=${ledgerSearch.pagination.total} pageRows=${ledgerSearch.rows.length} display49=${Object.keys(firstLedgerRow.display).length}`);

    const ledgerExportResponse = await mcpCallTool(tokenA, initA.sid, 'export_investment_ledger', { view: 'raw', maxRows: 10 });
    const ledgerExport = toolPayload(ledgerExportResponse);
    check('L3', '在投业务台账全量工具自动翻到空页并保留全部本人记录',
      ledgerExport.export.complete === true && ledgerExport.export.rowCount === 3 &&
      ledgerExport.export.reportedTotal === 3 && ledgerExport.export.pagesFetched === 3 &&
      ledgerExport.rows.length === 3 && !ledgerExportResponse.body.includes('LP-B01'),
      `complete=${ledgerExport.export.complete} rows=${ledgerExport.export.rowCount} pages=${ledgerExport.export.pagesFetched}`);

    const restInvalidResponse = await fetch(`${MCP_URL}/api/v1/tools/search_investment_ledger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ size: 101 }),
    });
    const restInvalidBody = await restInvalidResponse.json();
    check('L5', '台账 REST 与 MCP 共用参数边界：size=101 返回400 INVALID_ARGUMENT',
      restInvalidResponse.status === 400 && restInvalidBody.success === false && restInvalidBody.code === 'INVALID_ARGUMENT',
      `status=${restInvalidResponse.status} code=${restInvalidBody.code}`);

    // ===== 验收项4：双账号行级权限隔离（账号B: E2002 看到更多行） =====
    const tokenB = mintToken({ employeeNo: 'E2002', sub: 'user-b-uuid' });
    const initB = await mcpInitialize(tokenB);
    const callB = await mcpCallTool(tokenB, initB.sid, 'search_office', { current: 1, size: 15 });
    const aSeesOne = String(dataA || '').includes('OF-001') && !String(dataA || '').includes('OF-002');
    const bSeesTwo = callB.body.includes('OF-001') && callB.body.includes('OF-002');
    check(4, '双账号行级权限隔离：A只见1行、B见2行（按员工编号透传）',
      initB.status === 200 && aSeesOne && bSeesTwo,
      `A只见OF-001=${aSeesOne}; B见OF-001+OF-002=${bSeesTwo}`);

    const ledgerBResponse = await mcpCallTool(tokenB, initB.sid, 'search_investment_ledger', { view: 'raw' });
    check('L4', '在投业务台账双账号行级隔离：B可见LP-B01且不见LP-A02',
      ledgerBResponse.body.includes('LP-B01') && !ledgerBResponse.body.includes('LP-002'),
      `B台账含LP-B01=${ledgerBResponse.body.includes('LP-B01')} 含LP-002=${ledgerBResponse.body.includes('LP-002')}`);

    // 会话身份绑定：用 B 的会话 + A 的令牌调用，必须 401
    const hijack = await mcpCallTool(tokenA, initB.sid, 'search_office', {}, 99);
    check('4b', '会话劫持防护：他人令牌复用已有会话被拒',
      hijack.status === 401, `status=${hijack.status}`);

    // ===== 验收项3：错误/过期/篡改凭证拒绝 =====
    const badSig = tokenA.slice(0, -3) + 'abc'; // 篡改签名
    const r1 = await mcpInitialize(badSig);
    const expired = mintToken({ employeeNo: 'E1001', sub: 'user-a-uuid', ttl: -600 });
    const r2 = await mcpInitialize(expired);
    const wrongAud = mintToken({ employeeNo: 'E1001', sub: 'user-a-uuid', aud: 'some-other-app' });
    const r3 = await mcpInitialize(wrongAud);
    check(3, '错误/过期/错误aud 凭证均被 401 拒绝且不泄漏细节',
      r1.status === 401 && r2.status === 401 && r3.status === 401 &&
      !r1.body.includes('stack') && !r2.body.includes('Traceback'),
      `badSig=${r1.status} expired=${r2.status} wrongAud=${r3.status}`);

    // 员工编号不可伪造：无 employeeNumber claim 的令牌 → 401
    const noClaim = signJwt({ iss: IDP_ISSUER, aud: CLIENT_ID, sub: 'x', exp: now() + 600, azp: CLIENT_ID });
    const r4 = await mcpInitialize(noClaim);
    check('3b', '缺少员工编号 Claim 的令牌被拒（不信任入参/未签名头）',
      r4.status === 401, `status=${r4.status}`);

    // ===== 验收项5：重启后配置生效 =====
    await kill(child);
    child = startMcpServer({ RATE_LIMIT_RPS: '2' }, auditPath);
    const up2 = await waitHttp(`${MCP_URL}/health`);
    let restartOk = up2;
    if (up2) {
      // 限流 2 rps：连续 6 个匿名请求，应出现 429
      const codes = [];
      for (let i = 0; i < 6; i++) {
        const r = await fetch(`${MCP_URL}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        codes.push(r.status);
      }
      restartOk = codes.includes(429);
      check(5, '重启后配置生效：RATE_LIMIT_RPS=2 下匿名请求触发 429',
        restartOk, `响应码序列=${codes.join(',')}`);
    } else {
      check(5, '重启后配置生效', false, '重启后 /health 不可达');
    }

    // ===== 方案 A' 验证（AUTH_MODE=oauth2-userinfo，feature flag 回滚路径） =====
    await kill(child);
    child = startMcpServer({
      AUTH_MODE: 'oauth2-userinfo',
      MAXKEY_JWKS_URL: '',
    }, auditPath);
    const up3 = await waitHttp(`${MCP_URL}/health`);
    let aprimeOk = false;
    if (up3) {
      const tA2 = mintToken({ employeeNo: 'E1001', sub: 'user-a-uuid' });
      const initA2 = await mcpInitialize(tA2);
      const callA2 = await mcpCallTool(tA2, initA2.sid, 'search_office', {});
      const bad = await mcpInitialize('opaque-invalid-token');
      aprimeOk = initA2.status === 200 && callA2.status === 200 && callA2.body.includes('OF-001') && bad.status === 401;
      check("A'", "方案A'(userinfo)：有效opaque风格令牌通过、无效令牌拒绝",
        aprimeOk, `init=${initA2.status} tool含OF-001=${callA2.body.includes('OF-001')} 无效令牌=${bad.status}`);
    } else {
      check("A'", '方案A\'(userinfo) 启动', false, 'AUTH_MODE=oauth2-userinfo 启动失败');
    }

    // ===== 验收项6：审计日志可追踪且不含敏感信息 =====
    const auditLines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const starts = auditLines.filter(e => e.event === 'server_start').length;
    const toolCalls = auditLines.filter(e => e.event === 'tool_call');
    const authFails = auditLines.filter(e => e.event === 'auth_fail');
    const empHashes = [...new Set(toolCalls.map(e => e.employeeNoHash).filter(Boolean))];
    const hasPlainEmployee = auditLines.some(e => JSON.stringify(e).includes('E1001') || JSON.stringify(e).includes('E2002'));
    const hasToken = auditLines.some(e => {
      const s = JSON.stringify(e);
      return s.includes(tokenA) || s.includes('Bearer eyJ') || s.toLowerCase().includes('cookie') || s.toLowerCase().includes('password');
    });
    const okToolAudit = toolCalls.length >= 2 && empHashes.length === 2 && toolCalls.every(e => e.tool && e.status && e.clientId);
    check(6, '审计日志可追踪：两次成功调用、双员工哈希、失败留痕；无明文员工编号/令牌/密码',
      starts >= 2 && okToolAudit && authFails.length >= 4 && !hasPlainEmployee && !hasToken,
      `start=${starts} tool_call=${toolCalls.length} 员工哈希数=${empHashes.length} auth_fail=${authFails.length} 明文泄漏=${hasPlainEmployee || hasToken}`);

    // 适配层服务认证证据：每次调用都带服务JWT与员工编号
    const svcOk = adapterCalls.length >= 2 && adapterCalls.every(c => c.hasSvcJwt && c.emp && c.reqId);
    check('6b', '适配层调用均携带服务 JWT + X-Employee-No + X-Request-Id',
      svcOk, `adapter调用=${adapterCalls.length}，样例=${JSON.stringify(adapterCalls[0] || {})}`);

    // ===== 快照模式（LEDGER_DATA_MODE=snapshot）：真实 HTTP + mock IdP + 双员工 =====
    // 快照来自 repair-ledger-data 的 data/current.json 结构；ACL 用显式夹具代行 OA 行级权限。
    await kill(child);
    const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgs-oa-mcp-snapshot-'));
    const snapPath = path.join(snapDir, 'current.json');
    const aclPath = path.join(snapDir, 'acl.json');
    const snapRow = (id, projectid, projectnm, actsts = '1') => ({
      ...ledgerBase, actbasid: id, projectid, projectnm, actsts,
    });
    const snapRows = [
      snapRow('SA-001', 'SP-A01', '快照项目A1'),
      snapRow('SA-002', 'SP-A02', '快照项目A2', '2'),
      snapRow('SA-003', 'SP-A03', '快照项目A3'),
      snapRow('SB-001', 'SP-B01', '快照项目B1'),
      snapRow('SB-002', 'SP-B02', '快照项目B2'),
      snapRow('SS-001', 'SP-S01', '快照共享项目'),
    ];
    fs.writeFileSync(snapPath, JSON.stringify({
      schemaVersion: 1,
      source: { environment: 'test', menu: ['统一数据管理', '投后数据统计', '在投业务台账', '在投业务台账列表'], endpoint: '/oamgr/SGMGR/sgproj/sgproj/list?type=1' },
      fetchedAt: '2026-11-11T07:50:21.700Z',
      integrity: { reportedTotal: snapRows.length, rowCount: snapRows.length, totalMatchesRowCount: true },
      rows: snapRows,
    }));
    fs.writeFileSync(aclPath, JSON.stringify({
      schemaVersion: 1,
      // 夹具，仅代行 OA 行级权限；口径待 G-8 裁决，不是生产 ACL
      employees: { 'E1001': ['SA-001', 'SA-002', 'SS-001'], 'E2002': ['SB-001', 'SB-002', 'SS-001'] },
    }));

    child = startMcpServer({
      LEDGER_DATA_MODE: 'snapshot',
      LEDGER_SNAPSHOT_PATH: snapPath,
      LEDGER_SNAPSHOT_ACL_PATH: aclPath,
    }, auditPath);
    const up4 = await waitHttp(`${MCP_URL}/health`);
    let healthSnap = null;
    if (up4) healthSnap = await fetch(`${MCP_URL}/health`).then(r => r.json());
    check('S1', '快照模式 /health 明示 snapshot 且 realtime=false、回快照版本/行数、不回显文件路径',
      !!healthSnap && healthSnap.dataMode === 'snapshot' && healthSnap.realtime === false &&
      healthSnap.snapshot?.available === true && healthSnap.snapshot?.rowCount === 6 &&
      !!healthSnap.snapshot?.fetchedAt && !JSON.stringify(healthSnap).includes(snapDir),
      `health=${JSON.stringify(healthSnap)}`);

    const initSnapA = await mcpInitialize(tokenA);
    const snapSearchA = await mcpCallTool(tokenA, initSnapA.sid, 'search_investment_ledger', { current: 1, size: 2, view: 'both' });
    const snapPayloadA = toolPayload(snapSearchA);
    check('S2', '快照模式按已验证身份返回 49 列 display、分页与 total 一致（员工A：3 行）',
      snapSearchA.status === 200 && snapPayloadA.pagination.total === 3 &&
      snapPayloadA.pagination.totalPages === 2 && snapPayloadA.rows.length === 2 &&
      Object.keys(snapPayloadA.rows[0].display).length === 49 &&
      snapPayloadA._meta.dataMode === 'snapshot' && snapPayloadA._meta.realtime === false,
      `total=${snapPayloadA.pagination.total} rows=${snapPayloadA.rows.length} display49=${Object.keys(snapPayloadA.rows[0].display).length} meta=${JSON.stringify(snapPayloadA._meta)}`);

    // 过滤器 + 分页在快照上仍生效，且不能越过 ACL
    const snapFilter = await mcpCallTool(tokenA, initSnapA.sid, 'search_investment_ledger', { projectnm: '快照项目A2', view: 'raw' });
    const snapFilterPayload = toolPayload(snapFilter);
    const snapCrossFilter = await mcpCallTool(tokenA, initSnapA.sid, 'search_investment_ledger', { projectnm: '快照项目B1', view: 'raw' });
    const snapCrossPayload = toolPayload(snapCrossFilter);
    check('S3', '快照筛选取交集：A 能筛到本人项目，筛 B 的项目返回 0 行',
      snapFilterPayload.pagination.total === 1 && snapFilterPayload.rows[0].actbasid === 'SA-002' &&
      snapCrossPayload.pagination.total === 0,
      `A筛A2=${snapFilterPayload.pagination.total} A筛B1=${snapCrossPayload.pagination.total}`);

    const initSnapB = await mcpInitialize(tokenB);
    const snapSearchB = await mcpCallTool(tokenB, initSnapB.sid, 'search_investment_ledger', { view: 'raw', size: 100 });
    const snapPayloadB = toolPayload(snapSearchB);
    const bIds = (snapPayloadB.rows || []).map(r => r.actbasid).sort();
    check('S4', '快照模式双员工按同一 ACL 规则隔离：B 见 SB-*/SS-001，不见 SA-*',
      snapPayloadB.pagination.total === 3 && JSON.stringify(bIds) === JSON.stringify(['SB-001', 'SB-002', 'SS-001']) &&
      !snapSearchB.body.includes('SA-001'),
      `A total=${snapPayloadA.pagination.total} / B total=${snapPayloadB.pagination.total} B ids=${bIds.join(',')}`);

    // body 自报身份必须被忽略：A 的令牌 + body 声明 E2002
    const spoof = await fetch(`${MCP_URL}/api/v1/tools/search_investment_ledger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tokenA },
      body: JSON.stringify({ view: 'raw', size: 100, employeeNo: 'E2002', employees: ['E2002'], acl: 'all' }),
    });
    const spoofBody = await spoof.json();
    const spoofIds = (spoofBody.data?.rows || []).map(r => r.actbasid).sort();
    check('S5', '普通员工 body 自报员工号被忽略：A 的令牌 + body employeeNo=E2002 仍只返回 A 的数据',
      spoof.status === 200 && JSON.stringify(spoofIds) === JSON.stringify(['SA-001', 'SA-002', 'SS-001']),
      `status=${spoof.status} ids=${spoofIds.join(',')}`);

    // ACL 未覆盖的员工 → 403 PERMISSION_DENIED（不是空结果，也不是全部数据）
    const strangerToken = mintToken({ employeeNo: 'E3003', sub: 'user-c-uuid' });
    const stranger = await fetch(`${MCP_URL}/api/v1/tools/search_investment_ledger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + strangerToken },
      body: JSON.stringify({ view: 'raw' }),
    });
    const strangerBody = await stranger.json();
    check('S6', '快照 ACL 未覆盖的员工返回 403 PERMISSION_DENIED（fail-closed）',
      stranger.status === 403 && strangerBody.code === 'PERMISSION_DENIED' && !JSON.stringify(strangerBody).includes('SA-001'),
      `status=${stranger.status} code=${strangerBody.code}`);

    const snapExport = await mcpCallTool(tokenA, initSnapA.sid, 'export_investment_ledger', { view: 'raw', maxRows: 10 });
    const snapExportPayload = toolPayload(snapExport);
    check('S7', '快照全量导出只含本人可见行且标注非实时',
      snapExportPayload.export.complete === true && snapExportPayload.export.rowCount === 3 &&
      snapExportPayload._meta.realtime === false &&
      !snapExport.body.includes('SB-001'),
      `complete=${snapExportPayload.export.complete} rowCount=${snapExportPayload.export.rowCount}`);

  } finally {
    await kill(child);
    idpServer.close();
    adapterServer.close();
  }

  // ===== 总结 =====
  const passed = results.filter(r => r.pass).length;
  console.log(`\n===== E2E 结果：${passed}/${results.length} 通过 =====`);
  const reportPath = path.join(REPO, 'test', 'e2e-result.json');
  fs.writeFileSync(reportPath, JSON.stringify({ ts: new Date().toISOString(), results }, null, 2));
  console.log(`报告: ${reportPath}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => {
  console.error('E2E fatal:', e);
  process.exit(2);
});

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

    // ===== 验收项4：双账号行级权限隔离（账号B: E2002 看到更多行） =====
    const tokenB = mintToken({ employeeNo: 'E2002', sub: 'user-b-uuid' });
    const initB = await mcpInitialize(tokenB);
    const callB = await mcpCallTool(tokenB, initB.sid, 'search_office', { current: 1, size: 15 });
    const aSeesOne = String(dataA || '').includes('OF-001') && !String(dataA || '').includes('OF-002');
    const bSeesTwo = callB.body.includes('OF-001') && callB.body.includes('OF-002');
    check(4, '双账号行级权限隔离：A只见1行、B见2行（按员工编号透传）',
      initB.status === 200 && aSeesOne && bSeesTwo,
      `A只见OF-001=${aSeesOne}; B见OF-001+OF-002=${bSeesTwo}`);

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

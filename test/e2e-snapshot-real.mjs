#!/usr/bin/env node
/**
 * 内网快照验收（真实数据）：LEDGER_DATA_MODE=snapshot + 真实 data/current.json + mock MaxKey IdP + 双员工
 *
 * 与 e2e.mjs 的区别：e2e.mjs 用合成夹具做 CI 回归；本脚本用 repair-ledger-data 产出的真实快照
 * （3387 行 / 49 列），在 127.0.0.1 上走真实 HTTP，验证：
 *   R1 /health 明示 snapshot 非实时、行数与快照版本一致、不回显路径
 *   R2 已验证身份 → 49 列 display + 分页 + total
 *   R3 双员工按同一 ACL 规则隔离（含重叠行）
 *   R4 body 自报员工号被忽略
 *   R5 快照无字段的筛选项显式拒绝（不猜口径、不返回空集假装成功）
 *   R6 真实字段筛选/排序生效
 *   R7 审计日志无明文员工号、无令牌
 *   R8 49 列 display 与知识库文档逐格比对（全量 3387 条），量化残余差异
 *
 * 用法：node test/e2e-snapshot-real.mjs
 * 依赖：dist 已构建；环境自行设置 LEDGER_SNAPSHOT_REAL_PATH（默认 E 盘同步工程 data/current.json）
 */
import { createServer } from 'http';
import { generateKeyPairSync, createSign, createHash, randomBytes } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const IDP_PORT = 3221;
const MCP_PORT = 3220;
const IDP_ISSUER = `http://127.0.0.1:${IDP_PORT}/sign`;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}`;
const CLIENT_ID = 'mcp-snapshot-client';
const KID = 'maxkey_rsa_snapshot';

const SNAPSHOT_PATH = process.env.LEDGER_SNAPSHOT_REAL_PATH
  || 'E:/项目/山钢/数智办公/ledger-knowledge-sync/data/current.json';
const DOC_DIR = process.env.LEDGER_DOC_DIR
  || 'E:/项目/山钢/数智办公/ledger-knowledge-sync/data/documents';

const results = [];
function check(id, name, pass, evidence) {
  results.push({ id, name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${name} :: ${evidence}`);
}

// ---------- mock MaxKey IdP（真 RSA + JWKS） ----------
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubJwk = publicKey.export({ format: 'jwk' });
pubJwk.kid = KID; pubJwk.alg = 'RS256'; pubJwk.use = 'sig';

const b64url = buf => Buffer.from(buf).toString('base64url');
const nowSec = () => Math.floor(Date.now() / 1000);

function mintToken({ employeeNo, sub, ttl = 900 }) {
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }));
  const p = b64url(JSON.stringify({
    iss: IDP_ISSUER, aud: CLIENT_ID, sub, exp: nowSec() + ttl, iat: nowSec(), nbf: nowSec() - 1,
    employeeNumber: employeeNo, azp: CLIENT_ID,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${h}.${p}`);
  return `${h}.${p}.${b64url(signer.sign(privateKey))}`;
}

const idpServer = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/sign/jwks') return res.end(JSON.stringify({ keys: [pubJwk] }));
  if (req.url === '/sign/.well-known/openid-configuration') {
    return res.end(JSON.stringify({ issuer: IDP_ISSUER, jwks_uri: `${IDP_ISSUER}/jwks` }));
  }
  res.statusCode = 404;
  res.end('{}');
});

const baseEnv = (auditPath, extra) => ({
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  AUTH_MODE: 'oidc',
  MCP_PORT: String(MCP_PORT),
  MCP_BIND_ADDR: '127.0.0.1',
  MCP_PUBLIC_URL: MCP_URL,
  MAXKEY_ISSUER: IDP_ISSUER,
  MAXKEY_AUTHORIZE_URL: `${IDP_ISSUER}/authz/oauth/v20/authorize`,
  MAXKEY_TOKEN_URL: `${IDP_ISSUER}/authz/oauth/v20/token`,
  MAXKEY_USERINFO_URL: `${IDP_ISSUER}/api/oauth/v20/me`,
  MAXKEY_JWKS_URL: `${IDP_ISSUER}/jwks`,
  MCP_CLIENT_ID: CLIENT_ID,
  EMPLOYEE_NO_CLAIM: 'employeeNumber',
  AUDIT_LOG_PATH: auditPath,
  AUDIT_HASH_SALT: 'snapshot-acceptance-salt',
  RATE_LIMIT_RPS: '20',
  ...extra,
});

function startServer(auditPath, extra) {
  const child = spawn(process.execPath, [path.join(REPO, 'dist/index.js'), 'http'], {
    env: baseEnv(auditPath, extra), stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO,
  });
  child.stdout.on('data', d => process.stdout.write(`[mcp:out] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[mcp:err] ${d}`));
  return child;
}

async function waitHttp(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

const kill = child => new Promise(resolve => {
  if (!child) return resolve();
  child.once('exit', () => resolve());
  child.kill('SIGTERM');
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 2000);
});

const mcpInit = async token => {
  const r = await fetch(`${MCP_URL}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'snapshot-real', version: '1.0' } } }),
  });
  const sid = r.headers.get('mcp-session-id');
  await r.text();
  if (sid) {
    await fetch(`${MCP_URL}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  }
  return sid;
};

const mcpTool = async (token, sid, name, args) => {
  const r = await fetch(`${MCP_URL}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await r.text();
  const rpc = JSON.parse(body);
  if (rpc.error) throw new Error(JSON.stringify(rpc.error));
  if (!rpc.result?.content?.[0]?.text) throw new Error(`工具无结果: ${body.slice(0, 200)}`);
  return { status: r.status, body, payload: JSON.parse(rpc.result.content[0].text) };
};

const restTool = async (token, args) => {
  const r = await fetch(`${MCP_URL}/api/v1/tools/search_investment_ledger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  return { status: r.status, json: await r.json() };
};

// ---------- 文档比对：documents/<actbasid>.md 的 49 行表格 → {field: value} ----------
function parseDocTable(actbasid) {
  const file = path.join(DOC_DIR, `${actbasid}.md`);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([A-Za-z0-9_]+)\s*\|\s*([^|]*?)\s*\|\s*$/);
    if (!m) continue;
    const [, , field, value] = m;
    if (field === '字段名') continue;
    map[field] = value;
  }
  return Object.keys(map).length ? map : null;
}

// 报告里附上测试套件实测计数：unit 现场跑一遍（TAP 解析），e2e 读最近一次 test/e2e-result.json
function readSuites() {
  const suites = { tsc: { cmd: 'npx tsc --noEmit', note: '本脚本运行前须已通过类型检查' } };
  try {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(REPO, 'test/ledger.test.mjs')], { cwd: REPO, encoding: 'utf8' });
    const pass = /^# pass (\d+)/m.exec(r.stdout || '');
    const fail = /^# fail (\d+)/m.exec(r.stdout || '');
    suites.unit = { cmd: 'npm run test:unit', total: (Number(pass?.[1]) || 0) + (Number(fail?.[1]) || 0), pass: Number(pass?.[1]), fail: Number(fail?.[1]) };
  } catch {
    suites.unit = { cmd: 'npm run test:unit', note: '脚本内自检未运行' };
  }
  try {
    const e = JSON.parse(fs.readFileSync(path.join(REPO, 'test/e2e-result.json'), 'utf8'));
    suites.e2e = { cmd: 'npm run test:e2e', total: e.results.length, pass: e.results.filter(x => x.pass).length, fail: e.results.filter(x => !x.pass).length, report: 'test/e2e-result.json', ts: e.ts };
  } catch {
    suites.e2e = { cmd: 'npm run test:e2e', note: '未找到 test/e2e-result.json' };
  }
  return suites;
}

async function main() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    console.error(`FATAL: 快照不存在 ${SNAPSHOT_PATH}`);
    process.exit(2);
  }
  const rawSnapshot = fs.readFileSync(SNAPSHOT_PATH);
  const snapshot = JSON.parse(rawSnapshot.toString('utf8'));
  const snapshotVersion = createHash('sha256').update(rawSnapshot).digest('hex').slice(0, 12);
  const rows = snapshot.rows;
  console.log(`快照: ${rows.length} 行 / fetchedAt=${snapshot.fetchedAt} / version=${snapshotVersion} / ${rawSnapshot.length}B`);

  // 双员工：A 拿 6 行，B 拿其中后 3 行 + 另外 3 行（构造重叠，证明隔离不是「互不重叠的两份文件」）
  const ids = rows.map(r => r.actbasid).filter(Boolean);
  const idsA = ids.slice(0, 6);
  const idsB = [...ids.slice(3, 9)];
  const onlyA = idsA.filter(id => !idsB.includes(id));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgs-oa-snapshot-real-'));
  const auditPath = path.join(tmpDir, 'audit.log');
  const aclPath = path.join(tmpDir, 'acl.json');
  fs.writeFileSync(aclPath, JSON.stringify({
    schemaVersion: 1,
    employees: { 'E1001': idsA, 'E2002': idsB },
  }));

  await new Promise(r => idpServer.listen(IDP_PORT, r));
  let child = startServer(auditPath, {
    LEDGER_DATA_MODE: 'snapshot',
    LEDGER_SNAPSHOT_PATH: SNAPSHOT_PATH,
    LEDGER_SNAPSHOT_ACL_PATH: aclPath,
  });
  if (!await waitHttp(`${MCP_URL}/health`)) { console.error('FATAL: server not up'); process.exit(2); }

  try {
    // R1 健康检查
    const health = await fetch(`${MCP_URL}/health`).then(r => r.json());
    check('R1', '快照模式 /health 明示 snapshot/非实时/行数与版本，且不回显文件路径',
      health.dataMode === 'snapshot' && health.realtime === false &&
      health.adapter === null && health.snapshot?.available === true &&
      health.snapshot?.rowCount === rows.length && health.snapshot?.version === snapshotVersion &&
      health.snapshot?.fetchedAt === snapshot.fetchedAt &&
      !JSON.stringify(health).includes('ledger-knowledge-sync') &&
      !JSON.stringify(health).includes(tmpDir),
      `dataMode=${health.dataMode} realtime=${health.realtime} rowCount=${health.snapshot?.rowCount} version=${health.snapshot?.version} fetchedAt=${health.snapshot?.fetchedAt}`);

    const tokenA = mintToken({ employeeNo: 'E1001', sub: 'user-a-uuid' });
    const tokenB = mintToken({ employeeNo: 'E2002', sub: 'user-b-uuid' });
    const sidA = await mcpInit(tokenA);
    const sidB = await mcpInit(tokenB);

    // R2 49 列 display + 分页
    const a1 = await mcpTool(tokenA, sidA, 'search_investment_ledger', { current: 1, size: 4, view: 'both' });
    const dispKeys = Object.keys(a1.payload.rows[0].display).length;
    const realFirst = rows.find(r => r.actbasid === idsA[0]);
    check('R2', '真实数据：分页 total/totalPages 与 ACL 可见集一致，display 保持 49 列，_meta 标注非实时',
      a1.payload.pagination.total === idsA.length && a1.payload.pagination.totalPages === Math.ceil(idsA.length / 4) &&
      a1.payload.rows.length === 4 && dispKeys === 49 &&
      a1.payload.rows[0].raw.actbasid === idsA[0] &&
      a1.payload.rows[0].display.projectnm === (realFirst.projectnm || '') &&
      a1.payload._meta.version === undefined && a1.payload._meta.snapshotVersion === snapshotVersion &&
      a1.payload._meta.realtime === false && a1.payload._meta.dataMode === 'snapshot',
      `total=${a1.payload.pagination.total}/${idsA.length} pages=${a1.payload.pagination.totalPages} display=${dispKeys} version=${a1.payload._meta.snapshotVersion}`);

    // R3 双员工隔离（含重叠行）
    const bAll = await mcpTool(tokenB, sidB, 'search_investment_ledger', { view: 'raw', size: 100 });
    const bIds = bAll.payload.rows.map(r => r.actbasid);
    const leakedA = onlyA.filter(id => bAll.body.includes(id));
    const aAll = await mcpTool(tokenA, sidA, 'search_investment_ledger', { view: 'raw', size: 100 });
    const aIds = aAll.payload.rows.map(r => r.actbasid);
    check('R3', '真实数据：双员工按同一 ACL 规则隔离，重叠行双方可见、A 独占行不出现在 B 结果',
      bAll.payload.pagination.total === idsB.length && aAll.payload.pagination.total === idsA.length &&
      JSON.stringify(aIds) === JSON.stringify(idsA) && JSON.stringify(bIds) === JSON.stringify(idsB) &&
      leakedA.length === 0,
      `A=${aIds.length}行 B=${bIds.length}行 重叠=${idsA.filter(i => idsB.includes(i)).length} B含A独占=${leakedA.length}`);

    // R4 body 自报身份被忽略
    const spoof = await restTool(tokenA, { view: 'raw', size: 100, employeeNo: 'E2002', employees: ['E2002'] });
    const spoofIds = (spoof.json.data?.rows || []).map(r => r.actbasid);
    check('R4', '普通员工 body 自报 employeeNo=E2002 被忽略，仍按 JWT 身份返回 A 的数据',
      spoof.status === 200 && JSON.stringify(spoofIds) === JSON.stringify(idsA),
      `status=${spoof.status} rows=${spoofIds.length} 与A一致=${JSON.stringify(spoofIds) === JSON.stringify(idsA)}`);

    // R5 快照无法等价实现的筛选 → 显式 400（不是静默空集，也不是猜口径）
    const comp = await restTool(tokenA, { view: 'raw', compcusnm: '山钢' });
    const deal = await restTool(tokenA, { view: 'raw', dealdate: '2026-11-11' });
    check('R5', '快照无口径的筛选项（compcusnm/dealdate）返回 400 INVALID_ARGUMENT 并说明原因',
      comp.status === 400 && comp.json.code === 'INVALID_ARGUMENT' && /snapshot 模式不支持 compcusnm/.test(comp.json.error) &&
      deal.status === 400 && deal.json.code === 'INVALID_ARGUMENT',
      `compcusnm=${comp.status}/${comp.json.code} dealdate=${deal.status}/${deal.json.code}`);

    // R6 真实字段筛选 + 排序
    const sampleName = String(rows.find(r => r.actbasid === idsA[1])?.projectnm || '');
    const needle = sampleName.slice(0, Math.min(6, sampleName.length));
    const filtered = await restTool(tokenA, { view: 'raw', size: 100, projectnm: needle });
    const fRows = filtered.json.data?.rows || [];
    const allMatch = fRows.every(r => String(r.projectnm || '').includes(needle));
    const sorted = await restTool(tokenA, { view: 'raw', size: 100, sort: 'projamt', order: 'desc' });
    const amts = (sorted.json.data?.rows || []).map(r => Number(r.projamt) || 0);
    const descOk = amts.every((v, i) => i === 0 || amts[i - 1] >= v);
    check('R6', '真实数据：projectnm 包含匹配命中所选记录，sort=projamt desc 单调不增，结果不出 ACL 范围',
      needle.length > 0 && fRows.length >= 1 && allMatch &&
      fRows.every(r => idsA.includes(r.actbasid)) && descOk && amts.length === idsA.length,
      `needle="${needle}" 命中=${fRows.length} 全包含=${allMatch} desc单调=${descOk}`);

    // R7 审计：无明文员工号、无令牌
    const audit = fs.readFileSync(auditPath, 'utf8');
    const hashes = new Set();
    for (const line of audit.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e.employeeNoHash) hashes.add(e.employeeNoHash); } catch {}
    }
    const leaks = ['E1001', 'E2002', tokenA.slice(0, 24), tokenB.slice(0, 24), 'Bearer '].filter(s => audit.includes(s));
    check('R7', '审计日志：双员工各一哈希、无明文员工号、无令牌片段',
      hashes.size === 2 && leaks.length === 0 && audit.includes('tool_call'),
      `员工哈希=${hashes.size} 明文命中=${leaks.length} 行数=${audit.split(/\r?\n/).filter(Boolean).length}`);

    // R8 49 列 display 与知识库文档逐格比对（全量 3387 条）
    // 归一化口径（写进报告）：
    //   - 文档侧「（页面列，上游本期无值）」= 页面无值标注，等价于 API 的 null/空串
    //   - 仅空白差异（首尾空格）单列，不计入值差异
    //   - 「未披露」只在两侧都表示缺值时可等价；若 API 仍输出「0 元」则为值缺陷
    const SENTINEL = '（页面列，上游本期无值）';
    const category = (docValue, apiValue) => {
      const d = docValue === undefined ? '' : String(docValue);
      const a = apiValue === null || apiValue === undefined ? '' : String(apiValue);
      if (d === a) return 'exact';
      if (d === SENTINEL && a === '') return 'doc-sentinel';
      if (d.trim() === a.trim()) return 'whitespace-only';
      if (d === '未披露' && /^0 元$/.test(a)) return 'undisclosed-vs-zero';
      if (d === '未披露' && a === '') return 'undisclosed-vs-empty';
      return 'value-differs';
    };

    const { exportInvestmentLedger } = await import('../dist/api/ledger.js');
    const { loadConfig } = await import('../dist/config.js');
    const offlineCfg = loadConfig({
      AUTH_MODE: 'oidc', MCP_PORT: '1', MCP_BIND_ADDR: '127.0.0.1', MCP_PUBLIC_URL: MCP_URL,
      MAXKEY_ISSUER: IDP_ISSUER, MAXKEY_AUTHORIZE_URL: `${IDP_ISSUER}/a`, MAXKEY_TOKEN_URL: `${IDP_ISSUER}/t`,
      MAXKEY_JWKS_URL: `${IDP_ISSUER}/jwks`, MCP_CLIENT_ID: CLIENT_ID,
      LEDGER_DATA_MODE: 'snapshot', LEDGER_SNAPSHOT_PATH: SNAPSHOT_PATH, LEDGER_SNAPSHOT_ACL_PATH: aclPath,
      AUDIT_LOG_PATH: auditPath, AUDIT_HASH_SALT: 'snapshot-acceptance-salt',
    });
    const fullAcl = path.join(tmpDir, 'acl-full.json');
    fs.writeFileSync(fullAcl, JSON.stringify({ schemaVersion: 1, employees: { 'E1001': ids } }));
    const full = await exportInvestmentLedger({ ...offlineCfg, ledgerSnapshotAclPath: fullAcl }, { employeeNo: 'E1001', sub: 'x' }, { view: 'both' }, 'offline-r8');

    const counts = { exact: 0, 'doc-sentinel': 0, 'whitespace-only': 0, 'undisclosed-vs-zero': 0, 'undisclosed-vs-empty': 0, 'value-differs': 0, 'doc-missing-field': 0 };
    const samples = {};
    let cellsCompared = 0, docsCompared = 0, docsMissing = 0;
    for (const row of full.rows) {
      const docMap = parseDocTable(row.raw.actbasid);
      if (!docMap) { docsMissing++; continue; }
      docsCompared++;
      for (const [field, value] of Object.entries(row.display)) {
        cellsCompared++;
        if (!(field in docMap)) {
          counts['doc-missing-field']++;
          samples['doc-missing-field'] ||= `${row.raw.actbasid} ${field}=${JSON.stringify(value)}`;
          continue;
        }
        const cat = category(docMap[field], value);
        counts[cat]++;
        if (cat !== 'exact' && cat !== 'doc-sentinel' && cat !== 'whitespace-only' && !samples[cat]) {
          samples[cat] = `${row.raw.actbasid} ${field}: doc=${JSON.stringify(docMap[field])} api=${JSON.stringify(value)}`;
        }
      }
    }
    const unexplained = counts['value-differs'] + counts['undisclosed-vs-zero'] + counts['undisclosed-vs-empty'] + counts['doc-missing-field'];
    console.log(`[R8] 全量比对：文档 ${docsCompared} 篇（缺 ${docsMissing}），单元格 ${cellsCompared}`);
    console.log(`[R8] 分类：${JSON.stringify(counts)}`);
    for (const [k, v] of Object.entries(samples)) console.log(`      ${k}: ${v}`);
    check('R8', '49 列 display 与知识库文档逐格比对（全量 3387 篇 × 49 列），未解释差异为 0',
      docsCompared === rows.length && cellsCompared === rows.length * 49 && unexplained === 0,
      `文档=${docsCompared} 单元格=${cellsCompared} 完全一致=${counts.exact} 文档标注列=${counts['doc-sentinel']} 仅空白=${counts['whitespace-only']} 未解释=${unexplained}`);

    // 导出完整性（快照模式自动翻页到空页）
    check('R9', '快照全量导出完整（complete=true，含终页空页证据），只含本人可见行',
      full.export.complete === true && full.export.terminalEmptyPage === true &&
      full.export.rowCount === ids.length && full._meta.realtime === false,
      `complete=${full.export.complete} rowCount=${full.export.rowCount}/${ids.length} terminalEmptyPage=${full.export.terminalEmptyPage}`);

    const summary = {
      generatedAt: new Date().toISOString(),
      node: 'dag:ledger-mcp-wecom/mcp-snapshot-deploy',
      workspace: REPO,
      change: {
        env: 'LEDGER_DATA_MODE=adapter|snapshot（默认 adapter；快照必须显式配置，无自动回退）',
        newEnv: [
          'LEDGER_SNAPSHOT_PATH（默认 ./data/current.json）',
          'LEDGER_SNAPSHOT_ACL_PATH（snapshot 必填，fail-closed）',
          'MCP_BIND_ADDR 补入 .env.example',
        ],
      },
      snapshot: {
        path: SNAPSHOT_PATH,
        sha256_12: snapshotVersion,
        rowCount: rows.length,
        fetchedAt: snapshot.fetchedAt,
        bytes: rawSnapshot.length,
        producer: 'repair-ledger-data',
      },
      bind: `127.0.0.1:${MCP_PORT}`,
      authMode: 'oidc',
      identitySource: 'MaxKey 员工令牌 claim（body/入参自报 employeeNo 一律忽略）',
      dataMode: 'snapshot',
      realtime: false,
      acl: {
        mechanism: '显式夹具 LEDGER_SNAPSHOT_ACL_PATH，按已验证身份的 employeeNo 取 actbasid 白名单',
        unlistedEmployee: '403 PERMISSION_DENIED（fail-closed）',
        emptyAllowList: '0 行（合法，不是拒绝）',
        businessCaliber: '行级权限口径（机构/经办人/项目组）属 G-8，本节点不自行选定',
      },
      employees: {
        roleA: { label: '员工A', aclRows: idsA.length },
        roleB: { label: '员工B', aclRows: idsB.length },
        overlapRows: idsA.filter(i => idsB.includes(i)).length,
        note: '员工编号为验收夹具，非真实员工；审计日志只落哈希',
      },
      testSuites: readSuites(),
      checks: results,
      docComparison: { docsCompared, docsMissing, cellsCompared, counts, unexplained },
      fixedInThisNode: [
        'F4-MCP：金额缺值不再渲染「0 元」，改「未披露」（与页面/知识库口径一致；0 元仅表示确定为零）',
      ],
      openGates: [
        'G-7：真实 OA 适配层未连通，adapter 模式数据验收仍 HOLD（快照不解除本门）',
        'G-8：行级 ACL 业务口径（机构/经办人/项目组）未裁决，快照用夹具代行',
        'MaxKey 委托契约未核实：未新增「信任 body 员工号」路径，桥接未改',
        '第三方身份/对外暴露：仍未批，MCP_BIND_ADDR 保持 127.0.0.1',
      ],
      passed: results.filter(r => r.pass).length,
      total: results.length,
    };
    const outPath = path.join(REPO, 'states', 'mcp-snapshot-deploy.json');
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`\n===== 内网快照验收：${summary.passed}/${summary.total} 通过 =====`);
    console.log(`报告: ${outPath}`);
    process.exitCode = summary.passed === summary.total ? 0 : 1;
  } finally {
    await kill(child);
    idpServer.close();
  }
}

main().catch(err => { console.error('FATAL', err); process.exit(2); });

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../dist/config.js';
import { searchInvestmentLedger, exportInvestmentLedger, getInvestmentLedgerSchema } from '../dist/api/ledger.js';
import { toLedgerDisplayRow, LEDGER_COLUMNS } from '../dist/api/ledgerSchema.js';

const identity = { employeeNo: 'E1001', subject: 'unit-a', clientId: 'unit-test', raw: {} };

const REPO = fileURLToPath(new URL('..', import.meta.url));

// 取一个当前空闲的本机端口（先绑定再释放，避免与其它用例抢端口）
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer(() => {});
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// 以真实进程启动 dist/index.js（HTTP 模式），等 /health 可用后交给用例，结束后回收。
async function withRunningServer(env, run) {
  const port = await freePort();
  const child = spawn(process.execPath, ['dist/index.js', 'http'], {
    cwd: REPO,
    env: { ...process.env, ...env, MCP_PORT: String(port), MCP_BIND_ADDR: env.MCP_BIND_ADDR || '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`服务提前退出 (exit=${child.exitCode}): ${stderr}`);
      try {
        const probe = await fetch(`${baseUrl}/health`);
        if (probe.status === 200) { await probe.text(); break; }
      } catch { /* 尚未监听 */ }
      if (Date.now() > deadline) throw new Error(`服务未在 20s 内就绪: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return await run(baseUrl);
  } finally {
    child.kill();
  }
}

function config(port, extra = {}) {
  return loadConfig({
    MCP_PORT: '3000',
    MCP_PUBLIC_URL: 'http://127.0.0.1:3000',
    AUTH_MODE: 'oidc',
    MAXKEY_ISSUER: 'http://127.0.0.1:3101/sign',
    MAXKEY_AUTHORIZE_URL: 'http://127.0.0.1:3101/sign/authorize',
    MAXKEY_TOKEN_URL: 'http://127.0.0.1:3101/sign/token',
    MAXKEY_JWKS_URL: 'http://127.0.0.1:3101/sign/jwks',
    MCP_CLIENT_ID: 'unit-test',
    OA_ADAPTER_URL: `http://127.0.0.1:${port}`,
    OA_ADAPTER_SERVICE_JWT: 'unit-test-only',
    LEDGER_EXPORT_PAGE_SIZE: '2',
    LEDGER_EXPORT_MAX_ROWS: '10',
    ...extra,
  });
}

async function withAdapter(handler, run) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      calls.push({ url: req.url, body: JSON.parse(body || '{}'), employeeNo: req.headers['x-employee-no'] });
      res.setHeader('content-type', 'application/json');
      Promise.resolve(handler(calls.at(-1))).then(result => {
        res.statusCode = result.status || 200;
        res.end(JSON.stringify(result.body));
      }).catch(error => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error.message }));
      });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run({ port, calls });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const baseRow = {
  actbasid: 'A-001', projectid: 'P-001', cusid: 'C-001', projectnm: '测试项目',
  projamt: 10000, avlblc: 8000, takeamt: 2000, realpayint: 16.675,
  projectno: '', projtype: '0', sgtype: '12', actsts: '1', biztype: '1',
  rettyp: '1', repaycapital: undefined, yield: 0,
};

test('schema contains all 49 page columns and stable filter/dictionary contracts', () => {
  const schema = getInvestmentLedgerSchema();
  assert.equal(LEDGER_COLUMNS.length, 49);
  assert.equal(new Set(LEDGER_COLUMNS.map(c => c.field)).size, 49);
  assert.equal(schema.columns.length, 49);
  assert.deepEqual(schema.codeSets.SG002, { '1': '正常', '2': '逾期', '3': '已结清' });
  assert.equal(schema.filters.length, 8);
});

test('display mapping preserves page formulas, units, raw-code fallback and duplicate columns', () => {
  const display = toLedgerDisplayRow(baseRow);
  assert.equal(Object.keys(display).length, 49);
  assert.equal(display.projamt, '10,000 元');
  assert.equal(display.placeholder_199, '10,000 元');
  assert.equal(display.placeholder_200, '8,000 元');
  assert.equal(display.placeholder_201, '2,000 元');
  assert.equal(display.placeholder_202, '16.68 元');
  assert.equal(display.placeholder_203, '8,000 元');
  assert.equal(display.repaycapital, '0 元');
  assert.equal(display.projtype, '保理 0');
  assert.equal(display.actsts, '正常');
  assert.equal(display.biztype, '内部业务');
  assert.equal(display.rettyp, '利随本清');
  assert.equal(display.yield, '0 %');
  assert.equal(toLedgerDisplayRow({ ...baseRow, rettyp: undefined, inttyp: undefined }).rettyp, ', ');
});

test('search returns raw+display rows and forwards filters without employee input', async () => {
  await withAdapter(call => ({
    body: { total: 1, rows: [{ ...baseRow, cusnm: call.body.cusnm }] },
  }), async ({ port, calls }) => {
    const result = await searchInvestmentLedger(config(port), identity, {
      cusnm: '某客户', current: 1, size: 1, actsts: '1', view: 'both', employeeNo: 'FORGED',
    }, 'req-search');
    assert.equal(result.pagination.total, 1);
    assert.equal(result.rows[0].raw.cusnm, '某客户');
    assert.equal(result.rows[0].display.actsts, '正常');
    assert.equal(calls[0].url, '/v1/investment-ledger/list');
    assert.equal(calls[0].body.cusnm, '某客户');
    assert.equal(calls[0].body.employeeNo, undefined);
    assert.equal(calls[0].employeeNo, 'E1001');
  });
});

test('export traverses to terminal empty page and preserves every row', async () => {
  const rows = [
    { ...baseRow, actbasid: 'A-001', projectid: 'P-001' },
    { ...baseRow, actbasid: 'A-002', projectid: 'P-002' },
    { ...baseRow, actbasid: 'A-003', projectid: 'P-003' },
  ];
  await withAdapter(call => {
    const page = call.body.current;
    return { body: { total: 4, rows: page === 1 ? rows.slice(0, 2) : page === 2 ? rows.slice(2) : [] } };
  }, async ({ port, calls }) => {
    const result = await exportInvestmentLedger(config(port), identity, { view: 'raw' }, 'req-export');
    assert.equal(result.export.complete, true);
    assert.equal(result.export.reportedTotal, 4);
    assert.equal(result.export.rowCount, 3);
    assert.equal(result.export.totalMatchesRowCount, false);
    assert.equal(result.export.terminalEmptyPage, true);
    assert.equal(result.export.pagesFetched, 3);
    assert.equal(result.export.dataPagesFetched, 2);
    assert.equal(result.rows.length, 3);
    assert.equal(result.export.warnings.length, 1);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(c => c.body.current), [1, 2, 3]);
    assert.ok(calls.every(c => c.body.size === 2 && c.body.sort === 'projectid'));
  });
});

test('export refuses repeated pages instead of returning an incomplete dataset', async () => {
  await withAdapter(call => ({
    body: { total: 6, rows: [baseRow, { ...baseRow, actbasid: 'A-002', projectid: 'P-002' }] },
  }), async ({ port }) => {
    await assert.rejects(
      exportInvestmentLedger(config(port), identity, {}, 'req-repeat'),
      /记录 ID 完全重复/,
    );
  });
});

test('export refuses upstream total changes instead of returning a mixed snapshot', async () => {
  await withAdapter(call => {
    const page = call.body.current;
    return {
      body: {
        total: page === 1 ? 3 : 4,
        rows: page === 1
          ? [baseRow, { ...baseRow, actbasid: 'A-002', projectid: 'P-002' }]
          : [{ ...baseRow, actbasid: 'A-003', projectid: 'P-003' }],
      },
    };
  }, async ({ port, calls }) => {
    await assert.rejects(
      exportInvestmentLedger(config(port), identity, {}, 'req-total-change'),
      /total 从 3 变为 4/,
    );
    assert.equal(calls.length, 2);
  });
});

test('export refuses totals above maxRows without silently truncating', async () => {
  await withAdapter(() => ({ body: { total: 11, rows: [baseRow] } }), async ({ port, calls }) => {
    await assert.rejects(
      exportInvestmentLedger(config(port), identity, {}, 'req-cap'),
      /超过本次 maxRows=10 上限/,
    );
    assert.equal(calls.length, 1);
  });
});

test('invalid filters and upstream malformed bodies fail closed', async () => {
  await withAdapter(call => ({
    body: call.body.projectnm === 'null-total' ? { total: null, rows: [] } : { total: 1 },
  }), async ({ port }) => {
    const cfg = config(port);
    await assert.rejects(searchInvestmentLedger(cfg, identity, { size: 0 }, 'req-size'), /size/);
    await assert.rejects(searchInvestmentLedger(cfg, identity, { size: 101 }, 'req-size-101'), /1-100/);
    await assert.rejects(searchInvestmentLedger(cfg, identity, { actsts: '9' }, 'req-status'), /actsts/);
    await assert.rejects(searchInvestmentLedger(cfg, identity, { sort: 'evil' }, 'req-sort'), /sort/);
    await assert.rejects(searchInvestmentLedger(cfg, identity, { dealdate: '2026-02-30' }, 'req-date'), /真实存在/);
    await assert.rejects(searchInvestmentLedger(cfg, identity, { projectnm: 'null-total' }, 'req-null-total'), /total\/totalCount 不能为空/);
    await assert.rejects(searchInvestmentLedger(cfg, identity, {}, 'req-malformed'), /rows 数组/);
  });
});

// ---------- L1-4 加固回归：监听地址、placeholder 注释、/health 适配层探测 ----------

test('MCP_BIND_ADDR defaults to loopback and fails closed on any address outside the whitelist', () => {
  // 默认（不设/空白）= 127.0.0.1；旧版绑 0.0.0.0 的行为只能靠显式配置恢复。
  assert.equal(config(3002).bindAddr, '127.0.0.1');
  assert.equal(config(3002, { MCP_BIND_ADDR: '   ' }).bindAddr, '127.0.0.1');
  assert.equal(config(3002, { MCP_BIND_ADDR: '0.0.0.0' }).bindAddr, '0.0.0.0');

  for (const bad of ['localhost', '10.0.0.5', '127.0.0.2', '::', '0.0.0.0,127.0.0.1', '0.0.0.0;rm -rf /']) {
    assert.throws(
      () => config(3002, { MCP_BIND_ADDR: bad }),
      /MCP_BIND_ADDR/,
      `非法监听地址被接受: ${bad}`,
    );
  }
});

test('placeholder columns keep their page source fields and formatted values (comment-only change)', () => {
  const byField = new Map(LEDGER_COLUMNS.map(column => [column.field, column]));
  const expected = {
    placeholder_199: ['参与投资额', 'projamt'],
    placeholder_200: ['尚未收回的本金', 'avlblc'],
    placeholder_201: ['已收回本金', 'takeamt'],
    placeholder_202: ['已收回利息', 'realpayint'],
    placeholder_203: ['尚未收回的本金', 'avlblc'],
  };
  for (const [field, [title, sourceField]] of Object.entries(expected)) {
    const column = byField.get(field);
    assert.ok(column, `缺少列 ${field}`);
    assert.equal(column.title, title);
    assert.equal(column.sourceField, sourceField);
  }

  const display = toLedgerDisplayRow({ ...baseRow, projamt: 1234.5, avlblc: 1000, takeamt: 500, realpayint: 12 });
  // 占位键的值必须与同源字段完全一致（格式化口径同一套）
  assert.equal(display.placeholder_199, display.projamt);
  assert.equal(display.placeholder_200, display.avlblc);
  assert.equal(display.placeholder_203, display.avlblc);
  assert.equal(display.placeholder_201, display.takeamt);
  assert.equal(display.placeholder_202, display.realpayint);
  assert.equal(display.placeholder_199, '1,234.5 元');
  assert.equal(display.placeholder_202, '12 元');
  assert.equal(Object.keys(display).length, 49);
});

test('health reports adapter as a literal and never echoes adapter URL or service JWT', async () => {
  const serviceJwt = 'unit-test-service-jwt-MUST-NOT-LEAK';
  const baseEnv = {
    MCP_PUBLIC_URL: 'http://127.0.0.1',
    AUTH_MODE: 'oidc',
    MAXKEY_ISSUER: 'http://127.0.0.1:3101/sign',
    MAXKEY_AUTHORIZE_URL: 'http://127.0.0.1:3101/sign/authorize',
    MAXKEY_TOKEN_URL: 'http://127.0.0.1:3101/sign/token',
    MAXKEY_JWKS_URL: 'http://127.0.0.1:3101/sign/jwks',
    MCP_CLIENT_ID: 'unit-test',
    OA_ADAPTER_SERVICE_JWT: serviceJwt,
    AUDIT_LOG_PATH: 'logs/unit-health-audit.log',
  };

  // 1) 适配层端口无监听 → unreachable
  const closedPort = await freePort();
  const unreachableAddr = `http://127.0.0.1:${closedPort}`;
  const down = await withRunningServer({ ...baseEnv, OA_ADAPTER_URL: unreachableAddr }, async baseUrl => {
    const res = await fetch(`${baseUrl}/health`);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, text, json };
  });
  assert.equal(down.status, 200);
  assert.equal(down.json.status, 'ok');
  assert.equal(down.json.adapter, 'unreachable');

  // 2) 适配层端口可达 → configured
  const probeServer = createServer(() => {});
  await new Promise(resolve => probeServer.listen(0, '127.0.0.1', resolve));
  const upPort = probeServer.address().port;
  const upAddr = `http://127.0.0.1:${upPort}`;
  const up = await withRunningServer({ ...baseEnv, OA_ADAPTER_URL: upAddr }, async baseUrl => {
    const res = await fetch(`${baseUrl}/health`);
    return { status: res.status, json: await res.json() };
  }).finally(() => new Promise(resolve => probeServer.close(resolve)));
  assert.equal(up.status, 200);
  assert.equal(up.json.adapter, 'configured');

  // 3) 响应只有六个字段，且不含适配层地址/服务 JWT/上游错误内容
  assert.deepEqual(Object.keys(up.json).sort(), ['adapter', 'authMode', 'dataMode', 'realtime', 'status', 'version']);
  for (const body of [down.text, JSON.stringify(up.json)]) {
    assert.ok(!body.includes(upAddr) && !body.includes(unreachableAddr), '健康检查回显了适配层 URL');
    assert.ok(!body.includes(serviceJwt), '健康检查回显了服务 JWT');
    assert.ok(!/被拒绝|ECONNREFUSED|fetch failed/.test(body), '健康检查泄漏上游错误细节');
  }
});

// ---------- 快照模式（LEDGER_DATA_MODE=snapshot） ----------

function snapshotFixture(rows, acl, extraDoc = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-snapshot-'));
  const snapPath = path.join(dir, 'current.json');
  const aclPath = path.join(dir, 'acl.json');
  fs.writeFileSync(snapPath, JSON.stringify({
    schemaVersion: 1,
    source: { environment: 'test', menu: ['统一数据管理', '投后数据统计', '在投业务台账', '在投业务台账列表'], endpoint: '/oamgr/SGMGR/sgproj/sgproj/list?type=1' },
    fetchedAt: '2026-11-11T07:50:21.700Z',
    integrity: { reportedTotal: rows.length, rowCount: rows.length, totalMatchesRowCount: true },
    rows,
    ...extraDoc,
  }));
  fs.writeFileSync(aclPath, JSON.stringify({ schemaVersion: 1, employees: acl }));
  return { dir, snapPath, aclPath };
}

function snapshotConfig(fixture, extra = {}) {
  return config(1, {
    LEDGER_DATA_MODE: 'snapshot',
    LEDGER_SNAPSHOT_PATH: fixture.snapPath,
    LEDGER_SNAPSHOT_ACL_PATH: fixture.aclPath,
    ...extra,
  });
}

const snapRows = [
  { ...baseRow, actbasid: 'S-001', projectid: 'SP-001', projectno: 'PX-1', projectnm: '绿电一号', cusnm: '甲公司', site: '济南', actsts: '1', avlblc: 100 },
  { ...baseRow, actbasid: 'S-002', projectid: 'SP-002', projectno: 'PX-10', projectnm: '绿电二号', cusnm: '乙公司', site: '青岛', actsts: '2', avlblc: 200 },
  { ...baseRow, actbasid: 'S-003', projectid: 'SP-003', projectno: 'PX-3', projectnm: '钢贸一号', cusnm: '甲公司', site: '济南', actsts: '1', avlblc: 300 },
  { ...baseRow, actbasid: 'S-004', projectid: 'SP-004', projectno: 'PX-4', projectnm: '钢贸二号', cusnm: '丙公司', site: '淄博', actsts: '3', avlblc: 400 },
  { ...baseRow, actbasid: 'S-005', projectid: 'SP-005', projectno: 'PX-5', projectnm: '租赁一号', cusnm: '丁公司', site: '临沂', actsts: '1', avlblc: 500 },
];

test('LEDGER_DATA_MODE defaults to adapter; snapshot requires explicit snapshot + ACL and fails closed', () => {
  assert.equal(config(3003).ledgerDataMode, 'adapter');
  assert.equal(config(3003, { LEDGER_DATA_MODE: '  ' }).ledgerDataMode, 'adapter');
  assert.throws(() => config(3003, { LEDGER_DATA_MODE: 'realtime' }), /LEDGER_DATA_MODE/);
  assert.throws(() => config(3003, { LEDGER_DATA_MODE: 'snapshot' }), /LEDGER_SNAPSHOT_ACL_PATH/);

  const fixture = snapshotFixture(snapRows, { E1001: ['S-001'] });
  // snapshot 模式不连适配层：不提供 OA_ADAPTER_URL / 服务 JWT 也必须能启动
  const snap = snapshotConfig(fixture, { OA_ADAPTER_URL: undefined, OA_ADAPTER_SERVICE_JWT: undefined });
  assert.equal(snap.ledgerDataMode, 'snapshot');
  assert.equal(snap.adapterServiceJwt, '');
  assert.equal(snap.adapterUrl, '');
  assert.throws(() => snapshotConfig(fixture, { LEDGER_SNAPSHOT_ACL_PATH: path.join(fixture.dir, 'nope.json') }), /不存在/);
  assert.throws(() => snapshotConfig(fixture, { LEDGER_SNAPSHOT_PATH: path.join(fixture.dir, 'nope.json') }), /快照文件不存在/);
});

test('snapshot search keeps 49-column display, filters, sorting and pagination without a network call', async () => {
  const fixture = snapshotFixture(snapRows, { E1001: snapRows.map(r => r.actbasid) });
  const cfg = snapshotConfig(fixture);

  const page = await searchInvestmentLedger(cfg, identity, { current: 2, size: 2, view: 'both' }, 'req-snap-page');
  assert.equal(page.pagination.total, 5);
  assert.equal(page.pagination.totalPages, 3);
  assert.equal(page.pagination.hasNext, true);
  assert.equal(page.rows.length, 2);
  assert.equal(page.rows[0].raw.actbasid, 'S-003');
  assert.equal(Object.keys(page.rows[0].display).length, 49);
  assert.equal(page.rows[0].display.avlblc, '300 元');
  assert.equal(page._meta.dataMode, 'snapshot');
  assert.equal(page._meta.realtime, false);
  assert.equal(page._meta.snapshotRowCount, 5);
  assert.equal(page._meta.snapshotFetchedAt, '2026-11-11T07:50:21.700Z');

  // 名称类：包含匹配；编号类：精确匹配（PX-1 不得命中 PX-10）
  const byName = await searchInvestmentLedger(cfg, identity, { projectnm: '绿电' }, 'req-snap-name');
  assert.equal(byName.pagination.total, 2);
  const byNo = await searchInvestmentLedger(cfg, identity, { projectno: 'PX-1' }, 'req-snap-no');
  assert.deepEqual(byNo.rows.map(r => r.raw.actbasid), ['S-001']);
  const byStatus = await searchInvestmentLedger(cfg, identity, { actsts: '1' }, 'req-snap-sts');
  assert.equal(byStatus.pagination.total, 3);
  const byCity = await searchInvestmentLedger(cfg, identity, { site: '济南' }, 'req-snap-site');
  assert.equal(byCity.pagination.total, 2);

  const sorted = await searchInvestmentLedger(cfg, identity, { sort: 'avlblc', order: 'desc', size: 5 }, 'req-snap-sort');
  assert.deepEqual(sorted.rows.map(r => r.raw.actbasid), ['S-005', 'S-004', 'S-003', 'S-002', 'S-001']);
});

test('snapshot ACL isolates employees by verified JWT identity and ignores body-supplied employee numbers', async () => {
  const fixture = snapshotFixture(snapRows, {
    E1001: ['S-001', 'S-003'],
    E2002: ['S-002', 'S-004'],
    E9009: [],
  });
  const cfg = snapshotConfig(fixture);

  // body/入参里自报员工号不参与任何决策：identity 仍是 E1001
  const a = await searchInvestmentLedger(cfg, identity, { employeeNo: 'E2002', employees: ['E2002'], view: 'raw' }, 'req-snap-a');
  assert.deepEqual(a.rows.map(r => r.actbasid), ['S-001', 'S-003']);
  assert.equal(a.pagination.total, 2);

  const b = await searchInvestmentLedger(cfg, { ...identity, employeeNo: 'E2002' }, { view: 'raw' }, 'req-snap-b');
  assert.deepEqual(b.rows.map(r => r.actbasid), ['S-002', 'S-004']);

  // 在 ACL 内但授权为空 → 0 行（合法）
  const empty = await searchInvestmentLedger(cfg, { ...identity, employeeNo: 'E9009' }, { view: 'raw' }, 'req-snap-empty');
  assert.equal(empty.pagination.total, 0);

  // ACL 未覆盖该员工 → 拒绝（fail-closed，绝不退化成全员可见）
  await assert.rejects(
    searchInvestmentLedger(cfg, { ...identity, employeeNo: 'E3003' }, { view: 'raw' }, 'req-snap-forbid'),
    /不在快照 ACL 覆盖范围内/,
  );

  // 筛选不能扩大 ACL 可见范围
  const filtered = await searchInvestmentLedger(cfg, identity, { projectno: 'PX-4', view: 'raw' }, 'req-snap-filter-acl');
  assert.equal(filtered.pagination.total, 0);
});

test('snapshot mode refuses filters whose semantics only exist in the OA adapter', async () => {
  const fixture = snapshotFixture(snapRows, { E1001: snapRows.map(r => r.actbasid) });
  const cfg = snapshotConfig(fixture);
  await assert.rejects(
    searchInvestmentLedger(cfg, identity, { compcusnm: '某集团' }, 'req-snap-compcusnm'),
    /snapshot 模式不支持 compcusnm/,
  );
  await assert.rejects(
    searchInvestmentLedger(cfg, identity, { dealdate: '2026-11-11' }, 'req-snap-dealdate'),
    /snapshot 模式不支持 dealdate/,
  );
});

test('snapshot export returns only ACL-visible rows and marks the payload as non-realtime', async () => {
  const fixture = snapshotFixture(snapRows, { E1001: ['S-001', 'S-002', 'S-005'] });
  const cfg = snapshotConfig(fixture);
  const result = await exportInvestmentLedger(cfg, identity, { view: 'raw' }, 'req-snap-export');
  assert.equal(result.export.complete, true);
  assert.equal(result.export.rowCount, 3);
  assert.equal(result.export.reportedTotal, 3);
  assert.equal(result.export.terminalEmptyPage, true);
  assert.deepEqual(result.rows.map(r => r.actbasid), ['S-001', 'S-002', 'S-005']);
  assert.equal(result._meta.dataMode, 'snapshot');
  assert.equal(result._meta.realtime, false);
});


import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadConfig } from '../dist/config.js';
import { searchInvestmentLedger, exportInvestmentLedger, getInvestmentLedgerSchema } from '../dist/api/ledger.js';
import { toLedgerDisplayRow, LEDGER_COLUMNS } from '../dist/api/ledgerSchema.js';

const identity = { employeeNo: 'E1001', subject: 'unit-a', clientId: 'unit-test', raw: {} };

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

import * as fs from 'fs';
import { createHash } from 'crypto';
import { ServerConfig } from '../config';
import { VerifiedIdentity } from '../auth/verify';
import { callAdapter } from './adapter';
import {
  LedgerExportParams,
  LedgerExportResult,
  LedgerPageResult,
  LedgerRawRow,
  LedgerSearchParams,
  LedgerView,
} from '../types/ledger';
import {
  LEDGER_CODE_SETS,
  LEDGER_COLUMNS,
  LEDGER_FILTERS,
  LEDGER_SORT_FIELDS,
  LEDGER_SOURCE,
  toLedgerDisplayRow,
} from './ledgerSchema';

export class LedgerDataError extends Error {}

// 权限拒绝（快照 ACL 未覆盖当前员工 / 快照 ACL 不可用）：与参数错误区分，REST 映射 403。
export class LedgerPermissionError extends Error {}

export interface LedgerResponseMeta {
  dataMode: 'adapter' | 'snapshot';
  realtime: boolean;
  acl: 'oa-adapter-row-permission' | 'snapshot-acl-fixture';
  snapshotVersion?: string;
  snapshotFetchedAt?: string;
  snapshotRowCount?: number;
}

interface RawLedgerPage {
  rows: LedgerRawRow[];
  reportedTotal: number;
  current: number;
  size: number;
}

const FILTER_NAMES = ['projectnm', 'projectno', 'cusnm', 'ctrtcode', 'compcusnm', 'site'] as const;

function positiveInteger(value: unknown, fallback: number, name: string, maximum: number): number {
  const effective = value === undefined ? fallback : value;
  if (!Number.isInteger(effective) || Number(effective) < 1 || Number(effective) > maximum) {
    throw new LedgerDataError(`${name} 必须是 1-${maximum} 的整数`);
  }
  return Number(effective);
}

function normalizeSearchParams(params: LedgerSearchParams = {}, maxSize = 100): Required<Pick<LedgerSearchParams, 'current' | 'size' | 'view'>> & LedgerSearchParams {
  const current = positiveInteger(params.current, 1, 'current', 1_000_000);
  const size = positiveInteger(params.size, 15, 'size', maxSize);
  const view = params.view || 'both';
  if (!['raw', 'display', 'both'].includes(view)) {
    throw new LedgerDataError('view 仅支持 raw、display、both');
  }
  if (params.sort && !(LEDGER_SORT_FIELDS as readonly string[]).includes(params.sort)) {
    throw new LedgerDataError(`sort 仅支持：${LEDGER_SORT_FIELDS.join(', ')}`);
  }
  if (params.order && !['asc', 'desc'].includes(params.order)) {
    throw new LedgerDataError('order 仅支持 asc、desc');
  }
  if (params.actsts && !['1', '2', '3'].includes(params.actsts)) {
    throw new LedgerDataError('actsts 仅支持 1=正常、2=逾期、3=已结清');
  }
  if (params.dealdate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(params.dealdate);
    const valid = match && (() => {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const date = new Date(Date.UTC(year, month - 1, day));
      return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    })();
    if (!valid) throw new LedgerDataError('dealdate 必须是真实存在的 YYYY-MM-DD 日期');
  }
  for (const name of FILTER_NAMES) {
    const value = params[name];
    if (value !== undefined && (typeof value !== 'string' || value.length > 200)) {
      throw new LedgerDataError(`${name} 必须是不超过 200 字符的字符串`);
    }
  }
  return { ...params, current, size, view };
}

function parseAdapterPage(payload: unknown, current: number, size: number): RawLedgerPage {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LedgerDataError('OA 适配层返回的不是对象');
  }
  const outer = payload as Record<string, unknown>;
  const nested = outer.result && typeof outer.result === 'object' && !Array.isArray(outer.result)
    ? outer.result as Record<string, unknown>
    : outer;
  const totalValue = nested.total ?? nested.totalCount;
  if (totalValue === undefined || totalValue === null || totalValue === '') {
    throw new LedgerDataError('OA 适配层 total/totalCount 不能为空');
  }
  const reportedTotal = Number(totalValue);
  if (!Number.isInteger(reportedTotal) || reportedTotal < 0) {
    throw new LedgerDataError('OA 适配层缺少有效的 total/totalCount');
  }
  if (!Array.isArray(nested.rows)) {
    throw new LedgerDataError('OA 适配层缺少 rows 数组');
  }
  const rows = nested.rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new LedgerDataError(`第 ${current} 页第 ${index + 1} 行不是对象`);
    }
    return row as LedgerRawRow;
  });
  return { rows, reportedTotal, current, size };
}

// ============ 快照数据源（LEDGER_DATA_MODE=snapshot，非实时） ============
// 快照来自 repair-ledger-data 生成的 data/current.json（同一份数据渲染 3387 篇文档）。
// 设计要求：
//   1. 只读；不改数据、不写回、不联网。
//   2. 员工身份只来自已验证令牌（identity.employeeNo），绝不读 body/未签名头。
//   3. ACL 用「显式夹具」代行 OA 行级权限：文件由 LEDGER_SNAPSHOT_ACL_PATH 指定，
//      未覆盖当前员工 → 抛 LedgerPermissionError（fail-closed，绝不退化成全员可见）。
//      字段口径（机构/经办人/项目组）属 G-8 业务裁决，本模块不自行选口径。
//   4. 返回体带 _meta.dataMode=snapshot / realtime=false，任何调用方都不得把快照当实时 OA。

interface LoadedSnapshot {
  rows: LedgerRawRow[];
  fetchedAt: string;
  schemaVersion: number;
  version: string;      // 快照内容 sha256 前 12 位，供第三方判断「数据是哪一版」
  rowCount: number;
}

const snapshotCache = new Map<string, { mtimeMs: number; size: number; snapshot: LoadedSnapshot }>();

export function loadLedgerSnapshot(filePath: string): LoadedSnapshot {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new LedgerDataError('快照文件不可读（LEDGER_SNAPSHOT_PATH）');
  }
  const cached = snapshotCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.snapshot;

  const raw = fs.readFileSync(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new LedgerDataError('快照文件不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LedgerDataError('快照文件根节点不是对象');
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.schemaVersion !== 1) {
    throw new LedgerDataError(`快照 schemaVersion 不受支持: ${String(doc.schemaVersion)}`);
  }
  if (!Array.isArray(doc.rows)) {
    throw new LedgerDataError('快照缺少 rows 数组');
  }
  const rows = doc.rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new LedgerDataError(`快照第 ${index + 1} 行不是对象`);
    }
    return row as LedgerRawRow;
  });
  const snapshot: LoadedSnapshot = {
    rows,
    fetchedAt: typeof doc.fetchedAt === 'string' ? doc.fetchedAt : '',
    schemaVersion: 1,
    version: createHash('sha256').update(raw).digest('hex').slice(0, 12),
    rowCount: rows.length,
  };
  snapshotCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, snapshot });
  return snapshot;
}

interface LoadedSnapshotAcl {
  employees: Map<string, Set<string>>;
  version: string;
}

const snapshotAclCache = new Map<string, { mtimeMs: number; size: number; acl: LoadedSnapshotAcl }>();

// ACL 夹具格式：{ "schemaVersion": 1, "employees": { "<员工编号>": ["<actbasid>", ...] } }
// 空数组 = 该员工在权限范围内无数据；未出现的员工 = 拒绝（不是「无数据」）。
export function loadLedgerSnapshotAcl(filePath: string): LoadedSnapshotAcl {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new LedgerPermissionError('快照 ACL 夹具不可读，拒绝返回数据');
  }
  const cached = snapshotAclCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.acl;

  const raw = fs.readFileSync(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new LedgerPermissionError('快照 ACL 夹具不是合法 JSON，拒绝返回数据');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LedgerPermissionError('快照 ACL 夹具根节点不是对象，拒绝返回数据');
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.schemaVersion !== 1) {
    throw new LedgerPermissionError(`快照 ACL schemaVersion 不受支持: ${String(doc.schemaVersion)}`);
  }
  const employeesRaw = doc.employees;
  if (!employeesRaw || typeof employeesRaw !== 'object' || Array.isArray(employeesRaw)) {
    throw new LedgerPermissionError('快照 ACL 缺少 employees 映射，拒绝返回数据');
  }
  const employees = new Map<string, Set<string>>();
  for (const [employeeNo, value] of Object.entries(employeesRaw as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) {
      throw new LedgerPermissionError(`快照 ACL 中员工 ${employeeNo} 的 actbasid 列表非法`);
    }
    employees.set(employeeNo, new Set((value as string[]).map(id => id.trim())));
  }
  const acl: LoadedSnapshotAcl = {
    employees,
    version: createHash('sha256').update(raw).digest('hex').slice(0, 12),
  };
  snapshotAclCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, acl });
  return acl;
}

// 只认已验证身份；ACL 未覆盖该员工 → 403 语义，不回退到「全部可见」。
function allowedLedgerIds(cfg: ServerConfig, identity: VerifiedIdentity): Set<string> {
  const acl = loadLedgerSnapshotAcl(cfg.ledgerSnapshotAclPath);
  const allowed = acl.employees.get(identity.employeeNo);
  if (!allowed) {
    throw new LedgerPermissionError('当前员工不在快照 ACL 覆盖范围内，拒绝返回数据');
  }
  return allowed;
}

// 快照没有的字段：口径由 OA 适配层 SQL 决定，猜一个等于编数据 → 显式拒绝。
const SNAPSHOT_UNSUPPORTED_FILTERS: Record<string, string> = {
  compcusnm: '快照无「所属集团/核心企业/付款人」字段，该口径由 OA 适配层实现；请用 adapter 模式或在 G-8 裁决后扩展',
  dealdate: '「截至该日期未结清」的判定由 OA 适配层实现，快照无法等价复算；请用 adapter 模式',
};

// 名称类字段按包含匹配（与工具描述「项目名称，模糊查询」一致）；编号类按精确匹配。
const SNAPSHOT_FUZZY_FILTERS = ['projectnm', 'cusnm', 'site'] as const;
const SNAPSHOT_EXACT_FILTERS = ['projectno', 'ctrtcode'] as const;

function matchesSnapshotFilters(row: LedgerRawRow, params: Required<Pick<LedgerSearchParams, 'current' | 'size' | 'view'>> & LedgerSearchParams): boolean {
  for (const name of SNAPSHOT_FUZZY_FILTERS) {
    const needle = params[name];
    if (typeof needle === 'string' && needle.trim()) {
      const hay = row[name] === undefined || row[name] === null ? '' : String(row[name]);
      if (!hay.toLowerCase().includes(needle.trim().toLowerCase())) return false;
    }
  }
  for (const name of SNAPSHOT_EXACT_FILTERS) {
    const needle = params[name];
    if (typeof needle === 'string' && needle.trim()) {
      const hay = row[name] === undefined || row[name] === null ? '' : String(row[name]);
      if (hay.trim().toLowerCase() !== needle.trim().toLowerCase()) return false;
    }
  }
  if (params.actsts && String(row.actsts ?? '') !== params.actsts) return false;
  return true;
}

function compareSnapshotValues(a: unknown, b: unknown): number {
  const sa = a === undefined || a === null ? '' : String(a);
  const sb = b === undefined || b === null ? '' : String(b);
  if (sa !== '' && sb !== '' && Number.isFinite(Number(sa)) && Number.isFinite(Number(sb))) {
    return Number(sa) - Number(sb);
  }
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function snapshotPage(
  cfg: ServerConfig,
  identity: VerifiedIdentity,
  params: Required<Pick<LedgerSearchParams, 'current' | 'size' | 'view'>> & LedgerSearchParams,
): RawLedgerPage {
  for (const [name, reason] of Object.entries(SNAPSHOT_UNSUPPORTED_FILTERS)) {
    const value = (params as unknown as Record<string, unknown>)[name];
    if (typeof value === 'string' && value.trim()) {
      throw new LedgerDataError(`snapshot 模式不支持 ${name} 筛选：${reason}`);
    }
  }

  const snapshot = loadLedgerSnapshot(cfg.ledgerSnapshotPath);
  const allowed = allowedLedgerIds(cfg, identity);

  // 先按 ACL 裁剪，再筛选：筛选条件永远不能扩大可见范围。
  let rows = snapshot.rows.filter(row => {
    const id = rowId(row);
    return id !== null && allowed.has(id);
  });
  rows = rows.filter(row => matchesSnapshotFilters(row, params));

  if (params.sort) {
    const field = params.sort as keyof LedgerRawRow;
    const direction = params.order === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => direction * compareSnapshotValues(a[field], b[field]));
  }

  const start = (params.current - 1) * params.size;
  return {
    rows: rows.slice(start, start + params.size),
    reportedTotal: rows.length,
    current: params.current,
    size: params.size,
  };
}

function responseMeta(cfg: ServerConfig): LedgerResponseMeta {
  if (cfg.ledgerDataMode === 'snapshot') {
    const snapshot = loadLedgerSnapshot(cfg.ledgerSnapshotPath);
    return {
      dataMode: 'snapshot',
      realtime: false,
      acl: 'snapshot-acl-fixture',
      snapshotVersion: snapshot.version,
      snapshotFetchedAt: snapshot.fetchedAt,
      snapshotRowCount: snapshot.rowCount,
    };
  }
  return { dataMode: 'adapter', realtime: true, acl: 'oa-adapter-row-permission' };
}

// /health 用：只回快照的版本与行数，不回显文件路径。
export function getLedgerSnapshotSummary(cfg: ServerConfig): {
  available: boolean; fetchedAt?: string; rowCount?: number; version?: string; schemaVersion?: number;
} {
  try {
    const snapshot = loadLedgerSnapshot(cfg.ledgerSnapshotPath);
    return {
      available: true,
      fetchedAt: snapshot.fetchedAt,
      rowCount: snapshot.rowCount,
      version: snapshot.version,
      schemaVersion: snapshot.schemaVersion,
    };
  } catch {
    return { available: false };
  }
}

async function fetchLedgerPage(
  cfg: ServerConfig,
  identity: VerifiedIdentity,
  params: LedgerSearchParams,
  reqId: string,
  maxSize = 100,
): Promise<RawLedgerPage> {
  const normalized = normalizeSearchParams(params, maxSize);
  if (cfg.ledgerDataMode === 'snapshot') {
    // 快照模式：不发起任何网络请求，不触碰适配层地址/服务 JWT。
    return snapshotPage(cfg, identity, normalized);
  }
  const body: Record<string, unknown> = {
    current: normalized.current,
    size: normalized.size,
  };
  for (const name of FILTER_NAMES) {
    const value = normalized[name];
    if (typeof value === 'string' && value.trim()) body[name] = value.trim();
  }
  if (normalized.actsts) body.actsts = normalized.actsts;
  if (normalized.dealdate) body.dealdate = normalized.dealdate;
  if (normalized.sort) body.sort = normalized.sort;
  if (normalized.order) body.order = normalized.order;
  const payload = await callAdapter(cfg, identity, 'investment-ledger', 'list', body, reqId);
  return parseAdapterPage(payload, normalized.current, normalized.size);
}

function formatRows(rows: LedgerRawRow[], view: LedgerView): unknown[] {
  if (view === 'raw') return rows;
  if (view === 'display') return rows.map(toLedgerDisplayRow);
  return rows.map(raw => ({ raw, display: toLedgerDisplayRow(raw) }));
}

export async function searchInvestmentLedger(
  cfg: ServerConfig,
  identity: VerifiedIdentity,
  params: LedgerSearchParams,
  reqId: string,
): Promise<LedgerPageResult & { _meta: LedgerResponseMeta }> {
  const normalized = normalizeSearchParams(params);
  const page = await fetchLedgerPage(cfg, identity, normalized, reqId);
  const totalPages = Math.ceil(page.reportedTotal / page.size);
  return {
    _meta: responseMeta(cfg),
    source: LEDGER_SOURCE,
    view: normalized.view,
    columns: LEDGER_COLUMNS,
    rows: formatRows(page.rows, normalized.view),
    pagination: {
      current: page.current,
      size: page.size,
      total: page.reportedTotal,
      totalPages,
      hasNext: page.current < totalPages,
    },
  };
}

function rowId(row: LedgerRawRow): string | null {
  const id = row.actbasid || row.projectid;
  return id === undefined || id === null || String(id).trim() === '' ? null : String(id);
}

export async function exportInvestmentLedger(
  cfg: ServerConfig,
  identity: VerifiedIdentity,
  params: LedgerExportParams,
  reqId: string,
): Promise<LedgerExportResult & { _meta: LedgerResponseMeta }> {
  const view = params.view || 'both';
  if (!['raw', 'display', 'both'].includes(view)) {
    throw new LedgerDataError('view 仅支持 raw、display、both');
  }
  const maxRows = positiveInteger(params.maxRows, cfg.ledgerExportMaxRows, 'maxRows', cfg.ledgerExportMaxRows);
  const pageSize = cfg.ledgerExportPageSize;
  const allRows: LedgerRawRow[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  const pageSignatures = new Set<string>();
  let missingIdCount = 0;
  let reportedTotal = -1;
  let current = 1;
  let dataPagesFetched = 0;
  let terminalEmptyPage = false;

  while (current <= Math.ceil(maxRows / pageSize) + 2) {
    const page = await fetchLedgerPage(cfg, identity, {
      projectnm: params.projectnm,
      projectno: params.projectno,
      cusnm: params.cusnm,
      ctrtcode: params.ctrtcode,
      compcusnm: params.compcusnm,
      site: params.site,
      actsts: params.actsts,
      dealdate: params.dealdate,
      current,
      size: pageSize,
      sort: 'projectid',
      order: 'asc',
      view: 'raw',
    }, reqId, 200);

    if (reportedTotal < 0) {
      reportedTotal = page.reportedTotal;
      if (reportedTotal > maxRows) {
        throw new LedgerDataError(`上游报告 ${reportedTotal} 条，超过本次 maxRows=${maxRows} 上限；未返回截断结果`);
      }
    } else if (page.reportedTotal !== reportedTotal) {
      throw new LedgerDataError(`取数期间上游 total 从 ${reportedTotal} 变为 ${page.reportedTotal}，请重试，未返回不完整结果`);
    }

    if (page.rows.length === 0) {
      terminalEmptyPage = true;
      break;
    }
    dataPagesFetched += 1;
    const ids = page.rows.map(row => rowId(row));
    const signature = JSON.stringify(ids);
    if (pageSignatures.has(signature)) {
      throw new LedgerDataError(`第 ${current} 页与前一页记录 ID 完全重复，已中止，未返回不完整结果`);
    }
    pageSignatures.add(signature);

    for (const row of page.rows) {
      const id = rowId(row);
      if (!id) {
        missingIdCount += 1;
      } else if (seenIds.has(id)) {
        duplicateIds.add(id);
      } else {
        seenIds.add(id);
      }
      allRows.push(row);
    }
    if (allRows.length > maxRows) {
      throw new LedgerDataError(`实际取得行数超过 maxRows=${maxRows}，未返回截断结果`);
    }
    current += 1;
  }

  if (!terminalEmptyPage) {
    throw new LedgerDataError('翻页达到安全上限仍未遇到空页，未返回不完整结果');
  }
  const totalMatchesRowCount = allRows.length === reportedTotal;
  if (!totalMatchesRowCount) {
    warnings.push(`上游 reportedTotal=${reportedTotal}，实际取得 ${allRows.length} 行；该接口 total 与可见行数不完全一致，二者分别保留`);
  }
  if (duplicateIds.size > 0) {
    warnings.push(`发现 ${duplicateIds.size} 个重复业务 ID；原始行未去重，避免误删同名或同项目记录`);
  }
  if (missingIdCount > 0) {
    warnings.push(`${missingIdCount} 行缺少 actbasid/projectid，无法做 ID 完整性核验`);
  }

  return {
    _meta: responseMeta(cfg),
    source: LEDGER_SOURCE,
    view,
    columns: LEDGER_COLUMNS,
    rows: formatRows(allRows, view),
    export: {
      complete: terminalEmptyPage && missingIdCount === 0,
      reportedTotal,
      rowCount: allRows.length,
      totalMatchesRowCount,
      uniqueIds: seenIds.size,
      duplicateIds: Array.from(duplicateIds).sort(),
      pagesFetched: current,
      dataPagesFetched,
      terminalEmptyPage,
      pageSize,
      sort: 'projectid',
      order: 'asc',
      warnings,
    },
  };
}

export function getInvestmentLedgerSchema(cfg?: ServerConfig) {
  const dataMode = cfg?.ledgerDataMode ?? 'adapter';
  return {
    source: LEDGER_SOURCE,
    dataMode,
    realtime: dataMode === 'adapter',
    columns: LEDGER_COLUMNS,
    filters: LEDGER_FILTERS,
    sortFields: LEDGER_SORT_FIELDS,
    codeSets: LEDGER_CODE_SETS,
    views: {
      raw: 'OA 原始字段；不裁掉页面未展示的 projectid、cusid 等字段',
      display: '按页面 datagrid 口径生成的 49 列；placeholder_* 是页面原字段名',
      both: '每行同时返回 raw 与 display，默认模式',
    },
    exportRule: '自动顺序翻页直到空页；总数变化、重复页或达到安全上限时拒绝返回不完整结果',
  };
}

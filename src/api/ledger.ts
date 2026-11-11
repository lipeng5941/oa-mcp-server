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

async function fetchLedgerPage(
  cfg: ServerConfig,
  identity: VerifiedIdentity,
  params: LedgerSearchParams,
  reqId: string,
  maxSize = 100,
): Promise<RawLedgerPage> {
  const normalized = normalizeSearchParams(params, maxSize);
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
): Promise<LedgerPageResult> {
  const normalized = normalizeSearchParams(params);
  const page = await fetchLedgerPage(cfg, identity, normalized, reqId);
  const totalPages = Math.ceil(page.reportedTotal / page.size);
  return {
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
): Promise<LedgerExportResult> {
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

export function getInvestmentLedgerSchema() {
  return {
    source: LEDGER_SOURCE,
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

// 统一数据管理 → 投后数据统计 → 在投业务台账

export type LedgerView = 'raw' | 'display' | 'both';
export type LedgerSortOrder = 'asc' | 'desc';

export interface LedgerSearchParams {
  projectnm?: string;
  projectno?: string;
  cusnm?: string;
  ctrtcode?: string;
  compcusnm?: string;
  site?: string;
  actsts?: '1' | '2' | '3';
  dealdate?: string;
  current?: number;
  size?: number;
  sort?: string;
  order?: LedgerSortOrder;
  view?: LedgerView;
}

export interface LedgerExportParams extends Omit<LedgerSearchParams, 'current' | 'size' | 'sort' | 'order'> {
  maxRows?: number;
}

export interface LedgerRawRow {
  actbasid?: string;
  actblc?: number | string | null;
  actdate?: string | null;
  actsts?: string | null;
  avlblc?: number | string | null;
  begdate?: string | null;
  billenddates?: string | null;
  biztype?: string | null;
  city?: string | null;
  compnature?: string | null;
  crtorg?: string | null;
  crtuser?: string | null;
  ctrtcode?: string | null;
  cuanms?: string | null;
  cusid?: string | null;
  cusnm?: string | null;
  drawers?: string | null;
  enddate?: string | null;
  goodsnms?: string | null;
  goodstyps?: string | null;
  groupnm?: string | null;
  industrialchain?: string | null;
  interest?: number | string | null;
  inttyp?: string | null;
  isgroupind?: string | null;
  mrgrate?: number | string | null;
  mrgtype?: string | null;
  planrealpayint?: number | string | null;
  projamt?: number | string | null;
  projectid?: string;
  projectnm?: string | null;
  projectno?: string | null;
  projtype?: string | null;
  province?: string | null;
  realall?: number | string | null;
  realpaycapital?: number | string | null;
  realpayint?: number | string | null;
  rettyp?: string | null;
  sgtype?: string | null;
  site?: string | null;
  strterm?: string | null;
  takeamt?: number | string | null;
  term?: number | string | null;
  termunit?: string | null;
  yield?: number | string | null;
  [field: string]: unknown;
}

export type LedgerColumnKind =
  | 'text'
  | 'dictionary'
  | 'currency'
  | 'monthlyCurrency'
  | 'percent'
  | 'businessType'
  | 'repaymentType';

export interface LedgerColumn {
  field: string;
  title: string;
  kind: LedgerColumnKind;
  sourceField?: string;
  codeSet?: string;
}

export interface LedgerPagination {
  current: number;
  size: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
}

export interface LedgerPageResult {
  source: {
    menu: string[];
    upstreamEndpoint: string;
  };
  view: LedgerView;
  columns: LedgerColumn[];
  rows: unknown[];
  pagination: LedgerPagination;
}

export interface LedgerExportResult extends Omit<LedgerPageResult, 'pagination'> {
  rows: unknown[];
  export: {
    complete: boolean;
    reportedTotal: number;
    rowCount: number;
    totalMatchesRowCount: boolean;
    uniqueIds: number;
    duplicateIds: string[];
    pagesFetched: number;
    dataPagesFetched: number;
    terminalEmptyPage: boolean;
    pageSize: number;
    sort: string;
    order: LedgerSortOrder;
    warnings: string[];
  };
}

import { LedgerColumn, LedgerRawRow } from '../types/ledger';

export const LEDGER_SOURCE = {
  menu: ['统一数据管理', '投后数据统计', '在投业务台账', '在投业务台账列表'],
  upstreamEndpoint: '/oamgr/SGMGR/sgproj/sgproj/list?type=1',
};

export const LEDGER_CODE_SETS: Record<string, Record<string, string>> = {
  Z014: { '0': '否', '1': '是' },
  CRMC03: {
    '1': '国有企业', '2': '集体企业', '3': '私营企业', '4': '个体工商户企业',
    '5': '合作企业', '6': '联营企业', '7': '股份合作制企业',
    '8': '有限责任企业', '9': '股份有限企业',
  },
  SG004: { '1': '售后回租', '2': '直租' },
  SG001: {
    '0': '保理', '1': '再保理', '2': '售后回租', '3': '直租', '4': '小贷业务',
    '5': '标准化债券产品', '6': '资管业务产品', '7': '资管收益权产品',
    '8': '收益权产品', '9': '贸易类产品', '10': '债权类产品', '11': '融鑫产品',
  },
  SG002: { '1': '正常', '2': '逾期', '3': '已结清' },
  FLP09: { '1': '内部业务', '2': '外部业务' },
  SG003: { '1': '按月付息', '2': '按季付息', '3': '半年付息', '4': '按年付息' },
  SG005: {
    '1': '利随本清', '2': '到期还本', '3': '等额本金', '4': '等额本息',
    '5': '一次性收息到期还本', '6': '不等期不等额本金', '9': '其他',
  },
  EASY001: {
    '1': '售后回租', '2': '债权装让', '3': '保理', '4': '直租',
    '5': '收益权转让', '6': '短期投资', '7': '信托投资', '8': '委托贷款',
    '9': '预投转售', '10': '债券投资', '11': '合伙企业',
  },
};

const col = (
  field: string,
  title: string,
  kind: LedgerColumn['kind'] = 'text',
  extras: Partial<Pick<LedgerColumn, 'sourceField' | 'codeSet'>> = {},
): LedgerColumn => ({ field, title, kind, ...extras });

// 顺序与 2026-11-11 测试环境页面 datagrid options.columns 完全一致。
//
// 关于 placeholder_199 ~ placeholder_203（只说明命名来源，不改变任何取值）：
//   页面 columns 的 field 名在 425~429 号位置上是重复的语义列（参与投资额 / 尚未收回的本金 /
//   已收回本金 / 已收回利息 / 尚未收回的本金 同名同键），datagrid 以数组位置区分、不以 field 去重。
//   为了在 MCP 输出里保持 49 个互不覆盖的键，这 5 列改用 placeholder_199..203 作为输出键，
//   并通过 sourceField 指回真实上游字段（projamt / avlblc / takeamt / realpayint / avlblc）。
//   因此：placeholder_NNN 只是"输出键占位名"，不是新字段，也不代表上游有同名属性；
//   取值一律来自 sourceField，格式化规则与其它列完全相同（见 toLedgerDisplayRow）。
//   任何"给 placeholder 改名/改 sourceField/合并重复列"的动作都会破坏与 L1-2 文档表格的逐字符一致性。
export const LEDGER_COLUMNS: LedgerColumn[] = [
  col('crtorg', '公司名称'),
  col('projectnm', '项目名称'),
  col('projectno', '项目编号'),
  col('cusnm', '客户名称'),
  col('ctrtcode', '合同编号'),
  col('groupnm', '所属集团（控股股东）'),
  col('isgroupind', '是否为集团产业链客户', 'dictionary', { codeSet: 'Z014' }),
  col('compnature', '企业属性', 'dictionary', { codeSet: 'CRMC03' }),
  col('projamt', '项目投资总额', 'currency'),
  col('placeholder_199', '参与投资额', 'currency', { sourceField: 'projamt' }),
  col('avlblc', '存量投资额', 'currency'),
  col('takeamt', '已收回本金', 'currency'),
  col('realpayint', '已收回利息', 'currency'),
  col('placeholder_200', '尚未收回的本金', 'currency', { sourceField: 'avlblc' }),
  col('province', '项目所在省'),
  col('city', '项目所在市'),
  col('area', '项目所在区'),
  col('projtype', '业务类型', 'businessType'),
  col('begdate', '项目投放日期'),
  col('enddate', '项目应到期日'),
  col('actsts', '项目状态', 'dictionary', { codeSet: 'SG002' }),
  col('biztype', '内/外部', 'dictionary', { codeSet: 'FLP09' }),
  col('yield', '项目收益率（IRR）', 'percent'),
  col('repaycapital', '本月应收本金', 'monthlyCurrency'),
  col('repayint', '本月应收利息', 'monthlyCurrency'),
  col('repayall', '本月应收本息', 'monthlyCurrency'),
  col('realpaycapital', '本月实收本金', 'monthlyCurrency'),
  col('planrealpayint', '本月实收利息', 'monthlyCurrency'),
  col('realall', '本月实收本息', 'monthlyCurrency'),
  col('placeholder_201', '已收回本金', 'currency', { sourceField: 'takeamt' }),
  col('placeholder_202', '已收回利息', 'currency', { sourceField: 'realpayint' }),
  col('placeholder_203', '尚未收回的本金', 'currency', { sourceField: 'avlblc' }),
  col('strterm', '天数'),
  col('rettyp', '还本付息方式', 'repaymentType'),
  col('mrgtype', '担保及抵押类型'),
  col('cuanms', '担保人名称'),
  col('mrgcusnms', '抵质押人名称'),
  col('goodstyps', '抵押物名称'),
  col('drawers', '票据承兑人'),
  col('billenddates', '票据到期日'),
  col('guaamt', '担保额', 'currency'),
  col('mrgatm', '抵押物价值', 'currency'),
  col('mrgrate', '抵押率', 'percent'),
  col('checkcase', '抵押物定期查看情况'),
  col('pickcase', '担保物权或抵押权顺位情况'),
  col('callback', '客户回访到期还款意愿/能力情况'),
  col('intval', '合同利率', 'percent'),
  col('comprehensiveinc', '综合收益率', 'percent'),
  col('crtuser', '经办人'),
];

export const LEDGER_FILTERS = [
  { name: 'projectnm', label: '项目名称', type: 'string' },
  { name: 'projectno', label: '项目编号', type: 'string' },
  { name: 'cusnm', label: '客户名称', type: 'string' },
  { name: 'ctrtcode', label: '合同编号', type: 'string' },
  { name: 'compcusnm', label: '所属集团/核心企业/付款人', type: 'string' },
  { name: 'site', label: '项目所在地', type: 'string' },
  { name: 'actsts', label: '项目状态', type: 'enum', values: LEDGER_CODE_SETS.SG002 },
  { name: 'dealdate', label: '截至该日期未结清项目', type: 'date', format: 'YYYY-MM-DD' },
];

export const LEDGER_SORT_FIELDS = [
  'projectid', 'projectnm', 'projectno', 'cusnm', 'ctrtcode',
  'begdate', 'enddate', 'actsts', 'projamt', 'avlblc',
] as const;

function codeText(codeSet: string, value: unknown): string {
  // 与页面 getCodeText 一致：空值返回空串；未知代码回显原值；逗号分隔代码逐项翻译。
  if (!value) return '';
  const dictionary = LEDGER_CODE_SETS[codeSet] || {};
  return String(value).split(',').map(code => dictionary[code] ?? code).join(',');
}

function formatNumber(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const normalized = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  const number = typeof normalized === 'number' ? normalized : Number(normalized);
  if (!Number.isFinite(number)) return String(value);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
    useGrouping: true,
  }).format(number);
}

function currency(value: unknown, monthlyFallback = false): string | null {
  const formatted = formatNumber(value);
  const effective = formatted ?? (monthlyFallback ? '0' : null);
  return effective === null ? null : `${effective} 元`;
}

function percent(value: unknown): string | null {
  return value === undefined || value === null || value === '' ? null : `${String(value)} %`;
}

function text(value: unknown): unknown {
  return value === undefined ? null : value;
}

export function toLedgerDisplayRow(row: LedgerRawRow): Record<string, unknown> {
  const display: Record<string, unknown> = {};
  for (const column of LEDGER_COLUMNS) {
    const sourceField = column.sourceField || column.field;
    const value = row[sourceField];
    switch (column.kind) {
      case 'dictionary':
        display[column.field] = codeText(column.codeSet!, value);
        break;
      case 'currency':
        display[column.field] = currency(value);
        break;
      case 'monthlyCurrency':
        display[column.field] = currency(value, true);
        break;
      case 'percent':
        display[column.field] = percent(value);
        break;
      case 'businessType': {
        if (row.projectno) {
          display[column.field] = codeText('EASY001', row.projtype);
        } else {
          const primary = codeText(String(row.sgtype) === '2' ? 'SG004' : 'SG001', row.projtype);
          const secondary = codeText('EASY001', row.projtype);
          display[column.field] = [primary, secondary].filter(Boolean).join(' ');
        }
        break;
      }
      case 'repaymentType': {
        const repayment = codeText('SG005', row.rettyp);
        if (String(row.rettyp) !== '1' && String(row.rettyp) !== '5') {
          // 页面函数即使两个代码都为空也保留逗号，不能按“更干净”的口径擅自删掉。
          display[column.field] = `${codeText('SG003', row.inttyp)}, ${repayment}`;
        } else {
          display[column.field] = repayment;
        }
        break;
      }
      default:
        display[column.field] = text(value);
    }
  }
  return display;
}

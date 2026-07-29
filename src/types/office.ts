// 办公场所相关类型定义

export interface OfficeSearchParams {
  officenm?: string;     // 办公场所名称
  address?: string;      // 地址
  current?: number;      // 页码
  size?: number;         // 每页条数
}

export interface Office {
  officeid: string;      // 场所ID
  officenm: string;      // 场所名称
  address: string;       // 地址
  orgnm: string;         // 所属机构名称
  orgno: string;         // 机构编号
  recsts: string;        // 状态：1=启用 0=停用
  memo: string | null;   // 备注
  crtuser: string;       // 创建人
  crtdate: string;       // 创建时间
  upduser: string;       // 更新人
  upddate: string;       // 更新时间
}

export interface PageResult<T> {
  pageNumber: number;
  pageSize: number;
  totalCount: number;
  rows: T[];
}

export interface ApiResponse<T> {
  result: PageResult<T>;
  msg: string | null;
  signature: string | null;
  message: string | null;
  timestamp: string;
  status: number;
  statusCode: string;
}
// 会议室相关类型定义

export interface RoomSearchParams {
  roomnm?: string;       // 会议室名称
  capacity?: number;     // 容纳人数
  building?: string;     // 楼宇
  current?: number;      // 页码
  size?: number;         // 每页条数
}

export interface Room {
  roomid: string;        // 会议室ID
  roomnm: string;        // 会议室名称
  capacity: number;      // 容纳人数
  building: string;      // 楼宇
  floor: string;         // 楼层
  equip: string;         // 设备（逗号分隔）
  status: string;        // 状态：1=空闲 2=占用 3=维护
  memo?: string;         // 备注
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
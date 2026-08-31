// ============ 审计日志（JSONL，追加写） ============
// 红线：禁止记录令牌、Cookie、密码、Authorization 头、OA 的 Request-Header-Info 头。
// 员工编号一律哈希后落盘。

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export interface AuditEntry {
  event: string;                  // server_start | auth_ok | auth_fail | tool_call | rate_limited
  reqId?: string;
  path?: string;
  transport?: 'mcp' | 'rest';
  tool?: string;
  employeeNoHash?: string;
  clientId?: string;
  reason?: string;                // auth_fail 原因码
  status?: 'ok' | 'error';
  latencyMs?: number;
  detail?: string;                // 非敏感补充信息
}

export class AuditLogger {
  private readonly filePath: string;
  private readonly salt: string;

  constructor(filePath: string, salt: string) {
    this.filePath = filePath;
    this.salt = salt;
    const dir = path.dirname(path.resolve(filePath));
    fs.mkdirSync(dir, { recursive: true });
  }

  /** 员工编号 → 16 位十六进制哈希（审计中不出现明文员工编号） */
  hashEmployee(employeeNo: string): string {
    return createHash('sha256').update(`${this.salt}:${employeeNo}`).digest('hex').slice(0, 16);
  }

  log(entry: AuditEntry): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    try {
      fs.appendFileSync(this.filePath, line + '\n', 'utf8');
    } catch (e) {
      // 审计写失败不能吞掉：打到 stderr 提醒运维（同样不含敏感内容）
      console.error('[audit] 写入失败:', (e as Error).message);
    }
  }
}

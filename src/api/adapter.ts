// ============ OA 内部适配层客户端 ============
// 统一认证版唯一的数据通道：
//   MCP（校验令牌、提取员工编号）
//     → 服务 JWT + X-Employee-No + X-Request-Id → OA 内部适配层（仅内网）
//       → 员工编号 → OA 用户上下文 → OA 原有权限 Service（行级权限）
// 废弃：WebBridge（127.0.0.1:10086 浏览器会话桥）、共享 OA Cookie。

import { ServerConfig } from '../config';
import { VerifiedIdentity } from '../auth/verify';

export class AdapterError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function callAdapter(
  cfg: ServerConfig,
  identity: VerifiedIdentity,
  module: string,
  action: string,
  body: Record<string, unknown>,
  reqId: string
): Promise<unknown> {
  const url = `${cfg.adapterUrl}/v1/${module}/${action}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.adapterTimeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.adapterServiceJwt}`,
        // 员工编号只来自已验证令牌，绝不接受工具入参或未签名 header
        'x-employee-no': identity.employeeNo,
        'x-request-id': reqId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new AdapterError(502, 'OA 适配层不可达（内网连通性/适配层服务异常）');
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    // 不透传适配层错误体，避免泄漏内部细节
    if (res.status === 401 || res.status === 403) {
      throw new AdapterError(res.status, 'OA 适配层拒绝服务身份（检查服务 JWT）');
    }
    if (res.status === 404) {
      throw new AdapterError(404, 'OA 适配层无该员工对应数据或接口不存在');
    }
    throw new AdapterError(res.status, `OA 适配层返回 ${res.status}`);
  }
  return json ?? {};
}

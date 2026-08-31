# OA 内部适配层接口规范（供 OA 开发实现，P4）

> 版本：V1.0 | 2026-08-31 | 山钢资本金融科技服务中心
> 定位：员工编号 → OA 用户上下文 → OA 原有权限 Service 的内网适配层
> 红线：仅内网暴露（不对公网开放）；服务间必须认证；字段白名单返回

## 一、部署与安全要求

1. 仅内网可达（运维配安全组/防火墙，不对公网暴露）；
2. 服务间认证：`Authorization: Bearer <服务JWT>`（密钥托管下发，与 MCP 侧 `OA_ADAPTER_SERVICE_JWT` 同值）；缺失/错误返回 401；
3. 身份来源：`X-Employee-No`（仅可信，因为来自 MCP 已验证令牌且经服务 JWT 保护的信道）；
4. 每次请求带 `X-Request-Id`，全链路日志记录，便于审计对账。

## 二、接口约定（MCP 侧已按此实现）

基址：`OA_ADAPTER_URL`（如 `http://内网地址/oa-adapter`）

### 2.1 通用请求
```
POST {base}/v1/{module}/{action}
Headers:
  Content-Type: application/json
  Authorization: Bearer <服务JWT>
  X-Employee-No: <员工编号>
  X-Request-Id: <16位hex>
Body: JSON 参数
```

### 2.2 已接入端点（v2.0.0 首批）

| module | action | 请求体 | 对应原 OA 接口 |
|--------|--------|--------|----------------|
| office | list | `{officenm?, address?, current=1, size=15}` | /SGSMTOAMGR/oa/office/list |
| office | detail | `{officeid}` | /SGSMTOAMGR/oa/office/detail（GET+query） |
| meetroom | list | `{roomnm?, capacity?, building?, current=1, size=15}` | /SGSMTOAMGR/oa/meetroom/list |
| meetroom | detail | `{roomid}` | /SGSMTOAMGR/oa/meetroom/detail（GET+query） |

### 2.3 响应约定
- 成功：`200` + 原 OA 响应体（含 `result.rows/totalCount` 结构，MCP 透传 `result`）；
- 员工未映射：`404 {"error":"employee not mapped"}`（MCP 对用户返回「无该员工对应数据」，不泄漏细节）；
- 服务认证失败：`401`；
- 其它错误：4xx/5xx + JSON（MCP 不透传错误体给用户，只记审计）。

## 三、内部实现要点（建议）

1. `员工编号 → OA 用户主键`映射表（与 MaxKey Claim 值一致，O08 一致性确认）；
2. 建立该用户的 OA 权限上下文，调用原权限 Service（行级权限自然生效）；
3. 字段白名单：按现有对外字段返回，避免内部字段外泄；
4. 剥离原 OA 响应中的 `Request-Header-Info` 头（实测回显完整 Cookie 明文）；
5. 日志：记录 X-Request-Id、员工编号、目标接口、耗时、结果码；禁记 Cookie/令牌。

## 四、验收标准（上线说明 P4）

- 双测试账号（权限不同）经适配层查询，返回各自权限数据，与 OA 页面基线一致；
- 无服务 JWT 的调用被拒（401）；
- 公网无法直达适配层（端口扫描/网关路由验证）。

# sgs-oa-mcp-server

山钢资本数智办公平台 MCP Server —— 统一认证（MaxKey OAuth2/OIDC）版。

> 版本 2.0.0（未发布，等待真实环境验收）。1.1.1 及以前的「共享静态 API Key + WebBridge/共享 Cookie」架构已废弃，禁止再部署。

## 认证模型

```
Agent ──① 无令牌 POST /mcp ──> 401 + WWW-Authenticate(resource_metadata)
Agent ──② GET /.well-known/oauth-protected-resource（RFC 9728）──> 指向 MaxKey
Agent ──③ MaxKey 授权码 + PKCE S256 登录（密码只提交给 MaxKey）──> 令牌
Agent ──④ Bearer 令牌 ──> MCP 校验 ──> 提取员工编号（只信已验证令牌）
MCP   ──⑤ 服务 JWT + X-Employee-No ──> OA 内部适配层（仅内网）──> OA 行级权限数据
```

- 方案 A（`AUTH_MODE=oidc`）：JWT RS256 + JWKS 验签（零第三方 JWT 依赖，node:crypto 实现）
- 方案 A'（`AUTH_MODE=oauth2-userinfo`）：令牌 + MaxKey userinfo 校验（OIDC 未启用时的降级路径）
- 员工编号只来自已验证令牌 Claim；审计日志仅记录员工编号哈希；限流（匿名按 IP、认证按员工）；会话身份绑定（防会话劫持）。

## 快速开始

```bash
npm install
npm run build          # tsc -> dist/
cp .env.example .env   # 填写配置（密钥经密钥托管注入，勿入库）
npm start              # node dist/index.js（HTTP 模式）
```

配置缺失（密钥类无默认值）时服务拒绝启动。

### 开发测试

```bash
node test/e2e.mjs      # 本地端到端：mock MaxKey IdP（真 RSA/JWKS）+ mock OA 适配层，18 项断言
```

## 端点

| 端点 | 鉴权 | 说明 |
|------|------|------|
| /health | 无 | 存活探针 |
| /.well-known/oauth-protected-resource | 无 | RFC 9728 PRM |
| /.well-known/oauth-authorization-server/sign | 无 | RFC 8414 AS 元数据镜像 |
| /mcp | Bearer | MCP Streamable HTTP（有状态会话，身份绑定） |
| /api/v1/tools/* | Bearer | REST 工具端点 |

## 工具

| 工具 | 说明 |
|------|------|
| search_office | 查询办公场所（本人权限） |
| get_office_detail | 办公场所详情 |
| search_room | 查询会议室（本人权限） |
| get_room_detail | 会议室详情 |
| get_investment_ledger_schema | 在投业务台账49列、筛选项与字典 |
| search_investment_ledger | 在投业务台账筛选与分页查询（本人OA权限） |
| export_investment_ledger | 自动翻完在投业务台账全部页面并做完整性检查 |

### 在投业务台账

数据来源：统一数据管理 → 投后数据统计 → 在投业务台账 → 在投业务台账列表。上游接口为 `/oamgr/SGMGR/sgproj/sgproj/list?type=1`。

- `view=raw`：返回 OA 原始字段，包含页面未展示的项目 ID、客户 ID 等。
- `view=display`：返回与页面 datagrid 一致的49列，保留金额单位、百分比和字典中文值。
- `view=both`：每行同时返回 `raw` 和 `display`，为默认值。
- 日常问答使用 `search_investment_ledger` 分页查询；批量取数使用 `export_investment_ledger`，它会翻到终止空页，不静默截断。
- 2026-11-11 测试环境实测上游 `total=3571`、实际取得 `3387` 行、终止空页为第19页（每页请求200行）。因此结果分别报告 `reportedTotal` 与 `rowCount`，不强行把二者改成一致。

三方 Agent 配置：远程 MCP URL 为 `{MCP_PUBLIC_URL}/mcp`，传输为 Streamable HTTP，认证使用本服务已配置的 MaxKey OAuth；不支持 OAuth 的旧客户端可调用同鉴权的 `/api/v1/tools/*` REST 端点。

## 安全红线（实现已强制）

1. 员工编号只来自已验证令牌，不接受工具入参或未签名 header；
2. 审计不记录令牌、Cookie、密码、明文员工编号；剥离 OA `Request-Header-Info` 回显；
3. 静态共享 API Key、共享 OA Cookie、WebBridge 会话桥、零鉴权代理已全部删除；
4. 密钥一律无默认值，缺失即拒绝启动；
5. stdio 模式仅限本地开发（`STDIO_ENABLED=true` + `STDIO_DEV_EMPLOYEE_NO`），生产必须 HTTP + OAuth。

## 文档

- `docs/在投业务台账MCP接入说明_V1.0.md` —— 台账工具、真实报文、调用关系图、流程图、时序图与三方接入
- `docs/verification/在投业务台账MCP独立验收_2026-11-11.md` —— 独立验收8项、异常处理与最终复验
- `docs/迁移方案定版_V1.1.md` —— 方案定版与交付清单
- `docs/MaxKey管理员前置申请单.md` —— 转发给 MaxKey 管理员
- `docs/OA适配层接口规范.md` —— 转发给 OA 开发
- `docs/统一认证改造验收结果清单_V2.md` —— 验收证据（13/13）
- 上线与回滚：《数智办公MCP统一认证上线与回滚说明_V1.0》（看板 t_bc7e4bc9 附件）

## License

MIT

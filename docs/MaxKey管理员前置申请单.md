# MaxKey 管理员前置申请单（可直接转发）

> 用途：数智办公 MCP 统一认证接入（测试环境）
> 申请人：山钢资本金融科技服务中心 | 日期：2026-08-31
> 实例：MaxKey v4.1.8 GA（山钢资本/山钢E键通），控制台 ptmtest.sgscf.com（内网）
> 对应前置项：P1/P2/P3（《上线与回滚说明》第二节）

## 一、请管理员完成的操作

### 1. 注册应用（P1）
| 字段 | 申请值 |
|------|--------|
| 应用名称 | 数智办公 MCP 测试环境 |
| 协议 | 优先 OIDC；若实例未启用则 OAuth2 v20 |
| 授权类型 | authorization_code（+refresh_token） |
| redirect_uri | （由 MCP 开发登记后提供，首批 Agent 回调，精确匹配） |
| token_endpoint_auth | 优先 `none` + PKCE（公共客户端） |
| 返回给我们 | **client_id**（测试环境） |

### 2. 书面确认（P2）——决定 MCP 侧 AUTH_MODE
1. OIDC 协议是否启用？（2026-08-14/08-31 实测 `/sign/authz/oidc/authorize` 返回 500，`/sign/api/connect/v10/userinfo` 存活）
2. 是否支持 PKCE S256（code_challenge_method=S256）？（官方文档未列，需实测/配置确认）
3. 若 OIDC 启用：JWKS 地址（RS256，keyId=maxkey_rsa）？MCP 服务器（或其代理）能否访问？
4. scope/audience 可用值；access_token 建议 15 分钟、refresh ≤ 8 小时是否可配？
5. 令牌撤销（revocation）是否可用？

### 3. 员工编号 Claim（P3，M15~M17）
- 请在令牌/用户属性中输出**员工编号**，值必须与 OA 员工编号一致；
- 回传 Claim 字段名（MCP 侧将配置 `EMPLOYEE_NO_CLAIM=<该字段名>`，默认假设为 employeeNumber）；
- 若通过用户属性扩展输出，请确认 userinfo（/sign/api/oauth/v20/me）返回体中包含该字段。

## 二、MCP 侧将使用的端点（已实测存活，2026-08-31）

| 用途 | 端点 |
|------|------|
| issuer | https://pttest.sgscf.com/sign |
| 授权 | https://pttest.sgscf.com/sign/authz/oauth/v20/authorize（302→登录页，存活） |
| 令牌 | https://pttest.sgscf.com/sign/authz/oauth/v20/token |
| userinfo | https://pttest.sgscf.com/sign/api/oauth/v20/me（存活） |
| OIDC userinfo（备用） | https://pttest.sgscf.com/sign/api/connect/v10/userinfo（存活） |

## 三、回执模板（请填写后回传）

```
client_id:
OIDC 是否启用: 是 / 否（→ MCP 用 AUTH_MODE=oidc / oauth2-userinfo）
PKCE S256: 支持 / 不支持（不支持时需评估强制 secret 的 Agent 兼容）
JWKS URL（若启用）:
员工编号 Claim 字段名:
scope/audience:
access/refresh 时长:
撤销支持: 是 / 否
```

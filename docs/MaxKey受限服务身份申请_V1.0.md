# MaxKey 受限服务身份申请 V1.0

> 用途：数智办公 MCP（`sgs-oa-mcp-server`）第三方/机器人调用的身份契约申请
> 实例：MaxKey 4.1.8 GA（山钢资本 / 山钢E键通，测试环境）`https://pttest.sgscf.com/sign`
> 核查方式：**只读**。13 次 HTTP 探测（未用任何凭据、未注册应用、未猜 client_id/secret）＋ 对照 MaxKey 4.1.8 源码
> 核查时间：2026-11-11T16:57+08:00
> 证据明细：`states/maxkey-delegation-check.json`（逐条请求/响应/结论）
> 申请人：山钢资本金融科技服务中心

---

## 一、一句话结论

**MaxKey 4.1.8 支持 `client_credentials`，但它只能代表"应用"，不代表"员工"；`token exchange` / on-behalf（RFC 8693）不支持。**
因此本产品能落地的委托契约只有一种：**员工在场时用 `authorization_code` 拿员工令牌**，MCP 侧经 userinfo 取 `employeeNumber` 做权限隔离。
若业务要求"员工不在场、机器人代某员工取数"，**必须由管理员侧新增能力**（MaxKey 定制或网关签发），不可用共享静态 Key、共享员工令牌、或让调用方自报员工号凑合。

---

## 二、实测结果（可复核）

| # | 探测 | 结果 | 含义 |
|---|---|---|---|
| P-01 | `GET /sign/.well-known/openid-configuration` | 200，`{"code":2,"message":"Internal Server Error"}` | 标准根路径无发现文档（MaxKey 不按 RFC 8414 根路径发布） |
| P-03 | `GET /sign/authz/oauth/v20/.well-known/openid-configuration` | 200，返回完整元数据 | **发现文档存在于非标准路径**；`grant_types_supported=["refresh_token","password","client_credentials","authorization_code"]` |
| P-04 | `GET /sign/authz/oauth/v20/.well-known/oauth-authorization-server` | 200 | `code_challenge_methods_supported=["S256"]`；`scopes_supported` 仅 `address/phone/openid/profile/email`；`claims_supported` 36 项**不含 employeeNumber**；`revocation_endpoint=null` |
| P-05 | `GET /sign/authz/oauth/v20/jwks` | `{"code":2,"message":"start 169, end 2026, length 63"}` | **JWKS 端点故障，取不到公钥** → MCP 不能做本地 JWT 验签 |
| P-06 | `POST /token` `grant_type=client_credentials`（无 client 认证） | 200，**空响应体**（Content-Length: 0） | 缺 client 认证时被过滤器吞掉，无标准错误体 |
| P-07 | `POST /token` `grant_type=password`（同条件） | `{"error":"invalid_request","error_description":"There is no client authentication..."}` | 对照组：证明 P-06 的空 200 是分支差异，不是网络问题 |
| P-08 | `POST /token` `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` | 200，空响应体 | 同 P-06；**运行期无法凭响应判定**，判据取源码（见 §三） |
| P-09 | `GET /authorize?...&client_id=probe-no-such-client` | 302 → `http://pttest.sgscf.com/sgsk/passport/login?redirect_uri=...` | 授权码链路存活；登录被委派到外部口令系统 `/sgsk/passport` |
| P-11 | `GET /sign/api/oauth/v20/me` + `Bearer probe-not-a-uuid` | `{"error":"token Format Invalid","error_description":"...probe-not-a-uuid"}` | **access_token 是不透明 UUID，不是 JWT** |
| P-12 | `GET .../me?access_token=<uuid 形态>` | `{"error":"invalid_token","error_description":"Invalid access token: ..."}` | userinfo 可用；错误走 body，HTTP 恒 200 |
| P-13 | `POST /sign/authz/oauth/v20/introspect` `token=probe`（无认证） | `{"token":"probe","active":false}` | **introspection 未做 client 认证**且回显 token；只有 `token/active/sub` 三个字段 |

源码判据（tag `4.1.8`）：

- `AbstractEndpoint.java` 第 104 行：`tokenGranters.add(new ClientCredentialsTokenGranter(...))` —— **client_credentials 确实注册**。
- `IntrospectEndpoint.java`：`//client_credentials` 分支 `sub = OAuth2Request.getClientId()` —— **令牌主体是 client 自己**。
- `TokenEndpointAuthenticationFilter.java`：client_credentials 分支用 `new SignPrincipal((User)auth.getPrincipal())`，该 `User` 来自 `ClientDetailsUserDetailsService`（username=clientId），**不携带任何员工属性**。
- `OAuthDefaultUserInfoAdapter.java` 第 57 行：`beanMap.put("employeeNumber", userInfo.getEmployeeNumber())` —— **userinfo 会输出员工编号**。
- `OIDCIdTokenEnhancer.java`：id_token 只写 `sub/exp/iss/aud/jti`(+auth_time/nonce/at_hash)，**不含员工属性**。
- 全仓检索 `token-exchange`、`urn:ietf:params:oauth:grant-type`、`impersonat`：**0 命中**；`OAuth2Constants` 只有 5 个 grant_type 常量。
- `endpoint` 目录无 `RevokeTokenEndpoint`；仅 `end_session_endpoint=/sign/force/logout`（会话登出，非令牌撤销）。
- `AppsOAuth20Details.java` 逐 client 字段：`authorizedGrantTypes`、`scope`、`accessTokenValiditySeconds`、`refreshTokenValiditySeconds`、`subject`、`audience`、`pkce`、`userInfoResponse`。
- 管理端应用编辑器 `app-oauth20-details-editer.component.html` 的授权类型下拉含 `client_credentials` 选项（可勾选、也可只勾 authorization_code）。

---

## 三、能力矩阵

| 能力 | 支持 | 判据 | 对 MCP 的意义 |
|---|---|---|---|
| authorization_code（员工在场的） | ✅ | P-03、P-09、源码 | **唯一能给出员工身份的路径** |
| refresh_token | ✅ | P-03、`DefaultTokenServices.setSupportRefreshToken(true)` | 员工会话续期；机器人不宜长期持有 |
| client_credentials | ⚠️ 支持但无员工身份 | 发现文档 + 源码（sub=clientId） | 只能当"应用身份"，**不能当员工身份**；MCP 会判 `no_employee_no` |
| token exchange / on-behalf（RFC 8693） | ❌ | 元数据未声明 + 源码 0 命中 | 机器人**无法**把自身凭据换成员工令牌 |
| 令牌撤销（RFC 7009） | ❌ | `revocation_endpoint=null` + 无端点类 | 只能用短 TTL + 会话登出 + 控制台删除 |
| introspection（RFC 7662） | ✅（无认证） | P-13 | 可查 active/sub，但字段不足以做权限判断 |
| PKCE S256 | 元数据声明支持 | P-04 | 员工端 H5 可用；换码是否强校验未验证 |
| employeeNumber claim | userinfo ✅ / id_token ❌ | 源码 adapter vs enhancer | **MCP 必须走 `AUTH_MODE=oauth2-userinfo`** |
| 自定义业务 scope | 未验证 | 发现文档只列 5 个标准 scope，per-client `scope` 为自由文本 | 需管理员确认能否登记如 `ledger.read` |

MCP 侧硬约束（来自 `docs/对外暴露与鉴权说明_V1.0.md` §4）：员工编号只从**已验证令牌**取；`X-Employee-No`、工具入参 `employeeNo` 一律忽略；不得开 `EMPLOYEE_NO_FALLBACK_SUB` 凑合。

---

## 四、申请项 A：受限 client（现有能力，可立即批）

### 4.1 应用注册

| 字段 | 申请值 | 理由 |
|---|---|---|
| 应用名称 | 数智办公 MCP 服务端（测试环境） | 与 MCP 实例一一对应 |
| 协议 | OAuth 2.0（OIDC 可选，MCP 不用 id_token） | access_token 为不透明 UUID，不依赖 OIDC |
| `authorized_grant_types` | **仅 `authorization_code`**（如需续期再加 `refresh_token`） | 最小集；**不要在同一个 client 上勾 client_credentials / password** |
| `token_endpoint_auth_method` | `client_secret_basic`（或 `client_secret_post`） | 服务端机密客户端；secret 只落服务端环境变量 |
| `registered_redirect_uris` | 精确回调（企微 H5 与门户各一条，`https`，无通配） | MaxKey 走精确匹配 |
| `accessTokenValiditySeconds` | **900**（15 分钟） | 无撤销端点，短 TTL 是主要收敛手段 |
| `refreshTokenValiditySeconds` | ≤ 28800（8 小时），或直接不启用 refresh | 与员工在岗时长对齐 |
| `scope` | 先按标准集 `openid profile`；若要业务 scope，请确认能否登记 `ledger.read` | 目前 `scopes_supported` 只有 5 个标准值 |
| `subject` | 保持 `username`（不要改成员工编号） | `employeeNumber` 由 userinfo 单独输出，改 subject 会影响其他接入方 |
| `pkce` | 若回调走浏览器，开启（S256） | 公共/半公共客户端防码拦截 |

### 4.2 员工编号 claim（P3 口径）

1. 请在**测试域用户目录**核对：两个测试账号的 `employeeNumber` 字段已用 **OA 员工编号**填充，且与 OA 侧完全一致（大小写、前导零、是否含字母）。
2. 请确认 `/sign/api/oauth/v20/me` 返回体包含 `employeeNumber`（源码第 57 行无条件输出；若实例为定制版请以实际响应为准）。
3. 回传 Claim 字段名。MCP 侧配置 `EMPLOYEE_NO_CLAIM=employeeNumber`（默认值）。
4. **明确不接受**：由网关注入 `X-Employee-No`、由调用方传 `employeeNo`、或把 `sub`/`username` 当员工编号兜底。

### 4.3 audience / scope 的真实约束（请知悉）

- MaxKey 的 `audience` 字段**不进入 access_token**；id_token 的 `aud` 恒为 `[clientId]`。因此"audience=MCP 资源标识"目前**无法表达**，MCP 侧以 userinfo + client 白名单做资源侧约束。
- 请确认：能否给 client 登记**非标准 scope**（如 `ledger.read`），以及 `DefaultOAuth2RequestValidator.validateScope` 是否会拒绝未登记值。若不能，MCP 侧改用 client 白名单 + 工具级 ACL，不依赖 scope。

### 4.4 撤销与失效

由于**无 RFC 7009 撤销端点**，请书面确认以下三条中哪些可用，并给出操作路径：

1. `accessTokenValiditySeconds` 生效（15 分钟自然过期）；
2. 控制台可**删除/停用该 client**，停用后其令牌立即失效（请确认是否立即）；
3. 会话级 `end_session_endpoint=/sign/force/logout` 或控制台"在线会话"踢出，是否覆盖 OAuth 令牌。

### 4.5 双测试账号

| 账号 | 要求 |
|---|---|
| T-01 | 员工 A，`employeeNumber` = OA 员工编号；在 OA 有可见台账数据 |
| T-02 | 员工 B，`employeeNumber` = OA 员工编号；在 OA **无**或**部分**可见数据（用于验证权限隔离，必须出现"看不到"的结果） |
| 禁止 | 任何共享账号、演示账号、管理员账号用于联调 |

### 4.6 回执模板

```
client_id:
client_secret 交付方式（密钥平台/一次性口令，勿贴聊天）:
authorized_grant_types:
token_endpoint_auth_method:
redirect_uris（精确）:
accessTokenValiditySeconds:
refreshTokenValiditySeconds:
scope（含可否自定义业务 scope）:
employeeNumber 是否已在 T-01/T-02 填充: 是/否（值请勿在此明文回传，只回"已核对"）
userinfo 返回 employeeNumber: 是/否
撤销路径（勾选 §4.4 的 1/2/3）:
PKCE 是否强制校验:
```

---

## 五、申请项 B：若需"员工不在场代取数"

**结论：MaxKey 4.1.8 现成能力做不到，需管理员立项新增。**

缺口（逐条对证据）：

1. 无 `token exchange`（RFC 8693）：机器人不能用自己的服务凭据换员工令牌 —— 元数据未声明，全仓 0 命中。
2. 无 on-behalf / `act` claim：令牌里无法表达"谁在代谁" —— `claims_supported` 36 项无委托语义字段，代码无 impersonation。
3. `client_credentials` 令牌 `sub=clientId`，`userinfo` 无法产出员工属性 —— 用它就是"应用身份读全量"，直接违反权限隔离。
4. 无令牌撤销端点，长时服务令牌无法快速止损。

可选实现路线（请管理员择一并报价/排期）：

| 路线 | 做法 | 代价 | 风险 |
|---|---|---|---|
| B1 MaxKey 定制 | 新增 RFC 8693 token exchange 或 `act` claim 扩展 | 版本分叉，升级要合并 | 中 |
| B2 受控网关签发 | 机器人→网关（服务凭据）→网关向 MaxKey 做**用户授权绑定**后签发短时令牌 | 新增一个需要审计的签名方 | 中高：等价于自建 IdP，需安全评审 |
| B3 不支持，改为"员工在场" | 机器人只做转发，员工在企微 H5 完成一次授权，令牌 15 分钟 | 交互成本 | 低（推荐先走这条） |

无论选哪条，验收契约至少包含：
- 令牌必须由 MaxKey（或经安全评审的签发方）签发，MCP 只信任该签发方的签名/JWKS；
- 令牌内必须含 `employeeNumber`，且**不接受**调用方自报；
- 有效期 ≤ 15 分钟，可即时失效；
- 代取数事件进审计日志（who-acted-as-whom）；
- 双测试账号验证：T-02 代取必须被拒。

---

## 六、明确不接受的替代方案

| 方案 | 为什么不行 |
|---|---|
| 共享静态 API Key | 无法归属到人，泄露即全量；`docs/对外暴露与鉴权说明_V1.0.md` §4 明令禁止 |
| 共享某个员工账号/令牌 | 审计失真，等同越权 |
| 网关/机器人把 `X-Employee-No` 传给 MCP 并让 MCP 信任 | 就是"信任自报身份"，任何调用方可伪造成任意员工 |
| 用 `client_credentials` 令牌走员工链路 | 令牌无员工编号，MCP 会判 `no_employee_no`；强行兜底 `sub` 等于把 clientId 当员工 |
| 开 `EMPLOYEE_NO_FALLBACK_SUB` | 同上，属安全评审项，不是运维配置项 |

---

## 七、请管理员一并确认的实例问题（不在本申请范围，但影响联调）

1. **JWKS 端点故障**：`/sign/authz/oauth/v20/jwks` 返回 `{"code":2,"message":"start 169, end 2026, length 63"}`。MCP 不用 JWT，但其他接入方会受影响。
2. **发现文档 issuer 与工程假设不一致**：元数据 `issuer=http://pttest.sgscf.com/sign/maxkey`（http + `/maxkey` 路径），工程原假设 `https://pttest.sgscf.com/sign`。请确认哪个是正确 issuer，以及是否应改为 https。
3. **introspection 无认证**：`POST /authz/oauth/v20/introspect` 无需 client 认证即可查任意 token 的 active/sub，且回显 token 明文（代码里 `clientAuthenticate()` 已写但未调用）。建议开启认证。
4. **发现文档声明 `password` grant 可用**：请确认生产/测试环境是否存在启用 password 的 client；MCP 不使用，但该模式扩大了凭据暴露面。
5. **token 端点缺认证时返回空 200**（`TokenEndpointAuthenticationFilter.onUnsuccessfulAuthentication()` 为空实现）：调用方无法区分"未认证"和"服务异常"，排障成本高。

---

## 八、验收清单（管理员批完后，MCP 侧按此逐条实测）

- [ ] 用 T-01 完成 authorization_code，拿到 access_token（UUID 形态）
- [ ] 用该 token 调 `/sign/api/oauth/v20/me`，响应含 `employeeNumber` 且等于 OA 编号
- [ ] 用 T-02 同链路，MCP 对 T-02 无权限的台账返回"不可见"而非空数据
- [ ] 换员工令牌复用同一 `Mcp-Session-Id` → `401 令牌身份与会话不匹配`
- [ ] 用 `client_credentials` 令牌（若有临时 client 可测）调 MCP → `401 no_employee_no`
- [ ] 伪造 `X-Employee-No` 头 → 被忽略
- [ ] 令牌 900 秒后过期 → `401`
- [ ] 停用 client / 登出会话后旧令牌 → `401`（按 §4.4 确认的路径）
- [ ] 审计日志只含 `employeeNoHash`，无明文员工号/令牌

# BTOS OAS 用户鉴权接入协议（v0.1 草案）

状态：草案，待 OAS 平台方确认  
范围：OAS 作为既有身份权威。本文只定义 BTOS 客户端、四宝、`cloud-root` 与 OAS 的接入契约，不定义 OAS 内部实现，也不在 BTOS 内新建账号体系。

## 1. 目标与非目标

### 目标

1. 用户身份只有一个权威来源：OAS。
2. 四宝与 `cloud-root` 不建账号、不存密码、不自行签发用户身份。
3. 移动端、H5、PC 壳使用统一授权流程，支持跨 App 单点进入。
4. 令牌短时效、可刷新、可撤销；租户与角色由 OAS 断言。
5. 现有 `dev:<tenantId>` 模拟令牌可在联调保留，但生产必须失败关闭。

### 非目标

- 不在本文定义 OAS 的登录页、账号注册、实名认证、密码策略。
- 不在本文定义四宝内部 RBAC；OAS 只给粗粒度角色，细粒度权限留在资源端。
- 不在本文定义支付、内容审核、商户资质。
- 不让 Beaulife 直接对接微信/支付宝/抖音等外部 IdP；外部联邦由 OAS 完成。

## 2. 角色与信任边界

| 角色 | 实例 | 信任级别 | 职责 |
|---|---|---|---|
| 身份权威 | OAS（`oas_mother` / `oas.cewaysoft.com` / `oas.cewaycloud.com`） | 根信任 | 认证用户、签发令牌、维护绑定、撤销会话 |
| 公共客户端 | Beaulife App、XU Web、四宝 H5 | 不可信 | 发起授权、保管短期令牌、换票、入口分发 |
| 资源服务器 | `cloud-root`、四宝后端、店根云接口 | 可信服务端 | 验票、校验租户/角色、返回业务数据 |
| 服务客户端 | `cloud-root` 服务进程 | 可信服务端 | Client Credentials 调用 OAS/商店接口 |
| 外部 IdP | 微信、Apple、支付宝、抖音 | 联邦身份源 | 仅由 OAS 对接，BTOS 客户端不直连 |

信任规则：

- 资源服务器只信任 OAS 签名或 OAS introspect 结果。
- 不信任客户端传来的 `tenant`、`roles`、`userId`。
- 不信任未验签的 JWT；未知 `kid` 直接失败。
- 不在 URL、日志、埋点中出现 access/refresh token 或 ticket 明文。

## 3. 身份模型

### 3.1 主体

- `sub`：OAS 用户唯一标识，BTOS 全链路使用该值，不另建 BTOS 用户 ID。
- `tenant`：当前租户/组织；单用户多租户时，令牌只带当前活跃租户。
- `roles`：粗粒度角色，如 `consumer`、`worker`、`merchant`、`tenant_admin`、`eco_admin`。
- `device_id`：客户端生成并持久化的设备标识；用于会话绑定与撤销。
- `client_id`：调用方标识，如 `btos.beaulife`、`btos.xu`、`btos.cloud-root`。

### 3.2 绑定

OAS 负责维护用户与外部平台账号的绑定关系。BTOS 只读取绑定结果，不保存外部平台长期令牌。

最小绑定信息：

| 字段 | 说明 |
|---|---|
| `provider` | `wechat` / `apple` / `alipay` / `douyin` / `phone` |
| `subject` | 平台侧 openid/unionid/sub |
| `display_name` | 仅授权范围内展示 |
| `bound_at` | 绑定时间 |
| `status` | `active` / `revoked` |

## 4. 授权流程

### 4.1 原生 App：Authorization Code + PKCE

适用于 Beaulife、Cajob、XSO、Xeco 的移动/桌面壳。

1. 客户端生成 `code_verifier`、`code_challenge`（S256）、`state`、`nonce`。
2. 用系统浏览器打开 OAS 授权页。
3. 用户在 OAS 完成登录（手机号/微信/Apple 等由 OAS 提供）。
4. OAS 回调 `redirect_uri`，返回 `code` 与 `state`。
5. 客户端校验 `state`，向 `/oauth/token` 换票。
6. 令牌写入安全存储；access token 只放内存。

授权请求示例：

```http
GET https://oas.cewaysoft.com/oauth/authorize?
  response_type=code&
  client_id=btos.beaulife&
  redirect_uri=beaulife://auth/callback&
  scope=openid%20profile%20phone%20btos.entry&
  state=<random>&
  nonce=<random>&
  code_challenge=<s256>&
  code_challenge_method=S256
```

换票请求示例：

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
code=<code>&
redirect_uri=beaulife://auth/callback&
client_id=btos.beaulife&
code_verifier=<verifier>
```

约束：

- 公共客户端不得内置 `client_secret`。
- 禁止 implicit 与密码模式。
- `redirect_uri` 必须精确匹配注册值，不允许通配。
- `state`、`nonce` 必填并校验。

### 4.2 Web/H5：Authorization Code + PKCE + 会话 Cookie

适用于 XU 门户与四宝 H5。

- 授权流程同上，回调到同站 `/auth/callback`。
- 服务端换取令牌后建立 `HttpOnly; Secure; SameSite=Lax` 会话 Cookie。
- access/refresh token 不下发浏览器 JS，不写 localStorage。
- 现有 `xoas_session` / `oas_session` 若保留，只能作为 OAS 会话载体；BTOS 业务会话必须由 OAS 断言派生。

### 4.3 跨 App 单点进入：ticket

1. Beaulife 已持有 access token。
2. 调用 `POST /identity/ticket`，声明目标 App 与设备。
3. OAS 或 BTOS 身份适配层签发一次性 ticket（建议 ≤ 60 秒）。
4. Beaulife 通过深链/Universal Link 把 ticket 交给目标 App。
5. 目标 App 调用 `POST /identity/ticket/exchange`，换取自己的会话。
6. ticket 消费即失效；重放返回 `TICKET_REPLAYED`。

ticket 必须绑定：

- `sub`
- `target`（如 `bjp` / `bhp` / `xso` / `xeco`）
- `device_id`
- `exp`
- 一次性随机值

若目标 App 未安装，回落到 H5 一次性 code；不得把 ticket 放进 Referer、日志或第三方统计。

### 4.4 服务端调用：Client Credentials

适用于 `cloud-root` 访问 OAS 管理接口或商店服务。

```http
POST /oauth/token
grant_type=client_credentials&
client_id=btos.cloud-root&
client_secret=<server-only>&
scope=btos.tenant.read%20store.license.read
```

`client_secret` 只放服务端环境变量，不进仓库、不进客户端包。

## 5. 端点契约

### 5.1 OAS 必须提供

| 方法 | 路径 | 调用方 | 说明 |
|---|---|---|---|
| GET | `/.well-known/openid-configuration` | 所有客户端 | OIDC 发现，含端点与 JWKS 地址 |
| GET | `/oauth/authorize` | 浏览器 | 授权码 + PKCE |
| POST | `/oauth/token` | 客户端 | code / refresh / client_credentials |
| GET | `/oauth/userinfo` | 客户端 | 当前用户最小资料 |
| POST | `/oauth/introspect` | 资源服务器 | 校验不透明令牌，返回 `active` 与 claims |
| POST | `/oauth/revoke` | 客户端 | 撤销 access/refresh |
| GET | `/oauth/jwks` | 资源服务器 | 公钥集，支持轮换 |

### 5.2 BTOS 身份适配层

若 OAS 不能扩展 ticket/会话端点，可由 BTOS 侧薄适配层实现；适配层仍以 OAS 为权威，不建账号。

| 方法 | 路径 | 调用方 | 说明 |
|---|---|---|---|
| POST | `/identity/ticket` | Beaulife | 用 OAS access token 换一次性 ticket |
| POST | `/identity/ticket/exchange` | 目标 App | 用 ticket 换目标 App 会话 |
| GET | `/identity/sessions` | 用户 | 列出设备与会话 |
| DELETE | `/identity/sessions/{id}` | 用户 | 撤销指定设备 |
| GET | `/identity/bindings` | 用户 | 列出已绑定平台（可选） |
| DELETE | `/identity/bindings/{provider}` | 用户 | 解绑平台（可选） |

适配层验票顺序：

1. 校验 OAS access token（JWKS 或 introspect）。
2. 校验 `scope` 含 `btos.entry`。
3. 校验 `sub`、`tenant`、`device_id`。
4. 生成 ticket 并落库/缓存。
5. 返回 ticket 与 `expires_in`。

### 5.3 ticket 交换

```http
POST /identity/ticket/exchange
Content-Type: application/json

{
  "ticket": "<opaque>",
  "target": "bjp",
  "device_id": "d_789"
}
```

成功：

```json
{
  "ok": true,
  "sub": "u_123",
  "tenant": "t_456",
  "roles": ["merchant"],
  "access_token": "<short-lived>",
  "refresh_token": "<rotating>",
  "expires_in": 900
}
```

失败：`TICKET_EXPIRED` / `TICKET_REPLAYED` / `TICKET_TARGET_MISMATCH` / `TICKET_DEVICE_MISMATCH`。

## 6. Token 与 claims

### 6.1 Access token

建议 JWT，短时效（5–15 分钟），由 OAS 签名。

```json
{
  "iss": "https://oas.cewaysoft.com",
  "sub": "u_123",
  "aud": ["btos.api", "cloud-root"],
  "client_id": "btos.beaulife",
  "scope": "openid profile btos.entry",
  "tenant": "t_456",
  "roles": ["consumer"],
  "amr": ["pwd", "wechat"],
  "acr": "a1",
  "device_id": "d_789",
  "exp": 1762400000,
  "iat": 1762399100,
  "jti": "at_..."
}
```

规则：

- `aud` 必须是具体资源，不接受空值或 `*`。
- `tenant` 为当前活跃租户；无租户场景可缺省。
- `roles` 只放粗粒度角色，不放权限点。
- 不放手机号、身份证、地址等敏感字段；需要时走 `/oauth/userinfo`。
- access token 只放内存，不落 localStorage/IndexedDB。

### 6.2 Refresh token

- 不透明字符串，服务端存储。
- 轮换签发，旧 token 立即失效。
- 检测到重用时撤销整个 token family。
- 绑定 `sub`、`client_id`、`device_id`。
- 建议 7–30 天；高风险场景缩短。

### 6.3 ID token

若使用 OIDC，ID token 只用于确认登录，不用于业务鉴权；业务鉴权一律用 access token。

## 7. Scope

| Scope | 用途 | 授予对象 |
|---|---|---|
| `openid` | OIDC 登录 | 所有用户客户端 |
| `profile` | 昵称/头像最小资料 | Beaulife、XU |
| `phone` | 手机号（单独同意） | Beaulife |
| `btos.entry` | 换取跨 App ticket | Beaulife |
| `btos.tenant.read` | 读取当前租户 | 四宝、cloud-root |
| `btos.roles` | 读取粗粒度角色 | 四宝、cloud-root |
| `store.license.read` | 商店许可只读 | cloud-root 服务端 |
| `store.license.write` | 商店许可写入 | cloud-root 管理端 |
| `offline_access` | 刷新令牌 | 需要静默续期的客户端 |

禁止使用通配 scope；新增 scope 必须走版本化评审。

## 8. 租户与角色

1. OAS 是租户归属的唯一来源。
2. `cloud-root` 的 `tenantOf()` 必须读取验签后的 `tenant`，不得读取客户端 header。
3. 资源服务器按 `aud` + `scope` + `tenant` 做准入；角色只做粗粒度分流。
4. 多租户用户切换租户时，重新走授权或使用受控的 token exchange；不得由客户端改 claim。
5. 未知租户、缺失租户、租户与资源不匹配一律拒绝。

## 9. 错误模型

OAuth 标准错误：

| HTTP | `error` | 场景 |
|---|---|---|
| 400 | `invalid_request` | 缺参、redirect_uri 不匹配 |
| 400 | `invalid_grant` | code 过期、PKCE 失败、refresh 失效 |
| 401 | `invalid_client` | 客户端认证失败 |
| 400 | `invalid_scope` | scope 未注册或越权 |
| 400 | `unsupported_grant_type` | 未支持的授权类型 |

BTOS 扩展错误体：

```json
{
  "error": "invalid_grant",
  "error_description": "ticket_expired",
  "code": "TICKET_EXPIRED",
  "traceId": "tr_..."
}
```

要求：

- 不泄露“用户是否存在”。
- 不返回 token 片段、内部堆栈、OAS 上游原始错误。
- 401 带 `WWW-Authenticate: Bearer`。
- 资源服务器统一返回 401/403，不把 OAS 错误原样透传给前端。

## 10. 安全要求

### 必须

- 全链路 HTTPS；HSTS。
- 公共客户端强制 PKCE S256；校验 `state` 与 `nonce`。
- `redirect_uri` 精确白名单，禁止通配与开放重定向。
- 刷新令牌轮换与重用检测。
- 令牌撤销、设备下线、全设备登出。
- JWKS 缓存与轮换；未知 `kid` 失败关闭。
- 限流：授权、换票、ticket 交换、introspect。
- 审计：登录、绑定、解绑、换票、撤销、失败原因。
- 日志脱敏：token、ticket、code、手机号、openid 一律打码。
- 用户同意与撤回；最小必要数据；可删除。

### 禁止

- 在客户端内置 `client_secret`。
- 在 localStorage / URL / 日志中保存 access/refresh token。
- 使用 implicit、密码模式、自制签名令牌。
- 由客户端自报 tenant/roles。
- 用昵称/头像自动合并账号。
- 直接把微信/支付宝等外部令牌当 BTOS 令牌使用。

## 11. 现有系统改造点

### 11.1 `cloud-root`

现状：`tenantOf()` 用 `Bearer dev:<tenantId>` 模拟。

改造：

```js
async function tenantOf(req) {
  const token = bearer(req);
  const claims = await verifyOasToken(token); // JWKS 或 introspect
  if (!claims.tenant) throw new AuthError('tenant_missing');
  return claims.tenant;
}
```

环境变量建议：

```bash
OAS_ISSUER=https://oas.cewaysoft.com
OAS_AUDIENCE=btos.api
OAS_CLIENT_ID=btos.cloud-root
OAS_CLIENT_SECRET=<server-only>
OAS_JWKS_CACHE_MS=3600000
ALLOW_DEV_TOKEN=0
```

`ALLOW_DEV_TOKEN` 只允许测试环境为 `1`；生产缺失或为 `0` 时必须拒绝 `dev:`。

### 11.2 壳与四宝

- `allowNavigation` 只放精确 OAS 主机，不使用 `*.cewaycloud.com`。
- 移动端使用系统浏览器完成 OAuth，不在 WebView 内嵌登录页。
- 回调使用已注册的 scheme / Universal Link；每个宝独立 scheme。
- ticket 放深链时只出现一次，App 读取后立即清除。
- 壳不实现用户身份；只保管令牌、发起授权、换票、传票。

### 11.3 兼容旧会话

- 现有 `xoas_session` + `oas_session` 成对有效的方案可保留为 Web 会话过渡。
- 新协议下，Web 业务会话由 OAS 断言派生；旧 Cookie 只作为 OAS 会话载体。
- 过渡期同时支持 Cookie 与 Bearer，但资源服务器必须统一走同一个 `tenantOf()`。

## 12. 验收与一致性测试

| 用例 | 期望 |
|---|---|
| 缺失 token | 401 |
| 过期 token | 401 |
| 错误 `aud` | 401 |
| 未知 `kid` | 401 |
| 已撤销 token | 401 |
| 缺失 `tenant` | 403 |
| scope 不足 | 403 |
| 客户端自报 tenant 与 token 不一致 | 403 |
| PKCE 缺失/降级 plain | 400 `invalid_grant` |
| `redirect_uri` 不匹配 | 400 `invalid_request` |
| ticket 过期 | 400 `TICKET_EXPIRED` |
| ticket 重放 | 400 `TICKET_REPLAYED` |
| ticket 目标不匹配 | 400 `TICKET_TARGET_MISMATCH` |
| ticket 设备不匹配 | 400 `TICKET_DEVICE_MISMATCH` |
| refresh 重用 | 撤销 family，401 |
| 解绑后旧令牌 | 401 |
| OAS 不可达 | 失败关闭，503/401，不透传业务数据 |

## 13. 待 OAS 平台方确认

1. OAS 是否支持 OIDC discovery 与 JWKS？
2. `/oauth/introspect` 是否存在？客户端认证方式是什么？
3. access token 是 JWT 还是不透明令牌？
4. `tenant`、`roles` 的 claim 名称与取值是否已固定？
5. 是否支持公共客户端 + PKCE？还是必须走 BFF？
6. 是否提供 ticket/会话撤销扩展？还是由 BTOS 适配层实现？
7. 现有 `xoas_session` / `oas_session` 的域、有效期与撤销方式。
8. 微信/Apple/支付宝/抖音联邦是否已由 OAS 完成？
9. 多租户切换是否支持 token exchange？
10. 审计日志与保留周期。

## 14. 版本与变更

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-11-06 | 首版草案：授权码 + PKCE、ticket 跨 App、claims/scope、错误与验收 |

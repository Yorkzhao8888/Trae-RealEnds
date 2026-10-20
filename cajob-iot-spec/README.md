# IoT 设备令牌 API 设计 Spec

> 状态：待实现｜目标：无浏览器的 IoT 设备（智能音箱/传感器/扫码枪）能调 Cajob 后端 API
> 参考：RFC 6749 OAuth 2.0 Client Credentials Grant + FIDO2 Device

## 为什么需要这个

当前 API 鉴权是 OAuth + cookie（浏览器会话）。IoT 设备没有浏览器，也不方便存 cookie。需要一个**设备令牌**机制让 IoT 设备直接调 `/api/backend/*`。

## 设备模型

```
IoT 设备（有唯一硬件标识）
  │
  │  首次配对（二维码 / NFC / App 绑定）
  ▼
后端签发 device_token（长期，默认 180 天）
  │
  │  每次 API 请求带 Header: Authorization: Bearer <device_token>
  ▼
后端校验 token → 识别设备 → 识别绑定的用户身份
```

## API 端点

### 1. 设备注册（首次配对）

```
POST /api/backend/device/register
Content-Type: application/json

{
  "device_name": "收银扫码枪 #A17",
  "device_type": "barcode_scanner",    // barcode_scanner | smart_speaker | sensor | kiosk | custom
  "hardware_id": "A17-20261019-XXXX",   // 设备出厂唯一编号
  "public_key": "-----BEGIN PUBLIC KEY-----\n...",   // 可选：Ed25519 公钥（后续验签）
  "owner_xu": "phone:13927411918",      // 绑定到哪个用户（通过 App 扫码填入）
  "scopes": ["chat:read", "order:read", "order:write", "profile:read"]
}
```

**响应：**

```json
{
  "ok": true,
  "device_id": "dev_A17abc123",
  "device_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_at": "2027-04-16T08:00:00Z",
  "scopes": ["chat:read", "order:read", "order:write", "profile:read"]
}
```

### 2. 设备令牌续期（过期前 7 天内调）

```
POST /api/backend/device/refresh
Authorization: Bearer <device_token>
Content-Type: application/json

{ "device_id": "dev_A17abc123" }
```

**响应：** 同注册，返回新 token（旧 token 失效，原子切换）

### 3. 设备令牌吊销（用户解绑）

```
POST /api/backend/device/revoke
Authorization: Bearer <device_token>
Content-Type: application/json

{ "device_id": "dev_A17abc123", "reason": "user_unbound" }
```

### 4. 设备列表（H5 / App 里看自己绑了哪些设备）

```
GET /api/backend/device/list
Authorization: Bearer <device_token> 或普通 OAuth cookie
```

**响应：**

```json
{
  "ok": true,
  "data": [
    { "device_id": "dev_A17abc123", "device_name": "收银扫码枪 #A17", "device_type": "barcode_scanner",
      "last_seen": "2026-10-19T09:15:00Z", "scopes": ["chat:read", "order:read"], "status": "active" }
  ]
}
```

## 鉴权中间件逻辑

后端 API 层统一加一层判断：

```
请求进来
 │
 ├─ 有 Cookie（xoas_session + oas_session）？
 │    └─ 走现有 OAuth 会话逻辑（浏览器端）
 │
 ├─ 有 Authorization: Bearer 前缀？
 │    └─ 走设备令牌逻辑（IoT 端）
 │         │
 │         ├─ JWT 解密 → payload.device_id → Redis/DB 查设备
 │         ├─ 检查 expires_at
 │         ├─ 检查 scopes 是否覆盖当前 API 需要的 scope
 │         ├─ 注入 ctx.identity = { kind: 'device', device_id, owner_xu, scopes }
 │         └─ 放行
 │
 └─ 都没有 → 401 Unauthorized
```

## 设备令牌 JWT Payload 结构

```json
{
  "sub": "dev_A17abc123",
  "kind": "device",              // ← 和用户 token 区分开（用户 token 是 kind: user）
  "owner_xu": "phone:13927411918",
  "scopes": ["chat:read", "order:read", "order:write", "profile:read"],
  "iat": 1729386000,
  "exp": 1744938000,             // 180 天
  "iss": "https://oas.cewaycloud.com"
}
```

## 现有 API 需要的 scope（对齐）

| API | 需要 scope |
|---|---|
| `GET /chat/conversations` | `chat:read` |
| `POST /chat/conversations/{id}/messages` | `chat:write` |
| `GET /chat/conversations/{id}/messages` | `chat:read` |
| `GET /order/list` | `order:read` |
| `POST /order/{id}/accept` | `order:write` |
| `GET /profile/me` | `profile:read` |
| `POST /friend/batch` | `friend:write` |

## 安全红线

| 项 | 要求 |
|---|---|
| 传输 | token 只走 HTTPS，API 层拦截 http 明文凭据 |
| 存储 | IoT 设备端 token 存 Secure Storage / TEE（不要硬编码） |
| 泄露应对 | 支持吊销 + 设备注册带硬件指纹（hardware_id 白名单） |
| 权限最小化 | 注册时 scopes 必填，后端按申请给最小集合 |
| 速率限制 | 设备 IP + device_id 双维度限频（防止被刷） |
| 审计 | 所有设备 API 调用打日志（device_id + endpoint + status + time） |

## 配对流程（App 扫码绑定）

```
1. IoT 设备首次启动 → 屏幕显示二维码（编码 device_name + hardware_id + 一次性 nonce）
2. 用户在 H5/App 里扫二维码 → 前端调 POST /device/register（owner_xu 自动填入当前登录用户）
3. 后端签发 device_token → 返回前端 → 前端 POST 到设备的本地 HTTP server（设备监听 127.0.0.1:8080）
4. 设备存好 token → 配对完成
```

## 部署优先级

- **Phase 2-1**（手表/扫码枪需要）：device/register + device/list + 鉴权中间件三选一 + scope 映射
- **Phase 2-2**（完整 IoT 上线）：refresh + revoke + 设备管理 + 审计日志 + 限频
- **Phase 3**：Ed25519 公钥验签（高安全设备）+ mTLS（有屏自助终端）

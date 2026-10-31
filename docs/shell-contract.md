# 真实端壳契约 v0.3.2

> 适用范围：`Trae-RealEnds` 内全部壳工程（App / 小程序 / PC / 浏览器兜底）。
> 本文件是**唯一真相**：壳、H5、发行部署都以本文对齐。改契约先改本文，再改实现。

---

## 0. 角色与红线

| 角色 | 持有 | 不持有 |
|---|---|---|
| 云根 | 全局真相：跨店库存、结算、风控、权限矩阵 | 设备状态 |
| 店根（PC 壳 / 门店网关） | 店内真相副本：本店库存、工位/桌台、离线额度 | 跨店结算 |
| 端壳（App / 小程序 / PC 客户端 / 浏览器） | 会话、缓存、离线队列、设备画像、地理与网络上下文 | 任何业务裁决 |

**红线**：壳只决定「怎么送、送多少、何时送」；「送什么、算得对不对」由云根/店根决定。
壳内不得本地判定优惠、改订单状态、改金额。

---

## 1. 版本与命名

| 字段 | 当前值 | 说明 |
|---|---|---|
| `contractVersion` | `0.3.2` | 本文版本，语义化 |
| `shellVersion` | 各壳自报 | 壳内核版本 |
| `appVersion` | 各壳自报 | 商店发版版本 |

品牌命名空间统一为 `window.Shell`，品牌别名保留兼容：

| 品牌 | 统一入口 | 兼容别名 | 事件前缀 |
|---|---|---|---|
| 知味工场 | `window.Shell` | `window.ziwayOS` | `shell:` / 兼容 `ziwayos:` |
| 捷才工友 | `window.Shell` | `window.jechanOS` | `shell:` / 兼容 `jechan:` |
| XSO | `window.Shell` | `window.xsoOS` | `shell:` / 兼容 `xso:` |
| Cajob | `window.Shell` | `window.cajobOS` | `shell:` / 兼容 `cajob:` |

> 兼容别名保留 2 个大版本，H5 逐步迁移到 `window.Shell`。

---

## 2. 能力清单（capabilities）

能力 ID 采用 `域.能力` 命名。H5 **禁止用 UA 判断能力**，只读 `capabilities`。

### 2.1 核心（所有壳必须具备）

| 能力 | 说明 |
|---|---|
| `core.bridge` | 桥存在，可调用 |
| `core.ready` | 支持 `shell:ready` 握手 |
| `core.statusBar` | 状态栏样式与颜色 |
| `core.backButton` | 硬件返回键拦截与回退 |
| `core.splash` | 启动屏控制 |
| `core.openExternal` | 外部浏览器/系统应用打开 |
| `core.vibrate` | 震动反馈 |
| `core.safeArea` | 安全区上报 |

### 2.2 可选能力

| 能力 | 说明 | 权限 |
|---|---|---|
| `core.share` | 系统分享面板 | 无 |
| `core.push` | 推送注册与消息 | 通知 |
| `core.deeplink` | 深链接收与验签 | 无 |
| `geo.current` | 单次定位 | 定位 |
| `geo.watch` | 持续/后台定位 | 定位（后台） |
| `io.camera` | 拍照/录像 | 相机 |
| `io.file` | 选择与保存文件 | 存储 |
| `io.clipboard` | 读写剪贴板 | 无 |
| `net.state` | 在线状态、网络类型、延迟 | 无 |
| `net.offlineQueue` | 离线写队列（P1） | 无 |
| `store.localMirror` | 本地只读镜像（P1） | 无 |
| `edge.storeRoot` | 接入店根（P2） | 无 |
| `sec.attest` | 设备密钥签名 | 无 |
| `obs.telemetry` | 端上可观测上报 | 无 |
| `policy.fetch` | 拉取云端边缘策略 | 无 |
| `sys.biometric` | 生物识别 | 生物识别 |

### 2.3 平台支持矩阵

`✓` 原生可用　`◐` 降级可用　`—` 不适用　`✗` 不支持

| 能力 | Android | iOS | 微信小程序 | Windows | macOS | 浏览器 |
|---|---|---|---|---|---|---|
| `core.bridge` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `core.statusBar` | ✓ | ✓ | ◐ | — | — | ✗ |
| `core.backButton` | ✓ | ◐ | ◐ | ✗ | ✗ | ✗ |
| `core.splash` | ✓ | ✓ | ◐ | ✓ | ✓ | ✗ |
| `core.openExternal` | ✓ | ✓ | ✗ | ✓ | ✓ | ◐ |
| `core.vibrate` | ✓ | ◐ | ✓ | ✗ | ✗ | ⚙ |
| `core.share` | ✓ | ✓ | ◐ | ◐ | ◐ | ◐ |
| `core.push` | ✓ | ✓ | ✗ | ◐ | ◐ | ✗ |
| `core.deeplink` | ✓ | ✓ | ◐ | ✓ | ✓ | ✗ |
| `geo.current` | ✓ | ✓ | ◐ | ✗ | ✗ | ◐ |
| `geo.watch` | ✓ | ◐ | ✗ | ✗ | ✗ | ✗ |
| `io.camera` | ✓ | ✓ | ✓ | ◐ | ◐ | ◐ |
| `net.state` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `net.offlineQueue` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `sec.attest` | ✓ | ◐ | ✗ | ✓ | ◐ | ✗ |
| `obs.telemetry` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

小程序 `core.vibrate` 走 `wx.vibrateShort`；`push` 在小程序为 ✗，改用订阅消息（`core.subscribe`，另列）。

---

## 3. 握手协议

页面加载后壳必须立即派发一次：

```js
window.dispatchEvent(new CustomEvent('shell:ready', {
  detail: {
    contractVersion: '0.3.2',
    shellVersion: '0.1.0',
    appVersion: '0.1.0',
    brand: 'ziway',
    platform: 'android',        // android | ios | mp-weixin | win32 | darwin | browser
    capabilities: ['core.bridge', 'core.statusBar', 'net.state', /* ... */],
    locale: 'zh-CN',
    device: { model: 'Pixel 6', osVersion: '14' },
    net: { online: true, type: 'wifi', latencyMs: 42 },
    safeArea: { top: 24, bottom: 16, left: 0, right: 0 },
    ends: ['hp', 'cp', 'ep', 'sp'],   // 该壳支持的身份端
    currentEnd: 'hp'
  }
}))
```

H5 若在 `DOMContentLoaded` 后仍未收到（超时 1.5s），视为「非壳环境」，退化为纯网页模式。
壳必须支持**重放**：H5 通过 `Shell.call('core.handshake')` 补取当前握手快照。

---

## 4. 调用协议

统一为异步：

```ts
Shell.call<Method extends CapabilityMethod>(method: Method, args?: Input): Promise<Output>
```

- 方法名 = 能力 ID + 动作：`core.statusBar.setStyle`、`net.offlineQueue.enqueue`。
- 未声明能力的方法调用 → 立即 reject `E_UNAVAILABLE`，不得静默。
- 所有调用必须带 `timeout`（默认 10s，定位 20s，文件 60s）。

### 4.1 错误码

| 码 | 含义 | H5 应做 |
|---|---|---|
| `E_UNAVAILABLE` | 平台不支持 | 隐藏入口或改降级路径 |
| `E_PERMISSION_DENIED` | 权限被拒 | 引导开启，不重复弹窗 |
| `E_USER_CANCEL` | 用户取消 | 静默 |
| `E_TIMEOUT` | 超时 | 可重试一次，然后降级 |
| `E_OFFLINE` | 当前离线 | 转离线队列 |
| `E_CONFLICT` | 版本冲突 | 拉快照后重试 |
| `E_RATE_LIMITED` | 频控 | 退避 |
| `E_BAD_ARGS` | 参数错 | 开发期修复，不得重试 |
| `E_INTERNAL` | 壳内部错误 | 上报 + 降级 |

---

## 5. 事件

统一前缀 `shell:`。所有事件必须带 `ts`（单调毫秒）与 `seq`。

| 事件 | 载荷 | 说明 |
|---|---|---|
| `shell:ready` | 见第 3 节 | 握手 |
| `shell:resume` / `shell:pause` | `{ts}` | 前后台 |
| `shell:net-change` | `{online, type, latencyMs}` | 网络变化 |
| `shell:back` | `{level}` | 返回键意图，H5 可 `preventDefault` |
| `shell:push-token` | `{token, provider}` | 推送令牌 |
| `shell:push-received` | `{payload, foreground}` | 收到通知 |
| `shell:push-action` | `{action, payload}` | 用户点通知 |
| `shell:deeplink` | `{url, verified}` | 深链，`verified=false` 必须丢弃 |
| `shell:permission-change` | `{name, state}` | 权限变化 |
| `shell:queue-flush` | `{confirmed, conflicts, rolledBack}` | 队列回放结果 |
| `shell:policy-update` | `{version, patch}` | 边缘策略更新 |
| `shell:error` | `{code, method, detail}` | 壳内部错误 |

---

## 6. 降级矩阵

| 场景 | 壳行为 | H5 可见信号 |
|---|---|---|
| 完全无网 | 读本地镜像；写全部入队；顶部提示 | `net.online=false` |
| 弱网（>800ms 或丢包>5%） | 图片降质量、非关键请求延后、预取暂停 | `net.quality='poor'` |
| 定位权限拒绝 | 不重复弹窗，走手动选择地址 | `capabilities` 不含 `geo.current` |
| 通知权限拒绝 | 站内消息兜底 | `core.push` 降级 |
| 进入后台 | 暂停轮询与动画，保留队列 | `shell:pause` |
| 存储不足 | 只保留队列，清镜像缓存 | `shell:error` `E_INTERNAL` |
| 壳版本过低 | 显示升级引导页，不静默降级 | `contractVersion` 比对 |

---

## 7. 权限时机表

| 权限 | 申请时机 | 禁止 |
|---|---|---|
| 通知 | 用户首次产生「需要被提醒」的行为后 | 冷启动即弹 |
| 定位 | 用户触发「附近/到店」功能时 | 首屏静默申请 |
| 相机 | 用户点击扫码/拍照时 | 后台预申请 |
| 相册/文件 | 用户点击上传时 | 启动即申请 |
| 生物识别 | 用户开启「快速登录」时 | 强制 |

原则：**先解释后申请**，被拒后提供手动路径，不在同一次会话重复弹窗。

---

## 8. 离线契约（P1）

### 8.1 队列条目

```json
{
  "id": "uuidv7",
  "seq": 12,
  "op": "order.create",
  "risk": "money | stock | read",
  "payload": {},
  "idem": "sha256(op + payload + subjectId + dayKey)",
  "clientWall": "2026-10-30T14:20:00+08:00",
  "mono": 1024,
  "device": "dev-fp-xxxx",
  "schema": "order.create/v1",
  "state": "queued | inflight | confirmed | conflict | rolled-back | rejected"
}
```

### 8.2 规则

1. **幂等键必填**，服务端按 `idem` 去重，重放 N 次只生效一次。
2. **排序用 `seq` + 单调时钟**，不信任设备墙钟。
3. **只追加不改写**：状态迁移只允许单向，保留完整迁移日志。
4. **回放分批**，每批 ≤20 条，按 `seq` 升序；单批内同 `risk` 归类。
5. **结果映射**：`2xx/202` → `confirmed`；`409` → `conflict`（按第 9 节裁决）；`410` → `rolled-back`；`4xx` 参数类 → `rejected`（不再重试）。
6. **离线额度**：`risk=money` 的条目需携带租约 `leaseId`，额度、单笔上限、TTL 由云根下发；超时未联网则自锁为只读。

### 8.3 本地镜像

- 按 `subjectId + role` 裁剪，只缓存该身份可见的读模型。
- 带 `etag` 与 `schemaVersion`；`schema` 变更时整体废弃重建。
- 上限（默认）：≤50MB、≤2 万条；超限按 LRU 淘汰。

---

## 9. 冲突裁决

| 风险类 | 冲突策略 | 责任方 |
|---|---|---|
| `money` | 不自动通过：进人工复核队列，前端显示「待确认」 | 云根 |
| `stock` | 店根按版本号裁决，失败方回滚并提示 | 店根 |
| `read` / 展示类 | 后写优先（LWW），静默覆盖 | 端壳 |
| 身份/权限类 | 一律以云根为准，端立即降级 | 云根 |

禁止：端壳对 `money` 类做任何本地裁决。

---

## 10. 店根契约（P2 概要）

端壳 ↔ 店根（PC 壳本地 HTTP，局域网内，端口约定 `7321`）：

| 接口 | 作用 |
|---|---|
| `POST /edge/lease` | 端获取店内租约：`{leaseId, ttl, limits}` |
| `POST /edge/commit` | 原子提交 `{leaseId, ops[]}`，整批成功或整批失败 |
| `GET /edge/snapshot?since=` | 拉取店内读模型增量 |
| `GET /edge/catalog` | 店根商品读模型 + 下行游标 |
| `GET /edge/ui/conflicts` | 冲突复核运营页（静态免鉴权；页内数据接口仍要 token） |
| `GET /edge/health` | 店根存活与云根连通性 |

店根 ↔ 云根（服务端之间，双向游标、各自独立；参考实现见 `cloud-root/`）：

| 接口 | 方向 | 作用 |
|---|---|---|
| `POST /cloud/events` | 店根 → 云根 | 上行事件批量回传；`409` 停在冲突点、不跳过 |
| `GET /cloud/catalog?since=` | 云根 → 店根 | 下行商品/价格增量；整批落库后才推进游标 |

规则：
- 单事务提交，带 `version`；冲突返回 `409` 与当前版本，端必须重拉快照。
- 端离线超过租约 TTL 自动降为「只读」，不允许继续成交。
- 店根与云根断开时，店根标记 `cloudOffline=true`，端据此切换降级文案。
- 上行与下行互不阻塞：下行失败不置 `cloudOffline`、不参与上行退避；重复下发幂等（不重复写事件）。

---

## 11. 安全基线

1. **导航白名单**：仅允许业务域，外部链接一律 `openExternal`，禁止 WebView 内跳转第三方。
2. **深链验签**：`brand://open?u=<base64url>&ts=&sig=<hmac>`，签名失败或 `ts` 超 5 分钟一律丢弃。
3. **短票据**：离线授权票据有效期 ≤10 分钟，设备密钥签名，服务端可达即吊销。
4. **证书固定**：P1 起对主业务域开启。
5. **日志脱敏**：手机号、身份证、定位、地址在落盘与上报前脱敏。
6. **不落敏感明文**：队列与镜像中禁止存放支付凭证原文。

---

## 12. 自检页（每壳内置）

路径 `shell-selftest`，10 项，逐项输出 `pass / fail / unsupported` 与详情，可导出 JSON：

| # | 检查 |
|---|---|
| 1 | 桥存在，`capabilities` 非空且与平台矩阵一致 |
| 2 | 收到 `shell:ready`，含 `safeArea` 与 `ends` |
| 3 | 状态栏样式生效（颜色与前景对比达标） |
| 4 | 返回键拦截不穿透，连续回退到身份选择页 |
| 5 | 震动可用或明确 `unsupported` |
| 6 | 分享面板可唤起 |
| 7 | 定位授权流程与拒绝路径正确 |
| 8 | 推送令牌就绪，或明确 `unsupported` + 站内兜底 |
| 9 | 飞行模式切换触发 `shell:net-change` |
| 10 | 断网兜底页可打开，镜像可读 |

---

## 13. 验收（Definition of Done）

- [ ] 九壳 `capabilities` 与第 2.3 节矩阵一致，差异仅限平台
- [ ] `shell:ready` 1.5s 内到达；超时降级路径可走
- [ ] 自检页 10/10（或明确 `unsupported` 项 ≤2 且已登记）
- [ ] 断网冷启动 ≤1s 出本地内容
- [ ] 队列 100% 落地，联网重放零重复、零丢失
- [ ] 无 UA 判断残留（H5 侧 grep 校验）
- [ ] 白屏、崩溃、权限拒绝率可回流，带品牌/端/版本/页面

---

## 14. 变更流程

1. 改能力或事件 → 先改本文并升级 `contractVersion`。
2. 破坏性变更走 major，壳与 H5 同时发；只增不改走 minor。
3. 每壳 README 记录「已实现能力 / 未实现能力 / 降级说明」。
4. 发布前跑 `scripts/contract-check.mjs`（校验各壳生成的 `capabilities` 与本文矩阵一致）。

---

## 15. 分期

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 本契约 + 自检页 + `capabilities` 上报 | 进行中 |
| P1 | 本地镜像 + 离线队列 + 幂等重放 + 策略下发 | 待启动 |
| P2 | 店根（PC 壳本地库、局域网发现、原子扣减、上行回传/下行读模型/退避调度） | 已实现（`edge-store/`） |
| P3 | 策略自动调优、围栏触发、批量对账 | 规划中 |

---

## 16. v0.3.0 变更（UendOS SDK 化）

本版不改变运行时行为（`shell-core` 仍为 v0.2.0，能力矩阵、事件、错误码、握手字段不变），新增的是**工程化契约**：

1. **配置契约**：`uendos.config.json`（`schemaVersion: 1`）与 `schema/uendos.config.schema.json` 固化品牌、端、targets、包名等字段；`@uendos/contract` 的 `validateConfig()` 为唯一校验入口。
2. **工具链契约**：`uendos init/add-end/sync/doctor/conformance/pack/publish`，其中 `sync --check` 要求生成产物与配置严格一致（CI 拦截手改）。
3. **一致性契约**：`@uendos/conformance` 用 39 项断言（结构 8 / 握手 4 / 端切换 4 / 事件 4 / 错误协议 5 / 离线队列 6 / 店根适配 6 / 契约自洽 2）在 vm 沙箱验收任意品牌桥，无需真机。
4. **文档入口**：开发者指南见 [`sdk/README.md`](../sdk/README.md)；运行时源码唯一真相仍为 `shell-core/src/core.js`。

---

## 17. v0.3.1 变更（一键出包）

运行时与 39 项断言不变；本版补齐「从工程到安装包」的工具链：

1. **启动模式**：配置新增可选 `launchMode`。
   - `portal`（默认）：`server.url` 指主端，与原四个品牌壳一致；
   - `launcher`：不固定主端，先加载本机选择页，所选端写入 `endKey` 后跳转，重启保持；`?picker=1` 回到选择页。
2. **品牌资源**：`uendos init` / `uendos assets` 按 `accent` 与品牌字样生成 `assets/icon.png`（1024）与 `splash.png`（2732），首次 `pack` 通过 `@capacitor/assets` 展开到 Android/iOS 各尺寸，之后不覆盖自定义图标。
3. **打包**：`pack --target app` 自动补齐 `npm install` 与 `cap add android`；`--release` 生成 `android/uendos-signing.gradle`，密码只从 `UENDOS_KEYSTORE_PASSWORD` / `UENDOS_KEY_PASSWORD` 读取，不落盘。`pack --target ios` 需 macOS，`--release` 产出 `.xcarchive`。
4. **远程端白名单**：`capacitor.config.json` 的 `server.allowNavigation` 由 `ends` 的 host 自动生成，避免远程端被 WebView 拦截。

---

## 18. v0.3.2 变更（版本档位）

运行时不改，新增构建期档位 `profile`，同一套云根与壳代码按档裁剪产物与声明能力：

| 档位 | 默认 target | 允许 target | 声明能力 |
|---|---|---|---|
| `lite` 轻量版 | `app` | `app` | 9/18（无 push/camera/biometric/offlineQueue/deeplink/edge.storeRoot） |
| `standard` 标准版 | `app/pc` | `app/pc/mp` | 16/18（无 subscribeMsg/edge.storeRoot） |
| `pro` 增强版 | `app/pc/mp` | `app/pc/mp` | 18/18 |

1. `uendos.config.json` 新增可选 `profile`；`contractVersion` 升为 `0.3.2`。
2. `uendos init --profile` 决定默认 target 与默认 `launchMode`；`lite` 不允许 `pc/mp`。
3. `uendos profile [--json]` 输出三档矩阵；`uendos doctor` 校验档位与 target 是否匹配。
4. **边界**：`profile` 只裁剪构建期产物与声明能力，不是权限边界；租户/角色权限仍由云根校验。业务规则不得因档位分叉。
5. 设计说明与分发建议见 [`uendos-editions.md`](./uendos-editions.md)。

# UendOS SDK 迭代路线（v0.7 → v1.0）

> 当前：v0.7.0（2026-11-06 出包，37/37 测试、48 项一致性断言）；基线 v0.6.0（2026-11-05 发布，32/32、44 项）。
> 依据：[shell-contract.md](./shell-contract.md) §0 定位与 §0.4 IoT 接入与入口化。
> 原则：契约先行、只增不破、真机可验证、外部证书不阻塞主线。

## 1. 现状与判断

v0.6 已把「脚手架 → 插件 → 升级 → 发布清单 → 运行时队列」这条工程链打通，SDK 作为**交付工具**基本可用。

但新的定位「IoT 接入 + 用户操作入口」目前只有契约口径，没有可调用能力：

- 没有 `iot.*` 方法、事件与能力位，设备协议只能借用通用插件，语义不统一；
- 入口只有 `entry` 选择页与深链能力，没有统一的 `entryId`、参数、降级与来源追踪；
- 排障依赖 `Shell.events.recent` 与控制台，现场拿不到结构化诊断包；
- 安全仍停留在「构建期裁剪」：设备身份、安全存储、插件完整性未闭环；
- 签名与真机交付受 Apple / Android 证书阻塞，属于外部依赖，不应占据主线。

**结论**：v0.7 不再堆 CLI 子命令，先把定位变成可调用、可断言、可交付的运行时能力。

## 2. 迭代原则

1. **只增不破**：v0.7 / v0.8 保持 `BRIDGE_VERSION=3`，新能力全部走可选方法与能力位；桥版本升级留到 v0.9 统一评估。
2. **契约先行**：每个里程碑先改 `shell-contract.md` 与 `@uendos/contract`，再加 conformance 断言，最后改 `core.js`。
3. **能力可降级**：探测不到就返回 `E_UNSUPPORTED` 并如实上报，不允许「声明了但没实现」。
4. **裁决不越界**：新能力只做接入、缓冲、拉起、执行；业务判定仍归店根/云根。
5. **外部依赖可替换**：证书、OAuth、商店上架单独成线，做不了就显式标注「未签名 / 待接入」，不阻塞发版。

## 3. 路线总览

| 版本 | 主题 | 关键交付 | 主要依赖 |
|---|---|---|---|
| **v0.7** | IoT 接入与入口契约 | `iot.*` 方法与事件、IoT 插件模板、`entry.routes` 与 `entry.open`、`Shell.diagnostics()`、类型包 | 无外部凭据 |
| **v0.8** | 安全与真机交付 | 安全存储、设备身份、插件与产物完整性、签名流水线、更新回滚、真机矩阵 | Apple / Android / PC 证书 |
| **v0.9** | 规模化与生态 | 性能预算、多品牌/多租户配置包、构建期插件目录、桥 v4 设计与兼容 | 前两版稳定 |
| **v1.0** | 稳定承诺 | 契约冻结、语义化与弃用策略、迁移工具、GA 文档与支持矩阵 | v0.9 收口 |

维护线：v0.6.x 只接受缺陷修复与安全补丁，不引入新能力。

## 4. v0.7：IoT 接入与入口契约（已发版）

### M1 契约与类型（已实现）

- 新增能力位：内置 `iot` 总开关；`iot.ble` / `iot.serial` / `iot.mqtt` / `iot.nfc` 为预留适配器能力 ID，由构建期插件声明（不进入内置矩阵，避免插件重名被拒）。
- 新增方法：`iot.devices`、`iot.read`、`iot.write`。
- 新增事件：`shell:iot-device`、`shell:iot-data`、`shell:iot-ack`、`shell:iot-error`。
- 统一事件信封 v1：`{ v, deviceId, kind, metric, value, unit, at, seq, idem, quality, source }`。
- 新增 `entry.routes` 配置结构：`id`、`label`、`path`、`params`、`requires`、`fallback`（与现有 `entry` 选择页配置并存，不替换）。
- 提供 `@uendos/types`：`window.Shell`、IoT 信封、入口参数的类型声明（零运行时依赖）。

**验收**：`validateConfig` 覆盖新字段；类型包可被 TS 工程直接引用；旧配置不报错。

### M2 IoT 运行时与适配器模板（已实现）

- `core.js` 实现三个方法：能力位缺失时返回 `E_UNSUPPORTED`，在线/离线均可读，写操作带幂等键。
- `iot.write` 只返回「已受理 + ackId」，执行结果由 `shell:iot-ack` 回传；禁止把「已发送」当「已成功」。
- IoT 事件复用品牌作用域离线队列；断网恢复后按 `shell:queue-restored` 对账。
- `uendos plugin init --kind iot` 生成适配器骨架：`detect / read / write / ack`、fixture 与插件断言。
- 设备协议适配仍只允许构建期嵌入，禁止运行时远程加载。

**验收**：假设备 fixture 通过 `iot.devices → iot.read → iot.write → shell:iot-ack` 全链路；无适配器时能力位为 `─`；conformance 覆盖降级路径。

### M3 入口运行时（已实现）

- 运行时提供 `Shell.entries()` 与 `Shell.call('entry.open', { id, params, source, idem })`。
- `entry.open` 只做四件事：校验参数、检查能力/在线状态、拼装目标路由、派发 `shell:entry-open`；不决定业务内容。
- 入口来源统一为 `launcher | deeplink | scan | nfc | notification | device`。
- 缺参数、未知 `entryId`、能力不足均走 `fallback`，并如实上报原因。
- 深链解析复用现有 `shell:deeplink`，入口参数与深链参数使用同一套校验。

**验收**：`entry.open` 不触发任何业务写操作；未知入口返回 `E_BAD_ARGS`；能力不足返回 `E_UNSUPPORTED` 并命中 fallback；conformance 覆盖三种路径。

### M4 诊断与可观测（已实现）

- 新增 `Shell.diagnostics()`：版本、桥版本、环境、能力、插件、队列（数量/最旧时间）、最近事件、在线状态。
- 默认脱敏：不包含 token、手机号、地址、设备唯一码原文。
- CLI 增加 `uendos doctor --json`，输出机器可读诊断；与 `Shell.diagnostics()` 字段对齐。

**验收**：诊断包可落盘并复现问题；快照中不含凭证字段；conformance 断言字段形状与脱敏规则。

### M5 一致性、文档与发版（已实现）

- 版本/契约/内核/SDK 统一升至 `0.7.0`，`BRIDGE_VERSION` 保持 `3`；四品牌桥与 3 个 preload 重建，`build.mjs --check` 一致；SDK 内 core 同步。
- conformance 内置 48 项（入口路由 53 / IoT 适配器 50 / 两者同时 55）；`npm test` 37/37。
- 文档新增契约 §25–§29（IoT 契约/运行时、入口结构、诊断字段、发版），README 与 STATUS 同步。
- 分发包 `BTOS-UendOS-SDK-0.7.0.zip`（257,532 B）/ `.tar.gz`（217,538 B）已生成并解压实测；GitHub Release 待发布。
- `upgrade` 支持 v0.6 → v0.7（`contractVersion` 升 `0.7.0`，旧配置与旧事件监听不变）。

**验收**：全新解压 `npm ci && npm test` 37/37 全绿；`init → doctor --offline → conformance 48/48 → sync --check` 全过。

## 5. v0.8：安全与真机交付（下一版）

**目标**：把 v0.7 的 IoT 接入与入口能力变成「可安全交付」——凭证不落 Web、插件与产物可校验、更新可灰度可回滚、真机可验收。
**口径**：`BRIDGE_VERSION=3`；契约 / 内核 / SDK 统一 `0.8.0`；新能力全部可选，旧配置与旧事件监听不变。

### M1 安全存储与凭证边界（P0，无外部依赖）· 已实现

- 新增能力位 `secureStore`：原生 `✓` / 内存降级 `◐` / 未启用 `─`。
- 新增方法 `secure.get` / `secure.set` / `secure.remove`；仅接受字符串，键必须以 `<brand>:<purpose>` 开头，单值 ≤ 8 KB，不提供枚举。
- 后端通过构建期适配器注册：`ShellCore.registerSecureStore({ detect, get, set, remove })`；App 模板封装 Keychain / Keystore，Web 与小程序仅内存降级。
- **禁止**把设备令牌、刷新令牌写入 `localStorage` / `sessionStorage`；内存降级重启后要求重新授权，能力位如实上报 `◐`。
- 诊断只报后端类型（`keychain` / `keystore` / `memory`），不报键名与值。

**验收**：conformance 扫描 localStorage 确认无凭证；键命名与大小限制生效；Web 降级可用且明确标识。

### M2 设备身份与令牌生命周期（P1，云端契约先行）· 已实现（mock 通路）

- 对齐 [`cajob-iot-spec`](../cajob-iot-spec/README.md)：设备注册 / 刷新 / 吊销，令牌只存 `secureStore`，**不暴露给 H5**。
- 新增能力位 `identity`：未配置 `─`；`security.identity.mode=device` 时为 `◐`（依赖云端刷新与安全存储）；`caps.allow` 关闭 `secureStore` 时一并降级。
- 新增 `identity.current`：只返回 `{ identity: { deviceId, owner, scopes, expiresAt, source } | null, backend }`，不含 token。
- 新增 `identity.refresh`：按原子切换语义换新令牌并写回安全存储，派发 `shell:identity-changed`；401/403/410 清空存储并派发 `shell:identity-expired`；并发刷新复用同一请求。
- 刷新策略：到 TTL 80% 主动刷新；离线不发请求，联网或重启后补一次，不阻塞本地操作。
- 配置 `security.identity`（可选，默认 `none`）：`mode: device | none`、`endpoint`、`storeKey`（默认 `<prefix>:identity.device`）；默认不改变现有行为。
- 长期 `device_token` 仍按现网 180 天口径，v0.8 先做「安全存储 + 轮换 + 吊销」；短期会话令牌需云端改造，留到 v0.9。

**验收**：令牌不出现在 H5、诊断包与日志；刷新幂等；吊销后安全存储清空；云端用 mock 跑通路，不依赖真实服务。
**实现口径**：conformance 新增 3 项设备身份断言（能力位/元数据脱敏/刷新-吊销闭环），内置 52 → 55；未配置 `security.identity` 时断言覆盖「不可用且不报错」。

### M3 插件与产物完整性（P0，无证书依赖）· 已实现

- 插件包支持 Ed25519 签名：`uendos.plugin.json` + `uendos.plugin.sig`（v1，覆盖 `id + 版本 + manifest 哈希 + runtime 哈希`）；公钥放仓库内 `uendos.trusted.json`，私钥不入库。
- `plugin add` / `plugin update` / `sync` / `pack` 先验签再写锁；锁记录 `signer`、`manifest` 与运行时 `integrity`；被改动即拒绝。
- 默认要求签名；开发态用 `--allow-unsigned` 或配置 `security.plugins.requireSigned=false` 放行，`doctor` / `plugin list` 标注 `unsigned`。
- `pack` 的 `release/MANIFEST.json` 增加 `signature: signed | unsigned | dev`、`bridgeVersion`、`contractVersion`、`plugins[]`；`doctor --integrity` 与 `publish --verify` 校验签名态与哈希。
- 离线链路：`plugin keygen` → `plugin sign` → `plugin verify`，不依赖网络或证书颁发机构。
- 运行时不做远程完整性校验（成本与桥版本风险），完整性在构建期与发版前闭环。

**实现口径**：签名文件 `uendos.plugin.sig`（Ed25519 / v1），命令 `plugin keygen|sign|verify`；默认 `requireSigned=true`，锁内新增 `manifest` 与 `signer`；conformance 保持 55，CLI 测试 42/42（新增签名与篡改拦截用例）。

**验收**：篡改插件运行时后 `sync` / `doctor` / `pack` 全部拦截；未签名产物可出包但清单显式标注；验签离线可复现。

### M4 更新通道、灰度与回滚（P1）· 已实现

- `pack --channel stable|beta`、`publish --channel` 生成独立指针（`latest.yml` 为 stable，`latest-beta.yml` 为 beta），互不影响。
- 清单增加 `rollout`（0–100）与 `killSwitch`；`publish --rollback` 将通道指针退回上一版本或把当前版本灰度置 0，不做二进制降级。
- `doctor --release-check --channel` 校验指针版本、哈希与 `bridgeVersion` / `contractVersion` 兼容性；跨桥版本直接拒绝。
- PC 更新器按通道读取指针；App 与小程序的更新仍走商店 / 后台，不在壳内实现。

**实现口径**：契约新增 `UPDATE_CHANNELS = ['stable','beta']` 与 `UPDATE_CHANNEL_DEFAULT`；`release/channels.json` 记 `current` / `previous`，指针快照存 `release/.channels/<channel>/<version>.yml`；`release/MANIFEST.json` 顶层新增 `channel` / `rollout` / `killSwitch`；`publish --rollout` 只改注册表与商店条目、不覆盖指针，`publish --rollback` 有快照则换回指针、否则灰度置 0 并开 `killSwitch`；`doctor --release-check --channel` 按注册表校验指针版本、`files` 的 SHA-512/大小与桥/契约版本；conformance 保持 55，CLI 测试 43/43（新增通道隔离、灰度与回滚用例）。运行时壳不读取通道账本。

**验收**：beta 发布不影响 stable；回滚后新客户端不再收到该版本；旧客户端行为不变。

### M5 真机矩阵与发版（P1 / P2）

- 自检页升级：覆盖核心握手、`secureStore`、IoT 读写与 ack、入口打开、诊断快照，支持导出 `SELFTEST.json` 作为验收证据。
- 矩阵：Android 10/13/14、iOS 16/17、Windows 10/11、macOS 13/14、微信 web-view；场景含扫码、打印、称重、断网恢复。
- CI 覆盖 Android 模拟器自动化；iOS / macOS / Windows 签名与公证走独立线。
- 版本收口：契约 / SDK `0.8.0`，四品牌桥重建，conformance 55 → 约 62，测试 43 → 约 46，`upgrade` 支持 v0.7 → v0.8。

**验收**：全新解压全绿；真机矩阵按「已验 / 未验 / 阻塞」如实标注；未签名版本可发，但商店与更新通道显式提示。

### 外部阻塞项

Apple 开发者账号与 profile、Android release keystore、Windows 代码签名证书、iOS 公证环境、真机设备池。任一缺失时发「可校验但未签名」版本，并在清单与诊断中显式标注，不阻塞 P0 里程碑。

### 风险与待定

1. **安全存储后端**：社区插件 vs 自研原生插件；自研可控但维护成本高，建议先封装适配器、后端可替换。
2. **长期令牌 vs 短期凭证**：现网 `device_token` 为 180 天，v0.8 先安全存储与轮换；短期会话令牌需云端配合。
3. **签名密钥归属**：发布私钥由谁持有、轮换与吊销流程；仓库只放公钥。
4. **回滚语义**：PC 更新器通常不支持二进制降级，v0.8 用「通道指针 + 灰度置 0」实现软回滚。

## 6. v0.9：规模化与生态

- **性能预算**：桥体积、冷启动、事件吞吐、队列重放上限；超出即阻断发版。
- **多品牌/多租户**：配置预设与差异包，减少四品牌重复维护。
- **构建期插件目录**：可检索、可锁定版本、可校验哈希；仍禁止运行时远程加载。
- **桥 v4 设计**：只增不破的迁移方案、双版本并行与下线节奏。
- **可访问性与国际化**：入口页与设备面板的最小基线。

## 7. v1.0：稳定承诺

- 契约冻结与语义化规则：能力位、方法、事件的增删改分别对应哪个版本号。
- 弃用策略：兼容别名、桥版本、旧配置的保留窗口。
- 迁移工具：`uendos upgrade` 覆盖 0.x 全链路，失败可回滚。
- GA 文档：支持矩阵、故障排查手册、版本兼容表。

## 8. 优先级与外部依赖

| 优先级 | 事项 | 说明 |
|---|---|---|
| P0 | v0.8 M1 安全存储 / M3 完整性（已实现） | 凭证不落 Web、插件与产物可校验，无证书依赖 |
| P1 | v0.8 M2 设备身份（已实现，mock 通路） / M4 更新通道（已实现） | 需云端接口与宿主更新器配合，可先用 mock |
| P1 | v0.8 M5 真机验收与发版 | 模拟器可自动化；真机与签名受外部条件影响 |
| P2 | 签名、公证、商店上架 | 依赖 Apple / Android / Windows 账号与证书 |
| P2 | v0.9 性能预算 / 多品牌 | 规模化的前置条件 |
| P2 | 插件目录与生态 | 必须在 v0.8 完整性之后 |

## 9. 明确不做

- 不做运行时远程插件加载或插件市场热更新（违反构建期嵌入红线）。
- 不做边缘本地业务裁决（优惠、库存、金额、订单状态）。
- 不在壳内实现用户登录 / OAuth / 权限矩阵；设备身份只解决「这台设备是谁」，用户身份仍归云根。
- 不做运行时远程完整性校验与热更新修复；完整性在构建期、发版前与宿主层闭环。
- 不做二进制降级回滚；v0.8 的回滚只操作通道指针与灰度开关。
- 不把 `caps.allow` 当安全边界；权限与身份仍在云根/店根。
- 不在 v0.7 / v0.8 提升 `BRIDGE_VERSION`，避免四品牌桥与存量 H5 同步风险。
- 不承诺「支持所有 IoT 协议」；按设备族做适配器，能力位如实上报。

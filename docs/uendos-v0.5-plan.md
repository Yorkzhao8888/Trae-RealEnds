# UendOS v0.5 规划：能力白名单与插件体验

承接 [v0.4 个性化壳方案](./uendos-customization-v0.4.md)。v0.4 已交付 `theme` / `entry` / `plugins`，v0.5 收口 L2 最后一块 `caps.allow`，补齐插件日常使用体验，最后发 `0.5.0`。

## 1. 目标与范围

**做**

1. `caps.allow`：在 `profile` 与插件能力之上做构建期收窄，运行时如实反映。
2. `uendos plugin list`：一屏看清已装插件、版本、声明环境、是否有断言。
3. 插件断言缺省提示：不再静默跳过，`doctor` 与 `conformance` 各提示一次。
4. `uendos plugin` 帮助文案与 `0.5.0` 发版（版本号、契约、文档、分发包）。

**不做**

- 运行时远程加载插件、插件热替换（v0.4 已明确禁令，继续有效）。
- `caps.deny`、按租户/角色的能力授权——后者属云根裁决，壳不承担。
- 桥协议变更：`BRIDGE_VERSION` 保持 **3**，`handshake` 不新增字段。

## 2. M1：`caps.allow`

### 2.1 配置语义

```json
{
  "contractVersion": "0.5.0",
  "profile": "standard",
  "caps": { "allow": ["share", "push", "camera", "printer"] }
}
```

| 情况 | 语义 |
|---|---|
| 未配置 `caps` | 不裁剪，行为与 0.4 完全一致（旧工程零改动） |
| `allow` 为空数组 | **全部内置能力收窄为 `─`**（明确关闭所有可裁剪能力） |
| `allow` 有值 | 只保留列出的能力，其余内置能力置 `─` |

规则：

- `allow` 只能**收窄**，不能放宽：每项必须属于 `PROFILES[profile].capabilities` 或某个已声明插件的能力，否则 `sync`/`doctor` 直接失败并提示所属档位。
- 插件能力同样受裁剪：插件已装但能力不在 `allow`，视为未授权，其方法返回 `E_UNSUPPORTED`（`message` 标“能力未启用”）。
- 桌面能力（`paths` / `revealFile`）与 `core.*` 基础方法不受 `caps` 影响。
- **不是权限边界**：只是构建期裁剪与产品降噪；租户/角色鉴权仍由云根裁决，文档与 `doctor` 输出都要写明这一点。

### 2.2 运行时落地

- `sync` 把 `caps` 写进品牌桥的 `runtimeCfg`（与 `theme`/`entry` 同处，受 `sync --check` 保护）。
- `create()` 在合并 `buildCapabilities + desktopCapabilities + pluginCapabilities` 之后执行 masking：**键保留、值置 `─`**，因此能力矩阵形状不变，`Shell.capabilities` 与握手载荷自动正确。
- `call()` 增加前置判定：按方法 → 能力映射表命中被裁剪能力时，返回 `E_UNSUPPORTED`（不抛异常）；插件方法按命名空间对应能力判定。
- 映射表固定写在 `shell-core/src/core.js`：

| 能力 | 方法 |
|---|---|
| `vibrate` | `core.vibrate` |
| `share` | `core.share` |
| `geolocation` | `core.location` |
| `push` | `core.push.request` / `core.push.token` |
| `statusBar` | `core.statusBar` |
| `splash` | `core.splash` |
| `network` | `core.net` |
| `offlineQueue` | `offline.enqueue` / `offline.flush` / `offline.list` |
| `edge.storeRoot` | `edge.configure` / `edge.health` / `edge.lease` / `edge.commit` / `edge.snapshot` |

`haptics`、`backButton`、`deeplink`、`safeArea`、`files`、`camera`、`biometric`、`subscribeMsg` 只有能力位、无对应方法，裁剪后仅影响能力值。

### 2.3 契约与校验

- schema 新增 `caps`：`additionalProperties: false`；`allow` 为字符串数组、`uniqueItems`，项按 `^[a-z][a-z0-9-]*$` 约束（插件能力名未知，不能枚举）。
- `validateConfig(cfg, opts)`：`opts.capabilities` 缺省为 `CAPABILITIES`；CLI 先解析插件、再传 `PROFILES[profile].capabilities ∪ 插件能力`，使 `allow` 可引用插件能力而不误报。
- `doctor` 新增一行：`能力白名单：allow 4 项（内置 18 → 14，插件 printer 保留）`；未配置时打印 `· 未配置能力白名单（全量）`。

### 2.4 conformance 兼容

现有 39 项断言中，`offline.*`（6 项）与 `edge.*`（5 项）依赖会被裁剪的能力。方案：

- `runConformance(shellFile, { caps })` 接收生效 `allow`。
- 断言表增加 `requires: 'offlineQueue'` 等标注；能力被裁剪的断言记为 **skip**，不判失败。
- 输出改为 `通过：28 通过 / 11 跳过 / 0 失败（裁剪：offlineQueue、edge.storeRoot）`；未配置 `caps` 时仍是 `39 通过 / 0 失败`，CI 解析不变。
- 新增固定断言：被裁剪能力的值必须是 `─`，且对应方法返回 `E_UNSUPPORTED`（这 2 项计入总数）。

## 3. M2：插件体验

1. `uendos plugin list [--json]`
   - 表格列：`id` / 已安装版本 / 声明版本 / 环境 / 断言 / 状态（已配置但未安装标 `✗`）。
   - `--json` 输出机器可读数组，供 CI 报表使用。
2. 断言缺省提示
   - `conformance`：`· <id> 未提供断言，跳过（建议在 uendos.plugin.json 声明 asserts）`。
   - `doctor`：`! 插件 <id> 无断言文件（不阻塞构建）`，不计入失败。
3. 帮助文案
   - `uendos plugin` 单独执行时打印子命令用法块（add / remove / update / list），与 `--help` 一致。
4. 测试：`plugin list` 表格与 `--json` 两种输出；缺断言时的两条提示文案；`plugin` 无子命令时输出用法。

## 4. M3：`0.5.0` 发版

- 版本：`sdk/package.json`、`cli`/`contract`/`shell`/`conformance` 与 lock 全部 0.5.0；`CONTRACT_VERSION`、`CORE_VERSION` → 0.5.0；`BRIDGE_VERSION` 保持 3。
- schema `contractVersion` pattern 接受 `0.5.x`。
- 文档：`docs/shell-contract.md` 新增 §22（caps.allow 语义、运行时 masking、conformance skip）；`sdk/README.md` 增加 `caps` 与 `plugin list`；定制方案标记 `caps.allow` 已实现。
- 出包：`BTOS-UendOS-SDK-0.5.0.zip` / `.tar.gz`，解压实测 + Release。

## 5. 里程碑

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| M1 `caps.allow`（已实现） | 契约、schema、运行时 masking、`call()` 门禁、doctor、conformance skip | 裁剪后 `Shell.capabilities.share='─'`、`core.share` 返回 `E_UNSUPPORTED`；未配置时 39/39 不变 |
| M2 插件体验（已实现） | `plugin list`、断言提示、帮助文案 | 两种输出格式正确；缺断言提示各出现一次且不判失败 |
| M3 `0.5.0`（已实现） | 版本、文档、出包、Release | 全新解压 `npm ci && npm test` 全绿；带 `caps` 示例工程 `doctor`/`conformance`/`sync --check` 全过 |

## 6. 风险与对策

- **`allow` 被误当权限**：文档、`doctor`、契约 §22 三处都写明“构建期裁剪≠授权”。
- **空数组歧义**：定义为“全部关闭”，schema 允许空数组并在文档加粗说明；`doctor` 对空数组打印警告。
- **conformance 数量变化影响 CI**：保持 `39 + N` 的通过+跳过总数稳定，输出新增 `skip` 字段，旧脚本按 `通过/失败` 解析仍可用。
- **插件能力名与 allow 拼写不一致**：校验失败时同时列出可用能力名，减少试错。
- **旧工程升级**：无 `caps` 时零差异；有 `caps` 时首次 `sync` 后 `--check` 才会一致，`pack` 前已有强制校验兜底。

## 7. 版本记录

- **v0.5（已实现，2026-10-31）**：`caps.allow` 构建期裁剪（值置 `─` + `E_UNSUPPORTED` 门禁）、`plugin list`、断言缺省提示、子命令帮助；桥版本 3 不变，契约/内核 `0.5.0`；测试 28/28，caps 示例 27 通过/14 跳过/0 失败；分发包 `BTOS-UendOS-SDK-0.5.0.zip`（191,854 B）/ `.tar.gz`（153,985 B）已出包并解压实测。

# UendOS · 真实端壳开发者 SDK

把「H5 业务根 + 各端薄壳」沉淀成一套可复用的封装工具：开发者只写业务 H5，壳能力（App / PC / 小程序 / 浏览器）、原生桥、离线兜底、发布清单全部由 SDK 生成。

**定位**：壳是物理世界与数字世界之间的边缘运行时——硬体接口层 + 软体运行时层 + 系统整合面，连接/数据贯穿；对接是双向的（感知 + 执行）。SDK 只决定「怎么送、送多少、何时送」，不判定优惠、不改订单、不算金额。完整口径见[契约 §0](../docs/shell-contract.md#0-定位角色与红线)。

## 目录

```
sdk/
├── package.json                 # 私有 workspace（Node ≥ 18，零第三方依赖）
├── packages/
│   ├── contract/                # @uendos/contract：能力/方法/事件/错误码 + 配置校验 + JSON Schema
│   ├── shell/                   # @uendos/shell：运行时合成（把 shell-core 的 core.js + 品牌配置出桥）
│   ├── types/                   # @uendos/types：Shell / IoT / 入口 TypeScript 类型声明（无运行时）
│   ├── conformance/             # @uendos/conformance：55 项契约断言（vm 沙箱，不依赖真机）
│   ├── plugin-fixture/          # @uendos/plugin-fixture：插件机制 fixture（假打印机，仅测试用）
│   └── cli/                     # uendos CLI + App/PC/小程序三套模板
└── README.md
```

运行时唯一真源仍是 [`shell-core/src/core.js`](../shell-core/src/core.js)；`@uendos/shell` 用 `scripts/sync-core.mjs` 复制、用 `scripts/check-core.mjs` 校验，禁止在 SDK 内私改运行时。

## 分发包

0.7.0 分发包已生成（GitHub Release `uendos-sdk-v0.7.0` 发布后链接可用）：

- [BTOS-UendOS-SDK-0.7.0.zip](https://github.com/Yorkzhao8888/Trae-RealEnds/releases/download/uendos-sdk-v0.7.0/BTOS-UendOS-SDK-0.7.0.zip)（257,532 B，SHA-256 `4625f5d41364f46ebf2176c42fd4bcb7edef4900e19ede9501a10043ddd15ff1`）
- [BTOS-UendOS-SDK-0.7.0.tar.gz](https://github.com/Yorkzhao8888/Trae-RealEnds/releases/download/uendos-sdk-v0.7.0/BTOS-UendOS-SDK-0.7.0.tar.gz)（217,538 B，SHA-256 `30ac2e206d3f305cb4c40f731fa41fa78e652968c54d32e86cc481143e15d800`）

> 0.7.0 包已实测：解压后 `cd sdk && npm ci && npm test` 为 37/37，`init → doctor --offline → conformance 48/48 → sync --check` 全过。

解压后 `cd sdk && npm install`，包含 `docs/shell-contract.md`、`docs/uendos-roadmap.md` 与 `shell-core/src/core.js`，因此 `check-core` 在包内也能通过；不含 `node_modules` 与任何凭证。

> 仓库当前代码版本为 **0.7.0**（v0.7 M1-M5 已实现并收口，见 [迭代路线](../docs/uendos-roadmap.md)）。

首次接入请先读：[开发者接入指南（v0.3.1）](../docs/uendos-dev-onboarding-v0.3.1.md)，其中第 6 节是 launcher 与原生插件的真机验证步骤。

## 快速开始

```bash
cd sdk && npm install

# SDK 未发布到 npm：用 alias 让 uendos 在任意目录可用
alias uendos="node $(pwd)/packages/cli/bin/uendos.mjs"

uendos init acme \
  --brand acme \
  --ends "hp:个人端:https://hp.acme.example.com/,ep:企业端:https://ep.acme.example.com/" \
  --targets app,pc,mp \
  --app-id com.acme.app \
  --accent "#4C8DFF" \
  --dir ./acme

cd acme
uendos doctor                    # 配置 / 产物 / 端可达性 / 模板体检
uendos conformance               # 55 项契约断言（配置了插件时为 55 + N）
uendos sync --check              # CI 用：产物必须与配置一致
```

产物：

| 文件 | 说明 |
|---|---|
| `uendos.config.json` | 工程唯一配置，所有命令的输入 |
| `shell/<prefix>-shell.js` | 自包含品牌桥（banner + core.js + `ShellCore.create(config)`），可直接 `<script>` 引入 |
| `uendos.runtime.json` | 勾选 `pc` 时生成，Electron `main.js` 启动读取 |
| `dist/<prefix>-shell.js` | 勾选 `app` 且存在 `dist/` 时同步写入，供 Capacitor `webDir` 使用 |

## 命令

| 命令 | 作用 | 关键参数 |
|---|---|---|
| `uendos init <项目名>` | 建工程：拷模板 → 替换占位符 → 写配置 → 生成品牌桥、选择页与 `assets/` 源图 | `--brand` `--ends` `--profile` `--targets` `--app-id` `--display` `--accent` `--mp-appid` `--launch-mode` `--dir` |
| `uendos add-end <id>` | 增加一个端并重新生成桥 | `--name` `--url` |
| `uendos upgrade` | 老工程迁移：补齐/升级 `schemaVersion` / `contractVersion`，备份 `.bak`，重生成产物与插件锁 | `--check` 只报告差异、退出码 1，不写文件 |
| `uendos diff` | 比对「配置期望 vs 现有产物」与「插件锁 vs 实装」，输出 `-`/`+` 行 | `--json` 输出机器可读结果；不一致退出码 1 |
| `uendos sync` | 重新合成品牌桥与选择页 | `--check` 只校验不写，不一致时退出码 1 |
| `uendos doctor` | 体检：配置合法 / 桥与配置一致 / 各 target 模板文件 / 插件验签 / 端 URL 可达（HEAD，405 回退 GET） | `--offline` 跳过联网；`--allow-http` 允许 http 端地址；`--allow-unsigned` 开发期放行未签名插件；`--release-check` 校验 `release/MANIFEST.json` 与 PC `latest.yml`；`--integrity` 额外校验清单签名态、桥/契约版本与插件签名一致性；`--channel stable\|beta` 改按通道注册表校验指针版本、产物 SHA-512/大小与桥/契约版本；`--json` 输出脱敏诊断包 |
| `uendos conformance` | 对品牌桥跑 55 项契约断言；配置了插件时合并插件断言，输出 `55 + N`；能力被裁剪时对应断言记为跳过 | `--json` 输出机器可读结果；`--file` 直接指定桥文件 |
| `uendos profile` | 查看 `lite/standard/pro` 三档默认 target 与能力集 | `--json` 输出机器可读结果 |
| `uendos plugin list` | 列出配置中的插件：安装状态、版本、环境、能力、断言、依赖、签名态与锁状态 | `--json` 输出机器可读结果 |
| `uendos plugin init <包名>` | 生成插件包脚手架（`uendos.plugin.json` / `runtime.js` / `conformance.mjs`），不自动改配置；`--kind iot` 生成 IoT 适配器骨架 | `--kind` `--transport` `--capability` `--env` `--dir` `--version` `--force` |
| `uendos plugin add <包名>` | 把**已安装**的插件写入 `plugins` 并重新生成品牌桥（先预检声明与签名） | `--allow-unsigned` 开发期放行未签名；`remove` 反向操作，被依赖时拒绝 |
| `uendos plugin update [<包名>...]` | 构建期升级插件：`npm install <包名>@latest` → 重新校验 → `sync`；变更随壳包发布 | `--spec` 指定版本/tarball/内网源；`--allow-unsigned`；不给包名则升级全部 |
| `uendos plugin keygen` | 生成 Ed25519 密钥对，公钥写入 `uendos.trusted.json`，私钥写 `.uendos-keys/`（600，不入库） | `--id` `--out` `--force` |
| `uendos plugin sign <包名>` | 为已安装插件写 `uendos.plugin.sig`（覆盖 id + 版本 + manifest/runtime 双哈希） | `--key <私钥 PEM>` `--id <keyId>` |
| `uendos plugin verify [<包名>]` | 离线验签：签名有效 / 未签名 / 内容被改动；签名无效时退出码非 0 | 不给包名则校验配置中的全部插件 |
| `uendos assets` | 按主色与品牌字样生成 `assets/icon.png`（1024）与 `splash.png`（2732） | `--force` 覆盖已有图 |
| `uendos pack` | 本地打包（缺 `node_modules` / `android` / `ios` 时自动安装与生成平台工程）；成功后写 `release/MANIFEST.json`（版本/产物/大小/SHA-256/`signature`/`bridgeVersion`/`contractVersion`/`plugins[]`/`channel`/`rollout`/`killSwitch`），PC 同时写通道指针与 `release/channels.json` | `--target app`（Debug APK；`--release` 走签名）、`ios`（需 macOS）、`pc`（`npm run dist`）、`mp`（提示用微信开发者工具上传）；`--channel stable\|beta`（默认 `stable`，beta 写 `-beta` 后缀指针） |
| `uendos publish` | 计算 SHA-256/大小并回写商店清单；`--verify` 要求产物、签名态、桥/契约版本与 `release/MANIFEST.json` 一致 | `--file` `--item` `--manifest` `--url` 或 `--download-dir` `--version` `--status`（默认 `beta`）；`--channel` `--rollout 0-100` `--kill-switch`（只调灰度时可省略 `--file`）；`--rollback` 退回上一版本指针 |

`doctor` / `conformance` / `sync --check` 失败均以非 0 退出，可直接挂 CI。

## 配置（`uendos.config.json`）

```json
{
  "schemaVersion": 1,
  "brand": "acme",
  "displayName": "Acme",
  "alias": "acmeOS",
  "prefix": "acme",
  "accent": "#4C8DFF",
  "statusBarStyle": "dark",
  "endKey": "acme.end",
  "contractVersion": "0.7.0",
  "profile": "standard",
  "targets": ["app", "pc"],
  "packageId": "com.acme.app",
  "launchMode": "portal",
  "theme": {
    "mode": "light",
    "tokens": {
      "accent": "#4C8DFF",
      "bg": "#FFFFFF",
      "surface": "#F6F9FD",
      "ink": "#0B1220",
      "inkMuted": "#7B8AA0",
      "line": "#E4E9F2",
      "radius": 16,
      "fontScale": 1
    }
  },
  "entry": {
    "title": "选择你的身份",
    "subtitle": "选择后进入对应工作台，可随时返回本页切换。",
    "rememberLast": true,
    "order": ["hp", "cp", "ep"],
    "groups": [
      { "label": "一线员工", "ends": ["hp"] },
      { "label": "管理与协作", "ends": ["cp", "ep"] }
    ]
  },
  "ends": {
    "hp": { "name": "个人端", "url": "https://hp.acme.example.com/" },
    "ep": { "name": "企业端", "url": "https://ep.acme.example.com/" }
  },
  "caps": { "allow": ["vibrate", "share", "network"] },
  "plugins": ["@acme/uendos-plugin-printer"]
}
```

约束（`validateConfig` 与 `schema/uendos.config.schema.json` 同步）：

- `brand` 小写，`^[a-z][a-z0-9-]{1,15}$`；`accent` 为 `#RRGGBB`
- `ends` 至少 1 个，`id` 2–4 位小写字母；`url` 必须是 https（`--allow-http` 仅供内网联调）
- `targets` 取值 `app` / `pc` / `mp`；`contractVersion` 主版本必须与 SDK 当前契约一致
- `launchMode` 为 `portal`（默认，启动直进主端）或 `launcher`（本机选择页，记住上次所选端）
- `profile` 为 `lite` / `standard` / `pro`，决定默认 target 与声明的端能力集；不是权限边界
- `theme` 可选：`mode`（`light`/`dark`）+ `tokens`（颜色 `#RRGGBB`、`radius` 0–28、`fontScale` 0.9–1.2）；只作用于壳自有页面
- `entry` 可选：选择页标题/副标题、`order` 顺序、`groups` 分组、`rememberLast` 是否记住上次端；只影响 launcher / 选择页
- `plugins` 可选：已 `npm install` 的插件包名数组，去重；`profile=lite` 不允许插件
- `security.plugins.requireSigned` 可选：默认 `true`，未签名插件会被 `sync` / `pack` 拒绝；设为 `false` 仅用于开发期
- `caps.allow` 可选：能力白名单，只能收窄（⊆ 档位能力 ∪ 插件能力）；不配置为全量，空数组为全关

### 三档 profile

| 档位 | 默认 target | 允许 target | 端能力 |
|---|---|---|---|
| `lite` 轻量版 | `app` | `app` | 9/18（无推送/相机/店根/离线队列） |
| `standard` 标准版 | `app/pc` | `app/pc/mp` | 16/18（无订阅消息/店根） |
| `pro` 增强版 | `app/pc/mp` | `app/pc/mp` | 18/18 |

`uendos init <项目名> --profile lite` 会自动只出 App；显式给不允许的 target 会被拒绝。完整边界与分发建议见 [版本档位与能力矩阵](../docs/uendos-editions.md)。

### 个性化主题（v0.4 M1）

- 改 `theme` 后执行 `uendos sync`，`sync --check` 校验主题是否已写入品牌桥与选择页；`doctor` 会打印生效的 `mode` / `accent` / `radius` / `fontScale`。
- 选择页（`shell/picker.html`）只引用 `--uendos-*` CSS 变量，不写死色值；变量由运行时按 `theme` 注入，同时设置 `color-scheme` 与 `theme-color`。
- 远程 H5 不强制换肤，业务页可读 `Shell.theme` 自行适配；边界见 [个性化壳方案](../docs/uendos-customization-v0.4.md)。

### 入口编排（v0.4 M2）

- 选择页由 `uendos sync` 生成到 `shell/picker.html`（`index.html` 只做 `./picker.html` 跳转，`prepare:web` 负责复制进 `dist`），纳入 `sync --check`，不再靠手改。
- `entry.order` 决定展示顺序，未列出的端按配置顺序追加；`entry.groups` 只做分组展示，未分组的端排在分组之后。
- `entry.rememberLast: false` 时既不自动跳转也不写 `endKey`，适合共用设备的门店场景。
- 改完执行 `uendos sync` 即可，`doctor` 会打印 `端数 / 组数 / 顺序 / 是否记住`。配置契约见 [个性化壳方案 §2.2](../docs/uendos-customization-v0.4.md)。

### 能力白名单（v0.5 M1）

- `caps.allow` 只能收窄：越界能力会被 `sync` / `doctor` 直接拒绝，空数组表示关闭全部可裁剪能力。
- 裁剪发生在构建期：能力矩阵键保留、值置 `─`，对应方法返回 `E_UNSUPPORTED`（`message` 注明原因）；未配置时与 v0.4 行为一致。
- `uendos conformance` 会把被裁剪能力的断言记为「跳过」，输出 `通过 / 跳过 / 失败`；`doctor` 打印 `能力白名单：allow N 项 · 生效 X/Y`。
- 边界：这是构建期裁剪，不是权限边界；租户/角色授权仍由云根校验。

### 插件（v0.4 M3）

插件是普通 npm 包，根目录放 `uendos.plugin.json` 与 `runtime.js`（浏览器侧代码，无 Node 依赖）：

```json
{
  "id": "@acme/uendos-plugin-printer",
  "version": "1.0.0",
  "runtime": "runtime.js",
  "asserts": "conformance.mjs",
  "env": ["capacitor", "electron"],
  "capabilities": ["printer"],
  "methods": ["printer.print", "printer.status"]
}
```

```js
// runtime.js —— CLI 会包进函数作用域后嵌入品牌桥，不直接执行
return {
  detect: function (env) { return env === 'capacitor' || env === 'electron'; },
  capabilities: { printer: '✓' },
  methods: {
    'printer.print': function (a) { /* 调原生插件 */ },
    'printer.status': function () { /* ... */ },
  },
};
```

- 接入：`npm install @acme/uendos-plugin-printer` → `uendos plugin add @acme/uendos-plugin-printer`（写配置 + 重新 `sync`）；移除用 `plugin remove`。
- 写新插件：`uendos plugin init @acme/uendos-plugin-printer` 生成最小可安装包（默认按短名推导能力名，可用 `--capability` 覆盖），再按上面的接入步骤安装。IoT 适配器用 `--kind iot --transport ble|serial|mqtt|nfc|gateway`。
- **插件锁**：`sync` / `plugin add|remove|update` 会生成 `uendos.plugins.lock`（版本 + 运行时哈希 + manifest 哈希 + `signer`）；`sync --check` 与 `doctor` 据此拦截「锁了版本但代码/声明被换」或签名者变更的漂移。首次在旧工程启用插件时先跑一次 `uendos sync`。
- **插件依赖**：manifest 可选 `requires: ["@acme/uendos-plugin-core"]`；`sync` 按依赖拓扑排序注册（配置顺序不决定激活顺序），缺依赖或成环直接失败，被依赖的插件不允许直接 `remove`。
- **升级走构建期热更新**：`uendos plugin update`（默认 `@latest`，`--spec` 可指定版本/内网源）→ 重新校验声明 → `sync`；插件变更随壳包发布，业务侧不会在运行时拉取插件代码。
- **只允许构建期嵌入**，禁止运行时远程加载；包版本由 `package-lock.json` 锁定，必须提交。
- 注册即校验：id 唯一、能力不得与内置 21 项重名、多插件不得共享能力、方法命名空间必须是插件自己的能力且不占用 `core/edge/offline/desktop/shell`、方法不得与内置或其他插件重名，任一不满足 `sync` 直接报错。
- 激活与回落：只有 `detect(env)` 为真才算 `active`，否则能力记 `─`、方法返回 `E_UNSUPPORTED`；插件抛错映射 `E_NATIVE`。
- `Shell.plugins` 与握手 payload 携带 `[{ id, version, active }]`，线上可按版本排障。
- `uendos conformance` 合并插件自带的 `conformance.mjs`（导出 `[{ name, run(Shell) }]`），输出 `55 + N`；`doctor` 打印插件清单与合并后的能力集。
- `uendos pack` 打包前强制 `sync --check`，桥里的插件运行时必须与配置一致。

完整契约见 [shell-contract §21](../docs/shell-contract.md)，设计背景见 [个性化壳方案 §3](../docs/uendos-customization-v0.4.md)。

### 离线队列与事件回看（v0.6 M4）

离线队列落在 `localStorage`，键按品牌作用域隔离，避免同源多品牌串队：

```js
// 键名：shell:offline-queue:<prefix>，值为版本化信封
{ "v": 1, "items": [{ idem, method, url, body, headers, at, tries }] }
```

- 容量上限 200 条（超出淘汰最旧）；旧版裸数组键 `shell:offline-queue` 会在首次读取时一次性迁移。
- 重启恢复：队列非空时 `shell:ready` 之后派发 `shell:queue-restored`，载荷 `{ count, oldestAt }`；**不自动重放**，由 `offline.flush` 或联网事件触发，幂等键 `X-Idem-Key` 保证不重复。
- 事件回看：`Shell.events.recent([event], [limit=20])` 返回内存中最近 50 条事件（时间正序，可按事件名过滤）。只读、进程内有效，不落盘，用于调试与断线对账，不替代 `on()` 订阅。

```js
const pending = await Shell.call('offline.list');
const missed = Shell.events.recent('shell:queue-replayed', 10);
```

完整契约见 [shell-contract §24](../docs/shell-contract.md)。

### IoT 接入（v0.7 M2）

```bash
uendos plugin init @acme/uendos-plugin-ble --kind iot --transport ble
# 生成 manifest（capabilities: ["iot.ble"]、methods: ["iot.ble.probe"]）与适配器骨架
```

适配器只在构建期由插件 runtime 调用 `ShellCore.registerIotAdapter` 注册，禁止运行时远程加载：

```js
ShellCore.registerIotAdapter({
  id: '@acme/uendos-plugin-ble',
  transport: 'ble',                 // ble | serial | mqtt | nfc | gateway
  detect: () => true,               // 原生能力探测；false 时不激活、能力记 ─
  devices: () => [{ id, kind, status, capabilities }],
  read: (deviceId, metric) => ({ value, unit, quality }),
  write: (deviceId, action, params, ack) => {
    ack({ ok: true });              // 执行结果异步回传；也可同步返回 { ok: true }
    return { accepted: true };
  },
  subscribe: (publish) => { /* 上行事件 → publish({ deviceId, metric, value, ... }) */ },
  ingestUrl: 'https://cloud.example.com/iot/ingest', // 可选：离线时自动进队列补传
});
```

- `iot.devices` 聚合所有激活适配器；`iot.read` 返回读数；`iot.write` **必须带 `idem`**，只返回 `{ accepted, ackId }`，执行结果通过 `shell:iot-ack` 回传——不得把“已受理”当“已成功”。
- 上行统一信封 v1（`v/deviceId/kind/metric/value/unit/at/seq/idem/quality/source`），事件名 `shell:iot-data`；离线且配置了 `ingestUrl` 时自动写入品牌作用域队列。
- 能力矩阵：适配器子能力（`iot.ble` 等）由插件声明；任一子能力激活时 `iot` 总开关自动置 `✓`。`caps.allow: ["iot"]` 可整体关掉，子能力一并置 `─`。
- 设备令牌与鉴权归云根；壳只在必要时把短期凭证放进 `secureStore`，不落 Web 存储，也不替云端做校验。

完整契约见 [shell-contract §26](../docs/shell-contract.md)。

#### 网关代理（G3，只读）

串口/BLE/MQTT 由店外的 `iot-gateway` 采集并归一落库时，壳不直连设备，改用构建期适配器
`@uendos/plugin-iot-gateway`（源码在 `iot-gateway/adapter`）：

```bash
npm i ../iot-gateway/adapter
# uendos.config.json 的 plugins 加入 "@uendos/plugin-iot-gateway"
```

宿主启动时注入地址与令牌（插件不内置凭证）：

```js
window.__IOT_GATEWAY__ = { url: 'http://127.0.0.1:7321', token: '<EDGE_TOKEN>' };
```

- 设备 `transport` 统一为 `gateway`，列表来自 `/iot/devices`，`capabilities` 为最新值指标名。
- `iot.read` 读店根最新值；事件经 `/iot/stream` 长轮询回灌 `shell:iot-data`，游标从当前最新 `seq` 起步。
- 适配器**不声明 `write`**，`iot.write` 返回 `E_UNSUPPORTED`；开锁/打印等控制闭环不在本期。
- conformance 的 `iot.write` 断言接受只读适配器的 `E_UNSUPPORTED`，断言总数不变。

完整契约见 [shell-contract §34](../docs/shell-contract.md#34-iot-g3-网关代理适配器只读)。

### 安全存储（v0.8 M1）

```js
const key = `${Shell.brand}:device-token`;   // 必须带 <prefix>: 前缀
await Shell.call('secure.set', { key, value: token });
const r = await Shell.call('secure.get', { key });   // r.data.value
await Shell.call('secure.remove', { key });
```

- 原生后端在 `create` 初始化完成前注册（原生壳嵌入启动脚本，或由插件 factory 注册）；未注册或 `detect` 为假时回落内存，能力位与返回值都标记 `backend: 'memory'`。
- 键前缀必须是 `<brand>:`（自定义 `prefix` 时按 `prefix`）；purpose 字母开头、≤ 64 位；单值 ≤ 8 KB。
- **禁止**把令牌写入 `localStorage` / `sessionStorage`；内存降级重启后失效，需重新授权。
- `Shell.diagnostics()` 只报 `security.secureStore` 后端类型，不含键名与值。

```js
ShellCore.registerSecureStore({
  backend: 'keychain',                  // keychain | keystore | native
  detect: (env) => env !== 'web',
  get: (key) => nativeGet(key),
  set: (key, value) => nativeSet(key, value),
  remove: (key) => nativeRemove(key),
});
```

完整契约见 [shell-contract §30](../docs/shell-contract.md)。

### 设备身份（v0.8 M2）

```json
{
  "security": {
    "identity": {
      "mode": "device",
      "endpoint": "https://api.example.com/api/backend/device/refresh",
      "storeKey": "acme:identity.device"
    }
  }
}
```

```js
const cur = await Shell.call('identity.current');
// cur.data.identity => { deviceId, owner, scopes, expiresAt, source } | null
const r = await Shell.call('identity.refresh');   // 原子换新令牌，令牌不出现在返回/事件/诊断
```

- 默认 `mode: "none"`，行为不变；配置 `device` 后能力位为 `◐`（未配置 `─`）。
- 设备令牌只存安全存储（`storeKey` 缺省 `<prefix>:identity.device`），**不暴露给 H5**；`identity.current` 只返回元数据。
- 刷新成功后派发 `shell:identity-changed`；401/403/410 清空令牌并派发 `shell:identity-expired`。
- 到 TTL 80% 由壳在启动/联网恢复时主动刷新；离线不发请求。并发刷新复用同一请求。
- 诊断只报 `security.identity: device | none`，不含令牌与设备唯一码。用户登录与权限仍归云根。

完整契约见 [shell-contract §31](../docs/shell-contract.md)。

### 插件签名与产物完整性（v0.8 M3）

```bash
# 1) 生成 Ed25519 密钥对：公钥进 uendos.trusted.json，私钥进 .uendos-keys/（600，禁止入库）
uendos plugin keygen --id acme-release

# 2) 给已安装的插件签名（覆盖 id + 版本 + manifest/runtime 双哈希）
uendos plugin sign @acme/uendos-plugin-printer --key .uendos-keys/acme-release.private.pem --id acme-release

# 3) 离线验签 / 出包前后校验
uendos plugin verify
uendos sync --check
uendos pack --target app --release
uendos doctor --offline --release-check --integrity
uendos publish --file <包> --item <条目> --download-dir <目录> --verify
```

签名文件 `uendos.plugin.sig`（v1）：

```json
{
  "v": 1,
  "alg": "ed25519",
  "keyId": "acme-release",
  "id": "@acme/uendos-plugin-printer",
  "version": "1.0.0",
  "manifest": "sha256-…",
  "runtime": "sha256-…",
  "sig": "<base64>",
  "signedAt": "2026-11-06T00:00:00.000Z"
}
```

- 信任链 `uendos.trusted.json` 只放公钥（`{ version, keys: [{ id, alg, publicKey }] }`），CLI 从工程目录逐级向上查找；无信任链或 `keyId` 缺失一律验签失败。
- 默认 `security.plugins.requireSigned=true`：未签名插件被 `plugin add` / `plugin update` / `sync` / `pack` 拒绝；开发期用 `--allow-unsigned` 或配置 `requireSigned=false` 放行。**放行只针对「未签名」**，签名损坏、内容被改、公钥缺失仍然拒绝。
- 锁 `uendos.plugins.lock` 记录 `version` / `integrity` / `manifest` / `signer`；`sync --check` 与 `doctor` 据此拦截版本、代码、声明与签名者漂移。
- `release/MANIFEST.json` 新增 `signature: signed | unsigned | dev`、`bridgeVersion`、`contractVersion` 与 `plugins[]`，每个 target 也带 `signature`。`doctor --integrity` 校验签名态与版本，`publish --verify` 在哈希一致之外复核签名态，标记 `signed` 时重新执行严格审计。
- 完整性只在构建期、出包前与发布前闭环；运行时不做远程校验，也不做热更新修复。

完整契约见 [shell-contract §32](../docs/shell-contract.md)。

### 入口路由（v0.7 M3）

```json
{
  "entry": {
    "routes": [
      { "id": "home", "label": "首页", "path": "/home", "params": { "tab": { "type": "string", "required": true, "enum": ["a", "b"] } } },
      { "id": "device-panel", "label": "设备面板", "path": "/iot", "fallback": "/home?tab=a", "requires": { "capability": "iot" } }
    ]
  }
}
```

```js
// 列入口（含可用性）；不可用时 reason 为 capability:<id> 或 offline
const routes = Shell.entries();

// 只校验、拼路径、派发事件；不跳转、不写业务数据
const r = await Shell.call('entry.open', { id: 'home', params: { tab: 'a' }, source: 'scan', idem: 'op-1' });
// r.data = { opened: true, id, path: '/home?tab=a', fallback, reason: null, source, idem }
Shell.on('shell:entry-open', (e) => { if (e.data.opened) location.assign(e.data.path); });
```

- 缺必填/未知参数/类型或 `enum` 不符 → `E_BAD_ARGS`；能力不足或离线 → `E_UNSUPPORTED`；两者都在 `data.fallback` 给出降级路径。
- 未知入口 → `E_BAD_ARGS`，不派发事件。真实跳转由 H5 决定，壳不接管业务路由。
- 深链：H5 监听 `shell:deeplink` 解析 URL 后调用 `entry.open`，参数仍走同一套校验。
- 配置了 `entry.routes` 时一致性断言从 48 增至 53。

完整契约见 [shell-contract §27](../docs/shell-contract.md)。

### 诊断快照（v0.7 M4）

```js
const d = Shell.diagnostics();
// { version, bridge, brand, env, platform, online, capabilities, plugins,
//   queue: { count, oldestAt }, events: [{ event, seq, at }], at }
```

```bash
uendos doctor --offline --json > diag.json   # 命令行侧诊断包，URL 去查询串、令牌/手机号打码
```

- 运行时快照只含 `event/seq/at`，**不携带事件 data**，避免 token、设备唯一码、地址外泄；队列只报数量与最老时间。
- CLI 诊断包字段与 `Shell.diagnostics()` 对齐（version / bridge / capabilities / plugins），另加配置、插件清单与逐项检查结果。
- 诊断只读，不触发重放、不写队列、不改业务状态。

完整契约见 [shell-contract §28](../docs/shell-contract.md)。

## 三套模板

| target | 技术栈 | 模板内已包含 |
|---|---|---|
| `app` | Capacitor 6 | `capacitor.config.json`（`webDir dist`、`server.url`/`allowNavigation`、`errorPath offline.html`）、身份选择页 `index.html`、离线页、`prepare-web.sh`、`assets/` 品牌源图、`npm run assets` 展开各平台尺寸 |
| `pc` | Electron 33 + electron-builder 25 | `main.js`（读 `uendos.runtime.json`、加载失败回落离线页、外链交给系统浏览器）、`preload.js`（`ShellDesktop`）、离线页、更新源指向 `/download/latest/` |
| `mp` | 原生小程序 + `web-view` | `project.config.json`、单页 `web-view` 承载、加载失败跳错误页；AppID 用 `touristappid` 占位 |

模板里的 `{{brand}}` `{{displayName}}` `{{appId}}` `{{accent}}` `{{shellFile}}` `{{primaryEndUrl}}` `{{projectName}}` `{{mpAppId}}` `{{allowHosts}}` `{{endKey}}` `{{contractVersion}}` 在 `init` 时一次性替换。

### 两种启动模式

- `portal`（默认）：`server.url` 指向主端，App 启动即进业务页；原生能力与既有四个品牌壳一致。
- `launcher`：`init --launch-mode launcher` 去掉 `server.url`，先加载本机选择页（`shell/picker.html`，按 `entry` 编排），选中端写入 `endKey` 后跳转，**重启记住上次所选端**；访问 `?picker=1` 可强制回到选择页。

`launcher` 模式的业务页由远程加载，Capacitor 原生插件是否可用取决于远程页能否拿到运行时；需要强原生能力（推送/震动/生物识别）时用 `portal`，由主端门户页负责切换。

## 55 项断言覆盖什么

`@uendos/conformance` 用 `vm` 构造最小浏览器沙箱（window / document / navigator / localStorage / fetch / CustomEvent），对生成的桥逐项断言：

| 分组 | 断言数 | 内容 |
|---|---|---|
| 结构 | 8 | `window.Shell` 单例、品牌别名、版本、`ends` / `currentEnd` / 能力矩阵 |
| 握手 | 4 | `core.handshake` 可重放、`core.ready`、bridgeVersion |
| 端切换 | 4 | `core.switchEnd` 合法/非法 id、`endKey` 持久化、事件载荷 |
| 事件 | 6 | seq 单调、`at` 存在、品牌事件双写、`off` 退订、`events.recent` 过滤/限流 |
| 错误协议 | 5 | `E_BAD_ARGS` / `E_UNSUPPORTED` / `E_DENIED` 等错误结构统一 |
| 离线队列 | 9 | 幂等键、顺序重放、4xx 出队、品牌作用域信封、旧数组迁移、重启恢复 |
| 店根适配 | 6 | 未配置 `E_UNSUPPORTED`、超时、`E_STOCK` 映射、租约缓存 |
| IoT 接入 | 2–4 | `iot` 能力位、无适配器降级、设备结构、`iot.write` 幂等与 `accepted + ackId` |
| 入口路由 | 0 / 5 | 配置了 `entry.routes` 时断言列表、成功打开、缺参、未知入口、能力不足降级 |
| 安全存储 | 4 | 内存降级往返、品牌前缀/类型/长度校验、不写 localStorage、诊断不含值 |
| 设备身份 | 3 | 能力位与配置一致、元数据不含令牌、刷新原子切换与吊销清空 |
| 诊断 | 2 | 快照字段完整、默认脱敏（事件不含 data） |
| 契约自洽 | 2 | 导出常量与运行时能力一一对应 |

断言在 `vm` 中跑，不需要 Android SDK / Xcode，CI 与本地一致。配置了 `plugins` 时，再按顺序执行各插件自带断言，总数为 `55 + N`（fixture 插件为 5 项，合计 60 项；IoT 适配器内置断言数会增至 57；配置 `entry.routes` 时内置断言为 60；入口路由与 IoT 适配器同时启用为 62）。插件签名与产物完整性不做运行时断言，由 CLI 测试覆盖（keygen → sign → verify → 篡改拦截）。

## CI 接法

```yaml
- uses: actions/setup-node@v4
  with: { node-version: '24' }
- run: cd sdk && npm ci && npm test && npm run check
- run: |
    UENDOS="$PWD/sdk/node_modules/.bin/uendos"
    "$UENDOS" init ci-smoke --brand ci-smoke --ends "hp:个人端:https://hp.example.com/" \
      --targets app,pc,mp --dir /tmp/ci-smoke
    cd /tmp/ci-smoke
    "$UENDOS" doctor --offline
    "$UENDOS" conformance
    "$UENDOS" sync --check
```

`npm test` 先跑运行时源一致性（`check-core`），再跑 43 项测试：契约校验 22 项、CLI 端到端 18 项（init → profile → launcher → theme → entry → add-end → doctor → 插件 → publish → plugin init → 插件依赖 → upgrade/diff → pack/publish 清单 → 插件完整性 keygen/sign/verify 与篡改拦截 → 更新通道 stable/beta、灰度与回滚）、conformance 自测 3 项；`npm run check` 可单独校验 SDK 内置 `core.js` 与 `shell-core/src/core.js` 未漂移。`doctor --offline` 不联网，CI 也不会因为端地址不可达而红。

## 打包与签名

```bash
# Android Debug（首次会自动 npm install + cap add android）
uendos pack --target app

# Android Release（凭据只从环境变量读，不写进仓库/工程）
UENDOS_KEYSTORE=/abs/release.keystore \
UENDOS_KEYSTORE_PASSWORD=*** UENDOS_KEY_ALIAS=release UENDOS_KEY_PASSWORD=*** \
uendos pack --target app --release
# 产物：android/app/build/outputs/apk/release/app-release.apk

# iOS（macOS + Xcode）
uendos pack --target ios --release   # 归档 build/App.xcarchive，再用 Xcode Organizer 导出 IPA
```

首次 `pack` 若发现 `assets/icon.png` 未展开到平台资源，会自动执行一次 `npm run assets`（`@capacitor/assets`），后续不会再覆盖开发者自定义图标。`--release` 会生成 `android/uendos-signing.gradle` 并在 `app/build.gradle` 追加一次 `apply from`，密码仅从环境变量读取。

## 发布

1. `uendos publish --file <包> --item <apps.json 条目 id> --manifest <清单路径> --download-dir <目录> --verify`：先校验产物与 `release/MANIFEST.json` 的大小/SHA-256 一致，再复制安装包、算哈希、把清单条目改为 `beta`（或 `--status stable`）并更新 `generatedAt`。
2. 稳定通道仍以 `btos-app-store/data/apps.json` 为唯一真相；SDK 不自行放开 `available`。
3. PC 更新按通道分流：`pack --target pc --channel stable|beta` 写 `latest[-mac|-linux].yml` / `latest[-mac|-linux]-beta.yml`，并把指针快照存到 `release/.channels/<channel>/<version>.yml`、在 `release/channels.json` 记 `current` / `previous`；两通道互不影响。发布后上传对应通道的指针与安装包。
4. 灰度与软回滚：`publish --channel beta --rollout 30` 只改通道注册表（不覆盖指针）；`publish --rollback --channel beta` 有上一版本快照时直接换回指针，否则把当前版本 `rollout=0` 且 `killSwitch=true`。不做二进制降级，已安装旧版本的客户端行为不变。
5. `doctor --release-check --channel beta` 校验指针版本、`files` 的 SHA-512/大小与本地产物一致，并拒绝跨桥版本（`bridgeVersion` 必须等于当前 `BRIDGE_VERSION`）。
6. `release/MANIFEST.json` 是「出包实物」的账本：顶层记 `signature`（`signed` / `unsigned` / `dev`）、`bridgeVersion`、`contractVersion`、`plugins[]`、`channel`、`rollout`、`killSwitch`；`targets.<app|pc>.artifacts[]` 记路径/文件名/大小/SHA-256；未签名时写 `signed: false` 并注明 `signMode`/`note`，不会伪造成已签名。发布前用 `uendos doctor --release-check --integrity` 与 `uendos publish --verify` 复核签名态与版本。

## 与现有仓的关系

- 四个品牌（cajob / ziway / xso / jechan）的存量壳工程继续由 [`shell-core/build.mjs`](../shell-core/build.mjs) 生成，SDK 与它产物形态一致，可逐端迁移。
- 契约变更顺序：先改 [`docs/shell-contract.md`](../docs/shell-contract.md)，再改 `@uendos/contract` 常量与断言，最后升级 `contractVersion`。
- 不落凭证：模板与 CLI 不含任何 AppID 密钥、证书、token；小程序 AppID 与业务域名由使用方在微信后台配置。

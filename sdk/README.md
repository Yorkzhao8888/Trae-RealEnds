# UendOS · 真实端壳开发者 SDK

把「H5 业务根 + 各端薄壳」沉淀成一套可复用的封装工具：开发者只写业务 H5，壳能力（App / PC / 小程序 / 浏览器）、原生桥、离线兜底、发布清单全部由 SDK 生成。

**定位**：壳不做业务。SDK 只决定「怎么送、送多少、何时送」，不判定优惠、不改订单、不算金额。

## 目录

```
sdk/
├── package.json                 # 私有 workspace（Node ≥ 18，零第三方依赖）
├── packages/
│   ├── contract/                # @uendos/contract：能力/方法/事件/错误码 + 配置校验 + JSON Schema
│   ├── shell/                   # @uendos/shell：运行时合成（把 shell-core 的 core.js + 品牌配置出桥）
│   ├── conformance/             # @uendos/conformance：39 项契约断言（vm 沙箱，不依赖真机）
│   ├── plugin-fixture/          # @uendos/plugin-fixture：插件机制 fixture（假打印机，仅测试用）
│   └── cli/                     # uendos CLI + App/PC/小程序三套模板
└── README.md
```

运行时唯一真源仍是 [`shell-core/src/core.js`](../shell-core/src/core.js)；`@uendos/shell` 用 `scripts/sync-core.mjs` 复制、用 `scripts/check-core.mjs` 校验，禁止在 SDK 内私改运行时。

## 分发包

- `BTOS-UendOS-SDK-0.4.0.zip`（184,422 B，SHA-256 `bd8edab7200461ebb0b85a11b966c12d4b4afedea5ad42c3dafbf63480018b4d`）
- `BTOS-UendOS-SDK-0.4.0.tar.gz`（143,351 B，SHA-256 `4786bec25606a3b7a1222f79d411b40a5abb2d9168fba0626c84f26c5b23adc9`）

> 0.4.0 分发包已在仓库 `dist/` 生成并实测：解压后 `cd sdk && npm ci && npm test` 为 25/25，`init → doctor --offline → conformance（39/39）→ sync --check` 全过。GitHub Release 尚未上传（缺推送凭据）。

解压后 `cd sdk && npm install`，包含 `docs/shell-contract.md`、`docs/uendos-customization-v0.4.md` 与 `shell-core/src/core.js`，因此 `check-core` 在包内也能通过；不含 `node_modules` 与任何凭证。

> 仓库当前代码版本为 **0.4.0**（v0.4 M1 个性化主题、M2 入口编排、M3 插件注册、M4 插件构建期热更新）；分发包与代码同版本。

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
uendos conformance               # 39 项契约断言（配置了插件时为 39 + N）
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
| `uendos sync` | 重新合成品牌桥与选择页 | `--check` 只校验不写，不一致时退出码 1 |
| `uendos doctor` | 体检：配置合法 / 桥与配置一致 / 各 target 模板文件 / 端 URL 可达（HEAD，405 回退 GET） | `--offline` 跳过联网；`--allow-http` 允许 http 端地址 |
| `uendos conformance` | 对品牌桥跑 39 项契约断言；配置了插件时合并插件断言，输出 `39 + N` | `--json` 输出机器可读结果；`--file` 直接指定桥文件 |
| `uendos profile` | 查看 `lite/standard/pro` 三档默认 target 与能力集 | `--json` 输出机器可读结果 |
| `uendos plugin add <包名>` | 把**已安装**的插件写入 `plugins` 并重新生成品牌桥（先预检声明合法） | `remove` 反向操作 |
| `uendos plugin update [<包名>...]` | 构建期升级插件：`npm install <包名>@latest` → 重新校验 → `sync`；变更随壳包发布 | `--spec` 指定版本/tarball/内网源；不给包名则升级全部 |
| `uendos assets` | 按主色与品牌字样生成 `assets/icon.png`（1024）与 `splash.png`（2732） | `--force` 覆盖已有图 |
| `uendos pack` | 本地打包（缺 `node_modules` / `android` / `ios` 时自动安装与生成平台工程） | `--target app`（Debug APK；`--release` 走签名）、`ios`（需 macOS）、`pc`（`npm run dist`）、`mp`（提示用微信开发者工具上传） |
| `uendos publish` | 计算 SHA-256/大小并回写商店清单 | `--file` `--item` `--manifest` `--url` 或 `--download-dir` `--version` `--status`（默认 `beta`） |

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
  "contractVersion": "0.3.2",
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
- **升级走构建期热更新**：`uendos plugin update`（默认 `@latest`，`--spec` 可指定版本/内网源）→ 重新校验声明 → `sync`；插件变更随壳包发布，业务侧不会在运行时拉取插件代码。
- **只允许构建期嵌入**，禁止运行时远程加载；包版本由 `package-lock.json` 锁定，必须提交。
- 注册即校验：id 唯一、能力不得与内置 18 项重名、多插件不得共享能力、方法命名空间必须是插件自己的能力且不占用 `core/edge/offline/desktop/shell`、方法不得与内置或其他插件重名，任一不满足 `sync` 直接报错。
- 激活与回落：只有 `detect(env)` 为真才算 `active`，否则能力记 `─`、方法返回 `E_UNSUPPORTED`；插件抛错映射 `E_NATIVE`。
- `Shell.plugins` 与握手 payload 携带 `[{ id, version, active }]`，线上可按版本排障。
- `uendos conformance` 合并插件自带的 `conformance.mjs`（导出 `[{ name, run(Shell) }]`），输出 `39 + N`；`doctor` 打印插件清单与合并后的能力集。
- `uendos pack` 打包前强制 `sync --check`，桥里的插件运行时必须与配置一致。

完整契约见 [shell-contract §21](../docs/shell-contract.md)，设计背景见 [个性化壳方案 §3](../docs/uendos-customization-v0.4.md)。

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

## 39 项断言覆盖什么

`@uendos/conformance` 用 `vm` 构造最小浏览器沙箱（window / document / navigator / localStorage / fetch / CustomEvent），对生成的桥逐项断言：

| 分组 | 断言数 | 内容 |
|---|---|---|
| 结构 | 8 | `window.Shell` 单例、品牌别名、版本、`ends` / `currentEnd` / 能力矩阵 |
| 握手 | 4 | `core.handshake` 可重放、`core.ready`、bridgeVersion |
| 端切换 | 4 | `core.switchEnd` 合法/非法 id、`endKey` 持久化、事件载荷 |
| 事件 | 4 | seq 单调、`at` 存在、品牌事件双写、`off` 退订 |
| 错误协议 | 5 | `E_BAD_ARGS` / `E_UNSUPPORTED` / `E_DENIED` 等错误结构统一 |
| 离线队列 | 6 | 幂等键、顺序重放、4xx 出队、上限裁剪 |
| 店根适配 | 6 | 未配置 `E_UNSUPPORTED`、超时、`E_STOCK` 映射、租约缓存 |
| 契约自洽 | 2 | 导出常量与运行时能力一一对应 |

断言在 `vm` 中跑，不需要 Android SDK / Xcode，CI 与本地一致。配置了 `plugins` 时，再按顺序执行各插件自带断言，总数为 `39 + N`（fixture 插件为 5 项，合计 44 项）。

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

`npm test` 先跑运行时源一致性（`check-core`），再跑 25 项测试：契约校验 15 项、CLI 端到端 9 项（init → profile → launcher → theme → entry → add-end → doctor → 插件 → publish）、conformance 自测 1 项；`npm run check` 可单独校验 SDK 内置 `core.js` 与 `shell-core/src/core.js` 未漂移。`doctor --offline` 不联网，CI 也不会因为端地址不可达而红。

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

1. `uendos publish --file <包> --item <apps.json 条目 id> --manifest <清单路径> --download-dir <目录>`：复制安装包、算 SHA-256/大小、把清单条目改为 `beta`（或 `--status stable`）并更新 `generatedAt`。
2. 稳定通道仍以 `btos-app-store/data/apps.json` 为唯一真相；SDK 不自行放开 `available`。
3. PC 更新：`pack --target pc` 后把安装包与 `latest.yml` / `latest-mac.yml` 同版本上传到 `/download/latest/`，缺 yml 会导致 updater 静默 404。

## 与现有仓的关系

- 四个品牌（cajob / ziway / xso / jechan）的存量壳工程继续由 [`shell-core/build.mjs`](../shell-core/build.mjs) 生成，SDK 与它产物形态一致，可逐端迁移。
- 契约变更顺序：先改 [`docs/shell-contract.md`](../docs/shell-contract.md)，再改 `@uendos/contract` 常量与断言，最后升级 `contractVersion`。
- 不落凭证：模板与 CLI 不含任何 AppID 密钥、证书、token；小程序 AppID 与业务域名由使用方在微信后台配置。

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
│   └── cli/                     # uendos CLI + App/PC/小程序三套模板
└── README.md
```

运行时唯一真源仍是 [`shell-core/src/core.js`](../shell-core/src/core.js)；`@uendos/shell` 用 `scripts/sync-core.mjs` 复制、用 `scripts/check-core.mjs` 校验，禁止在 SDK 内私改运行时。

## 分发包

- [BTOS-UendOS-SDK-0.3.1.zip](https://github.com/Yorkzhao8888/Trae-RealEnds/releases/download/uendos-sdk-v0.3.1/BTOS-UendOS-SDK-0.3.1.zip)（85,385 B，SHA-256 `dcfa07b839d36e05d63f532f8d68dbea12bc2b3c5b23ef73138fc80bc7bf0146`）
- [BTOS-UendOS-SDK-0.3.1.tar.gz](https://github.com/Yorkzhao8888/Trae-RealEnds/releases/download/uendos-sdk-v0.3.1/BTOS-UendOS-SDK-0.3.1.tar.gz)（58,553 B，SHA-256 `3afcf14f3acef29fa07daf029d8ea3edea1d45cbea1aa0b0f36668b1ba943df3`）

解压后 `cd sdk && npm install`，包含 `docs/shell-contract.md` 与 `shell-core/src/core.js`，因此 `check-core` 在包内也能通过；不含 `node_modules` 与任何凭证。

## 快速开始

```bash
cd sdk && npm install            # 安装 workspace，得到 npx uendos

npx uendos init acme \
  --brand acme \
  --ends "hp:个人端:https://hp.acme.example.com/,ep:企业端:https://ep.acme.example.com/" \
  --targets app,pc,mp \
  --app-id com.acme.app \
  --accent "#4C8DFF" \
  --dir ./acme

cd acme
npx uendos doctor                # 配置 / 产物 / 端可达性 / 模板体检
npx uendos conformance           # 39 项契约断言
npx uendos sync --check          # CI 用：产物必须与配置一致
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
| `uendos init <项目名>` | 建工程：拷模板 → 替换占位符 → 写配置 → 生成品牌桥与 `assets/` 源图 | `--brand` `--ends` `--targets` `--app-id` `--display` `--accent` `--mp-appid` `--launch-mode` `--dir` |
| `uendos add-end <id>` | 增加一个端并重新生成桥 | `--name` `--url` |
| `uendos sync` | 重新合成品牌桥 | `--check` 只校验不写，不一致时退出码 1 |
| `uendos doctor` | 体检：配置合法 / 桥与配置一致 / 各 target 模板文件 / 端 URL 可达（HEAD，405 回退 GET） | `--offline` 跳过联网；`--allow-http` 允许 http 端地址 |
| `uendos conformance` | 对品牌桥跑 39 项契约断言 | `--json` 输出机器可读结果；`--file` 直接指定桥文件 |
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
  "contractVersion": "0.3.1",
  "targets": ["app", "pc", "mp"],
  "packageId": "com.acme.app",
  "launchMode": "portal",
  "ends": {
    "hp": { "name": "个人端", "url": "https://hp.acme.example.com/" },
    "ep": { "name": "企业端", "url": "https://ep.acme.example.com/" }
  }
}
```

约束（`validateConfig` 与 `schema/uendos.config.schema.json` 同步）：

- `brand` 小写，`^[a-z][a-z0-9-]{1,15}$`；`accent` 为 `#RRGGBB`
- `ends` 至少 1 个，`id` 2–4 位小写字母；`url` 必须是 https（`--allow-http` 仅供内网联调）
- `targets` 取值 `app` / `pc` / `mp`；`contractVersion` 主版本必须与 SDK 当前契约一致
- `launchMode` 为 `portal`（默认，启动直进主端）或 `launcher`（本机选择页，记住上次所选端）

## 三套模板

| target | 技术栈 | 模板内已包含 |
|---|---|---|
| `app` | Capacitor 6 | `capacitor.config.json`（`webDir dist`、`server.url`/`allowNavigation`、`errorPath offline.html`）、身份选择页 `index.html`、离线页、`prepare-web.sh`、`assets/` 品牌源图、`npm run assets` 展开各平台尺寸 |
| `pc` | Electron 33 + electron-builder 25 | `main.js`（读 `uendos.runtime.json`、加载失败回落离线页、外链交给系统浏览器）、`preload.js`（`ShellDesktop`）、离线页、更新源指向 `/download/latest/` |
| `mp` | 原生小程序 + `web-view` | `project.config.json`、单页 `web-view` 承载、加载失败跳错误页；AppID 用 `touristappid` 占位 |

模板里的 `{{brand}}` `{{displayName}}` `{{appId}}` `{{accent}}` `{{shellFile}}` `{{primaryEndUrl}}` `{{projectName}}` `{{mpAppId}}` `{{allowHosts}}` `{{endKey}}` `{{contractVersion}}` 在 `init` 时一次性替换。

### 两种启动模式

- `portal`（默认）：`server.url` 指向主端，App 启动即进业务页；原生能力与既有四个品牌壳一致。
- `launcher`：`init --launch-mode launcher` 去掉 `server.url`，先加载本机选择页，选中端写入 `endKey` 后跳转，**重启记住上次所选端**；访问 `?picker=1` 可强制回到选择页。

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

断言在 `vm` 中跑，不需要 Android SDK / Xcode，CI 与本地一致。

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

`npm test` 先跑运行时源一致性（`check-core`），再跑 15 项测试：契约校验 9 项、CLI 端到端 5 项（init → launcher → add-end → doctor → publish）、conformance 自测 1 项；`npm run check` 可单独校验 SDK 内置 `core.js` 与 `shell-core/src/core.js` 未漂移。`doctor --offline` 不联网，CI 也不会因为端地址不可达而红。

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

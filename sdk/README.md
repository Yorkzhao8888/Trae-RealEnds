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

- [BTOS-UendOS-SDK-0.3.0.zip](https://github.com/Yorkzhao8888/Trae-RealEnds/releases/download/uendos-sdk-v0.3.0/BTOS-UendOS-SDK-0.3.0.zip)（77,709 B，SHA-256 `ca5853a9e8ff2879493d8e08eea3a423424e99b7de07499eabe7f7275292c7f5`）
- [BTOS-UendOS-SDK-0.3.0.tar.gz](https://github.com/Yorkzhao8888/Trae-RealEnds/releases/download/uendos-sdk-v0.3.0/BTOS-UendOS-SDK-0.3.0.tar.gz)

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
| `uendos init <项目名>` | 建工程：拷模板 → 替换占位符 → 写配置 → 生成品牌桥 | `--brand` `--ends` `--targets` `--app-id` `--display` `--accent` `--mp-appid` `--dir` |
| `uendos add-end <id>` | 增加一个端并重新生成桥 | `--name` `--url` |
| `uendos sync` | 重新合成品牌桥 | `--check` 只校验不写，不一致时退出码 1 |
| `uendos doctor` | 体检：配置合法 / 桥与配置一致 / 各 target 模板文件 / 端 URL 可达（HEAD，405 回退 GET） | `--offline` 跳过联网；`--allow-http` 允许 http 端地址 |
| `uendos conformance` | 对品牌桥跑 39 项契约断言 | `--json` 输出机器可读结果；`--file` 直接指定桥文件 |
| `uendos pack` | 本地打包 | `--target app`（`npx cap sync` + `gradlew assembleDebug`）、`pc`（`npm run dist`）、`mp`（提示用微信开发者工具上传） |
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
  "contractVersion": "0.3.0",
  "targets": ["app", "pc", "mp"],
  "packageId": "com.acme.app",
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

## 三套模板

| target | 技术栈 | 模板内已包含 |
|---|---|---|
| `app` | Capacitor 6 | `capacitor.config.json`（`webDir dist`、`server.url` 指主端、`errorPath offline.html`）、身份选择页 `index.html`、离线页、`prepare-web.sh` |
| `pc` | Electron 33 + electron-builder 25 | `main.js`（读 `uendos.runtime.json`、加载失败回落离线页、外链交给系统浏览器）、`preload.js`（`ShellDesktop`）、离线页、更新源指向 `/download/latest/` |
| `mp` | 原生小程序 + `web-view` | `project.config.json`、单页 `web-view` 承载、加载失败跳错误页；AppID 用 `touristappid` 占位 |

模板里的 `{{brand}}` `{{displayName}}` `{{appId}}` `{{accent}}` `{{shellFile}}` `{{primaryEndUrl}}` `{{projectName}}` `{{mpAppId}}` `{{contractVersion}}` 在 `init` 时一次性替换。

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

`npm test` 先跑运行时源一致性（`check-core`），再跑 14 项测试：契约校验 9 项、CLI 端到端 4 项（init → add-end → doctor → publish）、conformance 自测 1 项；`npm run check` 可单独校验 SDK 内置 `core.js` 与 `shell-core/src/core.js` 未漂移。`doctor --offline` 不联网，CI 也不会因为端地址不可达而红。

## 发布

1. `uendos publish --file <包> --item <apps.json 条目 id> --manifest <清单路径> --download-dir <目录>`：复制安装包、算 SHA-256/大小、把清单条目改为 `beta`（或 `--status stable`）并更新 `generatedAt`。
2. 稳定通道仍以 `btos-app-store/data/apps.json` 为唯一真相；SDK 不自行放开 `available`。
3. PC 更新：`pack --target pc` 后把安装包与 `latest.yml` / `latest-mac.yml` 同版本上传到 `/download/latest/`，缺 yml 会导致 updater 静默 404。

## 与现有仓的关系

- 四个品牌（cajob / ziway / xso / jechan）的存量壳工程继续由 [`shell-core/build.mjs`](../shell-core/build.mjs) 生成，SDK 与它产物形态一致，可逐端迁移。
- 契约变更顺序：先改 [`docs/shell-contract.md`](../docs/shell-contract.md)，再改 `@uendos/contract` 常量与断言，最后升级 `contractVersion`。
- 不落凭证：模板与 CLI 不含任何 AppID 密钥、证书、token；小程序 AppID 与业务域名由使用方在微信后台配置。

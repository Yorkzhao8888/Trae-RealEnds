# UendOS 个性化壳方案（v0.4 设计草案）

回答一个后续产品问题：**能不能按客户需求做个性化的「壳」？**

可以，但个性化必须落在**配置、主题与插件**三处，而不是 fork 模板。目标是：一百个客户，仍然只有一份 SDK、一条升级路径。

---

## 1. 三层定制模型

| 层级 | 客户能给什么 | 走什么机制 | 谁来做 | 升级影响 |
|---|---|---|---|---|
| L1 白标 | 品牌名、主色、图标/启动图、端地址、包名、档位、启动方式 | 只改 `uendos.config.json` | 客户自助 | 无，跟随 SDK |
| L2 轻定制 | 主题、选择页文案与编排、能力白名单 | 配置扩展 + `sync` 重新生成 | 我方配置化交付 | 无，配置向前兼容 |
| L3 深定制 | 行业原生插件（打印/蓝牙/扫码枪/工牌/称重） | 插件包 + 运行时注册 | 我方项目制 | 插件独立版本，随包锁版本 |

三条硬边界：

1. **壳不做业务**。个性化再深，业务仍在云根 H5；否则退化成"一客户一 App"。
2. **不 fork 模板**。客户差异只存在于配置文件、主题包、插件包；模板保持单一来源，`sync --check` 继续在 CI 拦手改。
3. **profile 仍不是权限**。L2 的能力白名单只是构建期裁剪，租户/角色授权仍由云根裁决。

---

## 2. L2 配置契约（可选字段，向后兼容）

```json
{
  "contractVersion": "0.4.0",
  "profile": "standard",

  "theme": {
    "mode": "light",
    "tokens": {
      "bg": "#FFFFFF",
      "surface": "#F6F9FD",
      "ink": "#0B1220",
      "inkMuted": "#7B8AA0",
      "line": "#E4E9F2",
      "accent": "#4C8DFF",
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

  "caps": { "allow": ["vibrate", "share", "push", "camera"] }
}
```

### 2.1 theme

- `mode` 取 `light` / `dark`；`tokens` 全部可选，缺省回落到当前默认值。
- 颜色必须 `#RRGGBB`；`radius` 0–28；`fontScale` 0.9–1.2（防止客户把字号调坏）。
- **作用域只有壳自有页面**：选择页、启动兜底页、错误页。远程 H5 根不强制套主题，但可从 `Shell.theme` 读取并自行适配。
- 落地方式：`sync` 把 `theme` 写进品牌桥的 `runtimeCfg`，运行时在 `documentElement` 上挂 CSS 变量（`--uendos-bg` / `--uendos-ink` / `--uendos-radius` …）并设置 `color-scheme`；选择页模板只使用这些变量，不再硬编码色值。
- 图标/启动图仍由 `assets/icon.png` 优先；`theme.tokens.accent` 只在未提供源图时参与生成。

### 2.2 entry

- 只影响 `launcher`/选择页，不改 `portal` 直进逻辑。
- `order` 中的端 id 必须存在，否则 `doctor` 失败；未列出的端按配置顺序排在后面。
- `groups` 可选；给了就按组渲染，组内 `ends` 必须存在且不得重复。
- `rememberLast: false` 时每次冷启都回选择页（适合共用设备的门店场景）。
- **选择页改为 `sync` 生成的产物**（`shell/picker.html`），与品牌桥一样受 `sync --check` 保护；不再由 `init` 一次性渲染后靠手改。

### 2.3 caps.allow

- 语义：在 `profile` 能力集与插件能力集的并集之上做**进一步收窄**。
- 校验：`allow` 中每一项必须属于该档位能力集或某个已声明插件的能力，否则 `doctor` 失败。
- `doctor` 必须打印一行**生效能力集**（`lite/standard/pro` 上限 ∩ allow ∪ 插件能力）。
- 运行时仍按环境探测给出真实值（`✓` / `◐` / `─` / `web`），配置不放宽实际能力。

---

## 3. L3 插件契约

### 3.1 插件包形态

插件是一个普通 npm 包，根目录放 `uendos.plugin.json`（声明）与 `runtime.js`（浏览器侧适配代码，不依赖 Node）：

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
// runtime.js —— 由 CLI 包进函数作用域后注入品牌桥，不直接执行
return {
  detect: function (env) { return env === 'capacitor' || env === 'electron'; },
  methods: {
    'printer.print': function (a) { /* 调 Capacitor 插件 */ },
    'printer.status': function () { /* ... */ },
  },
  capabilities: { printer: '✓' },
};
```

配置里只写包名，能力声明以插件包为唯一真相，避免两处漂移：

```json
{ "plugins": ["@acme/uendos-plugin-printer"] }
```

### 3.2 注册与合成

- `uendos sync` 在 Node 侧解析插件（必须已 `npm install` 到工程里），读取 `uendos.plugin.json`，把 `runtime.js` 嵌入品牌桥：

```js
ShellCore.registerPlugin('@acme/uendos-plugin-printer', function () {
  /* runtime.js 原文 */
});
ShellCore.create(config);
```

- 运行时新增 `ShellCore.registerPlugin(id, factory)` 与 `Shell.plugins`（id + version 列表，握手可见，便于线上排障）。
- 插件方法并入现有 `METHODS` 分发表；未知方法仍返回 `E_UNSUPPORTED`，插件抛错统一映射 `E_NATIVE`，业务只按 `code` 分支。
- 插件能力只有 `detect(env)` 为真时才记为 `✓`，否则回落到 `─`/`web`；不允许静态宣称。
- 桥版本 `2 → 3`（新增 register 与 `plugins` 字段），契约断言同步扩展。

### 3.3 校验规则（`doctor`）

| 规则 | 失败表现 |
|---|---|
| 插件可解析 | 提示 `npm install <pkg>` |
| `id` 唯一、与配置里的包名一致、是合法 npm 包名 | 报重复/非法 id |
| 能力不得与内置 18 项重名 | 报冲突 |
| 方法命名必须落在插件自己的命名空间 | 禁止占用 `core.*` / `edge.*` / `offline.*` / `desktop.*` |
| `profile=lite` 不允许插件 | 提示升档或去掉插件 |
| `runtime.js` 存在且非空 | 报缺失 |
| 声明的 `methods` 与 `capabilities` 非空且一一对应 | 报声明不完整 |

### 3.4 一致性测试扩展

- 39 项内置断言不变；插件自带 `conformance.mjs`（导出 `[{ name, run }]`），`uendos conformance` 合并执行，输出 `39 + N`。
- 插件断言至少覆盖：方法存在、参数错误返回 `E_BAD_ARGS`、能力缺失返回 `E_UNSUPPORTED`、正常路径返回 `ok:true`。
- CI 增加一个 fixture 插件（`@uendos/plugin-fixture`，假打印机），跑 `uendos plugin add` → `doctor` → `conformance`（44 项）→ `sync --check`。

### 3.5 升级（构建期热更新）

`uendos plugin update [<包名>...] [--spec <npm spec>]`：默认 `npm install <包名>@latest`，装完重新校验声明与冲突，再 `sync` 重新嵌入品牌桥。变更随壳包发布（App 走 APK/商店、PC 走更新源），所以"热更新"的粒度是**发一次壳包**，不是运行时拉插件代码。

- 回滚：`--spec <包名>@<旧版本>` 退回后再出包。
- 内网：`--spec` 可指向私有 registry / tarball，避免默认公网源。
- 不提供运行时动态加载：桥里只有构建时嵌入的 runtime，`Shell.plugins` 仅做版本上报。

---

## 4. CLI 变更

| 命令 | 变更 |
|---|---|
| `uendos init` | 不变（暂不支持 `--theme` / `--plugin`）；主题直接写配置，插件用 `uendos plugin add` 装包 |
| `uendos sync` | 重新生成 `shell/picker.html`；嵌入插件运行时；`--check` 同时校验桥与选择页 |
| `uendos doctor` | 新增主题/入口/能力白名单/插件四组校验；打印生效能力集与插件清单 |
| `uendos conformance` | 合并插件断言，输出总数变为 `39 + N` |
| `uendos plugin add/remove` | `add` 装包 → 写 `plugins` → `sync`；`remove` 反向 |
| `uendos plugin update` | 装新版本 → 重新校验声明/冲突 → `sync`；不提供运行时加载 |
| `uendos pack` | 不变；构建前强制 `sync --check` |

---

## 5. 兼容与版本

- 契约版本 `0.3.2 → 0.4.0`；schema 的 `contractVersion` 放宽为 `^0\.(3|4)(\.[0-9]+)?$`，四个新字段全部可选。
- 旧工程不配置 `theme/entry/caps/plugins` 时行为与 0.3.2 完全一致；选择页仍可继续用旧产物，首次 `sync` 后切到生成版。
- 数据不变：`endKey`、离线队列键、登录态不随主题/插件变化。
- 插件升级：`plugin update` 只改构建产物，运行时协议不变（桥版本仍为 3）。
- 回滚：插件是独立包，出问题移除配置项并 `sync` 即可，无需回退整个 SDK。

---

## 6. 风险与反模式

风险：

- **主题只管壳自有页面**。客户若要求"远程 H5 也换肤"，那是云根主题，不在壳的能力范围。
- **插件是供应链入口**。只允许构建期嵌入、锁版本（`package-lock.json` 必须提交），禁止运行时远程加载插件代码。
- **插件升级可能破坏断言**。`Shell.plugins` 带版本上报，线上可按版本定位问题。

反模式：

- 为客户复制一份模板或复制一份 H5 业务代码；
- 用 `theme` 承载业务文案或权限差异；
- 插件里写业务规则（计价、审批、库存判定）；
- 一个能力接多个 provider 却不声明优先级；
- 用 `entry.order` 隐藏端来"做权限"（隐藏只是不展示，不拦调用）。

---

## 7. 里程碑

| 阶段 | 范围 | 验收 |
|---|---|---|
| M1（已实现） | `theme` + CSS 变量 + `doctor` 校验 | 同一工程换主题后 `sync --check` 通过；选择页无硬编码色值 |
| M2（已实现） | `entry` + 生成式 `shell/picker.html` | 编排/分组/记忆开关三项在真机选择页可见 |
| M3（已实现） | 插件注册 + `Shell.plugins` + 断言合并 | fixture 插件 `39+N`（44 项）全过；冲突/缺失/越权命名空间负例均失败 |
| M4（已实现） | 文档、schema、`0.4.0` 发版与打包；插件构建期升级 `plugin update` | `plugin update` 后 `sync --check` 通过；分发包已生成并实测；旧工程升级零改动 |

M1/M2 可先交付（客户可自助）；M3/M4 已实现（`0.4.0` 分发包已生成并实测，GitHub Release 待上传）。

---

## 8. 版本记录

- **M4 已实现（2026-10-31）**：新增 `uendos plugin update [<包名>...] [--spec <npm spec>]`——构建期升级插件（`npm install` → 重新校验 → `sync`），`--spec` 支持指定版本/tarball/内网源；明确「热更新 = 发壳包」，不提供运行时动态加载。测试覆盖 v0.1.0 → v0.2.0 升级与幂等「已是最新」。分发包 `BTOS-UendOS-SDK-0.4.0.zip` / `.tar.gz` 已生成并解压实测（`npm test` 25/25、conformance 39/39）。
- **M3 已实现（2026-10-31）**：`plugins` 配置、`uendos.plugin.json` 与 `runtime.js` 构建期嵌入（`ShellCore.registerPlugin`）、`Shell.plugins` 与握手携带、能力按 `detect(env)` 回落、未激活方法 `E_UNSUPPORTED`、插件断言合并（`39 + N`）、`uendos plugin add/remove`、`pack` 前强制 `sync --check`；桥版本 3、契约 0.4.0；fixture 插件实测 44/44，测试 25/25。
- **M2 已实现（2026-10-31）**：`entry`（标题/副标题/顺序/分组/记忆开关）、选择页改为 `sync` 生成的 `shell/picker.html` 并纳入 `sync --check`、`index.html` 改为跳转、`prepare:web` 复制选择页、`doctor` 打印入口摘要；测试 22/22。
- **M1 已实现（2026-10-31）**：`theme`（`mode` + 8 个 token）、运行时 CSS 变量与 `color-scheme`/`theme-color`、`Shell.theme` 与握手携带、`doctor` 主题校验、选择页去硬编码色值；测试 19/19。
- **v0.4（草案）**：`theme` / `entry` / `caps.allow` / `plugins` 四个可选配置；选择页生成化；插件运行时注册与断言合并；桥版本 3。
- v0.3.2：`profile` 三档（见 [版本档位与能力矩阵](./uendos-editions.md)）。

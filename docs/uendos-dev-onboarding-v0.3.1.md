# UendOS 开发者接入指南（v0.3.1）

面向第一次接壳的团队开发者：从零生成工程、注入品牌桥、打包发布，并完成 **launcher 模式与原生插件的兼容性验证**。

- SDK 版本：`0.3.1`（契约 `0.3.1`，桥版本 `2`）
- 适用：App（Capacitor 6）、PC（Electron 33）、小程序（web-view）
- 产物：`uendos` CLI + `@uendos/contract` + `@uendos/shell` + `@uendos/conformance`（39 项断言）

> 本文的“必须验证”结论不能靠推断：`launcher` 模式下业务页是远程加载，能否使用 Capacitor 原生插件取决于运行时是否注入到该页面，**必须在真机上按第 6 节逐项记录**。

---

## 1. 前置条件

| 目标 | 需要 |
|---|---|
| 全部 | Node 18+（建议 24）、`npm` |
| Android | JDK 17、Android SDK（`platforms;android-34`、`build-tools;34.0.0`） |
| iOS | macOS + Xcode（Apple Silicon/Intel 均可） |
| PC | Windows/macOS/Linux，`electron-builder` 所需平台工具 |
| 小程序 | 微信开发者工具、小程序 AppID |

业务侧需要准备：

1. 每个端的 HTTPS 地址（`https://`，证书有效）
2. 品牌名（小写字母/数字/连字符，2–16 位）、主色 `#RRGGBB`、包名
3. 远程 H5 能放一个静态文件（品牌桥与探针页）

---

## 2. 五分钟生成工程

```bash
# SDK
git clone https://github.com/Yorkzhao8888/Trae-RealEnds.git
cd Trae-RealEnds/sdk && npm install

# 让 uendos 在任意目录可用（未发布到 npm，不能用 npx 自动拉取）
alias uendos="node $(pwd)/packages/cli/bin/uendos.mjs"
# 建议写入 ~/.zshrc / ~/.bashrc；或者始终用 node /abs/path/packages/cli/bin/uendos.mjs

# 生成工程（多端 + 三种 target）
uendos init acme \
  --brand acme \
  --ends "hp:个人端:https://hp.acme.example.com/，ep:企业端:https://ep.acme.example.com/" \
  --targets app,pc,mp \
  --app-id com.acme.app \
  --display "Acme" \
  --accent "#4C8DFF" \
  --mp-appid wx1234567890abcdef \
  --dir ./acme
```

`init` 会完成：

- 拷贝 `app` / `pc` / `mp` 模板并替换占位符
- 写 `uendos.config.json`、生成 `shell/<brand>-shell.js`
- 生成 `assets/icon.png`（1024）与 `assets/splash.png`（2732）
- App 模板里写入 `server.allowNavigation`（由端 host 自动生成）

> 端定义分隔符支持 `,` 与中文 `，`；URL 必须是 `http(s)` 绝对地址。

### 工程结构

```
acme/
├── uendos.config.json          # 唯一配置源
├── shell/acme-shell.js         # 品牌桥（由 shell-core 合成，勿手改）
├── dist/                       # App 的 webDir（首次 sync 后出现）
├── assets/                     # 品牌源图
├── capacitor.config.json       # App 平台配置
├── index.html / offline.html   # 入口跳转 / 离线页（选择页由 sync 生成 shell/picker.html）
├── package.json                # Capacitor / Electron / 小程序工程
└── uendos.runtime.json         # PC 运行时（brand/primaryEnd/shellFile）
```

配置示例：

```json
{
  "schemaVersion": 1,
  "brand": "acme",
  "alias": "acmeOS",
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

`launchMode` 只能是 `portal`（默认）或 `launcher`。

---

## 3. 业务 H5 注入品牌桥（必做）

壳只是容器；业务页要拿到 `window.Shell`，必须自己引入品牌桥：

```html
<!-- 放到业务端可访问的静态路径 -->
<script src="/shell/acme-shell.js"></script>
```

约定：

- 桥文件名由品牌决定：`<brand>-shell.js`（`ziway` 例外为 `ziwayos-shell.js`）
- 桥不依赖构建工具，可直接 `<script>`；必须早于业务脚本执行
- 引入后监听就绪事件：

```js
Shell.on('shell:ready', (e) => {
  console.log('env=', Shell.env, 'caps=', Shell.capabilities, e.data);
});
```

- 自检可随时重放握手：

```js
const hs = await Shell.call('core.handshake');
// { bridge, version, brand, platform, env, capabilities, ends, end, accent }
```

> 常见错误：业务页没引桥，`Shell is not defined`；或桥被 CSP / 404 拦截。先解决这两类，再谈原生能力。

---

## 4. 三种 target 的接入差异

### 4.1 App（Capacitor 6）

```bash
cd acme
npm install
npm run add:android      # 首次；pack 也会自动补
uendos doctor --offline
uendos conformance   # 39/39
uendos pack --target app
```

- `pack` 自动：`npm install` → `prepare:web` → `cap add android` → 品牌图标展开（仅首次）→ `cap sync` → `assembleDebug`
- 首次出包后，后续只需改业务 H5；壳配置变更用 `uendos sync` + `cap sync`
- `launcher` 模式的选择页（`shell/picker.html`，由 `uendos sync` 生成，`index.html` 仅做跳转）只在本机 `dist` 中生效，见第 5 节

### 4.2 PC（Electron 33）

```bash
uendos pack --target pc   # npm run dist
```

- `uendos.runtime.json` 决定启动端、品牌与壳文件
- 外链由 `windowOpenHandler` 交给系统浏览器
- 自动更新源在模板 `build.publish` 中（默认 `https://cajob.cewaysoft.com/download/latest/`，按品牌改）

### 4.3 小程序（web-view）

```bash
uendos pack --target mp   # 提示：用微信开发者工具上传
```

- `project.config.json` 中的 `{{mpAppId}}` 在 `init` 时替换
- `pages/index` 用 `web-view` 打开主端；`onError` 跳错误页
- 小程序不支持 Capacitor 能力，`Shell.env` 为 `mp`，只能使用 `openExternal` / `subscribeMsg` 等受限项

---

## 5. portal 与 launcher：先选对模式

| | `portal`（默认） | `launcher` |
|---|---|---|
| 启动 | `server.url` 直指主端 | 先加载本机选择页 |
| 多端切换 | 由主端门户页负责 | 选择页写入 `endKey` 后跳转 |
| 重启记忆 | 永远回主端 | 记住上次所选端 |
| 回选择页 | 不涉及 | `?picker=1`（仅本机页可达） |
| 原生插件 | 与既有四个品牌壳一致 | **取决于远程页是否注入运行时，必须验证** |
| 适用 | 需要推送/震动/相机/生物的正式业务 | 纯 Web 业务、内部多端入口、演示 |

创建 launcher 工程：

```bash
uendos init acme-launcher \
  --brand acme \
  --ends "hp:个人端:https://hp.acme.example.com/，ep:企业端:https://ep.acme.example.com/" \
  --targets app \
  --app-id com.acme.launcher \
  --launch-mode launcher \
  --dir ./acme-launcher
```

实现要点：

- `init` 会删掉 `capacitor.config.json` 的 `server.url`，保留 `allowNavigation`
- 选择页逻辑：读 `localStorage[endKey]` → 有则 `location.replace(url)`；点击端时写 `endKey` 再 `Shell.call('core.switchEnd')`
- 业务页不在 `dist`，因此选择页的 `Shell` 实例不会自动传递给业务页；业务页必须自己引桥（第 3 节）

---

## 6. launcher 与原生插件兼容性验证（重点）

目标：确认 **launcher 模式下业务远程页是否拿到 Capacitor 运行时**，并据此决定能否在业务页使用原生能力。

### 6.1 准备两个可并存的 Debug 包

```bash
# A：portal 对照
uendos init acme-portal --brand acme \
  --ends "hp:个人端:https://hp.acme.example.com/，ep:企业端:https://ep.acme.example.com/" \
  --targets app --app-id com.acme.portal --launch-mode portal --dir ./acme-portal

# B：launcher 被测
uendos init acme-launcher --brand acme \
  --ends "hp:个人端:https://hp.acme.example.com/，ep:企业端:https://ep.acme.example.com/" \
  --targets app --app-id com.acme.launcher --launch-mode launcher --dir ./acme-launcher

# 两个都要打包（Debug 即可）
cd acme-portal && npm install && uendos pack --target app && cd ..
cd acme-launcher && npm install && uendos pack --target app && cd ..

adb install -r acme-portal/android/app/build/outputs/apk/debug/app-debug.apk
adb install -r acme-launcher/android/app/build/outputs/apk/debug/app-debug.apk
```

要点：

- 两个包 **packageId 必须不同**，否则会覆盖安装
- 两个工程的品牌/端一致，只差 `launchMode`，排除其他变量

### 6.2 部署探针页

把同一份探针页放到每个端可访问的路径，例如 `https://hp.acme.example.com/uendos-probe.html`，并把品牌桥放到 `/shell/acme-shell.js`。

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>UendOS 兼容性探针</title>
  <style>
    body{font:14px/1.6 system-ui,-apple-system,sans-serif;margin:16px;background:#0b1220;color:#e6edf7}
    h1{font-size:16px}
    pre{background:#111a2b;padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-all}
    button{margin:4px 6px 4px 0;padding:8px 10px;border:0;border-radius:6px;background:#4c8dff;color:#fff}
    .k{color:#8fb8ff}
  </style>
</head>
<body>
  <h1>UendOS 探针 · <span id="ver">-</span></h1>
  <div id="bars"></div>
  <pre id="out">加载中…</pre>

  <!-- 1) 品牌桥：必须最先加载 -->
  <script src="/shell/acme-shell.js"></script>
  <script>
    const out = document.getElementById('out');
    const bars = document.getElementById('bars');
    const rec = [];

    function render(obj) { out.textContent = JSON.stringify(obj, null, 2); }
    function log(name, value) { rec.push({ name, value }); render({ result: rec }); }

    function summary() {
      const s = window.Shell;
      if (!s) { render({ error: 'Shell 未注入：检查桥地址/CSP' }); return; }
      document.getElementById('ver').textContent = 'v' + s.version + ' / bridge ' + s.bridge;
      const caps = {};
      Object.keys(s.capabilities || {}).forEach(k => caps[k] = s.capabilities[k]);
      const nativeish = Object.values(caps).filter(v => v === '✓').length;
      render({
        env: s.env, platform: s.platform, brand: s.brand,
        ready: s.ready, nativeCapabilities: nativeish,
        capabilities: caps,
        ends: s.ends,
      });
    }

    window.addEventListener('shell:ready', e => {
      log('shell:ready', e.detail);
      summary();
    });

    function addBtn(label, fn) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = async () => {
        try { log(label, await fn()); } catch (e) { log(label, { thrown: String(e) }); }
      };
      bars.appendChild(b);
    }

    addBtn('握手 handshake', () => Shell.call('core.handshake'));
    addBtn('能力 capabilities', () => Shell.call('core.capabilities'));
    addBtn('震动 vibrate', () => Shell.call('core.vibrate', { duration: 80 }));
    addBtn('分享 share', () => Shell.call('core.share', { title: 'UendOS', text: '探针', url: location.href }));
    addBtn('定位 location', () => Shell.call('core.location', { highAccuracy: true }));
    addBtn('推送 push.request', () => Shell.call('core.push.request'));
    addBtn('推送 push.token', () => Shell.call('core.push.token'));
    addBtn('状态栏 statusBar', () => Shell.call('core.statusBar', { style: 'light', color: '#0B1220' }));
    addBtn('当前端 core.end', () => Shell.call('core.end'));
  </script>
</body>
</html>
```

判读字段：

| 字段 | 含义 | 关键值 |
|---|---|---|
| `Shell.env` | 运行时探测到的环境 | `capacitor`（原生注入）/ `web`（未注入）/ `electron` / `mp` |
| `Shell.platform` | 平台 | `android` / `ios` / `web` |
| `Shell.capabilities.push` | 推送能力 | `✓` 原生可用；`web` 或 `─` 不可用 |
| `core.push.request` / `core.push.token` | 真实原生调用 | 返回 `ok` 或 `E_UNSUPPORTED` |
| `core.vibrate` | 参考项 | **不能单独作为原生证据**：Web 下会退回 `navigator.vibrate` |

> 结论口径：`Shell.env === 'capacitor'` 且 `capabilities.push === '✓'` 才算业务页拿到原生运行时。仅“震动成功”不算。
>
> 日志里的 `v0.2.0` 是运行时核心版本（`Shell.version`），与 SDK `0.3.1` 不是同一个版本号，二者不要混淆。

### 6.3 逐项验证步骤

对 `portal` 与 `launcher` 各跑一遍，建议每步截图/录屏留档。

1. **冷启动**
   - portal：应直接进入主端业务页
   - launcher：应先看到本机选择页
2. **选择页自检（仅 launcher）**
   - 用 Chrome `chrome://inspect` / Safari Web Inspector 连 WebView
   - 在控制台执行 `Shell.env`，应为 `capacitor`
   - 执行 `Object.keys(Shell.capabilities).length`（应为 18）
3. **进入业务页**
   - launcher：点一个端，确认跳转到该端
   - 两个包都打开探针页（把端 URL 临时指向 `/uendos-probe.html`，或从业务页放链接进入）
4. **记录环境**
   - `Shell.env`、`Shell.platform`、`capabilities.push`、`capabilities.vibrate`
   - 预期：portal = `capacitor` / `android|ios` / `✓` / `✓`
   - launcher = **记录实测值**；若为 `web`，即业务页未拿到运行时
5. **调用原生方法**
   - 依次点 `push.request`、`push.token`、`share`、`location`、`statusBar`
   - 记录每项 `ok` / `code`
   - `E_UNSUPPORTED` 说明该方法在当前页面没有原生实现；`E_DENIED` 是权限问题，需要系统设置
6. **多端与记忆**
   - launcher：选 `hp` → 杀进程 → 重开，应直接进 `hp`；再选 `ep` → 重开进 `ep`
   - launcher：从业务页按 Android 返回键，观察是否回到选择页（依赖 WebView 历史）
   - portal：重开应始终回主端
7. **平台专项**
   - Android：`adb logcat -s Capacitor` 与 WebView 控制台应出现 `[shell-core] v0.2.0 ready (capacitor)`；若是 `(web)` 则未注入
   - iOS：Safari Web Inspector 看同一行日志；推送还需 APNs 证书与 Capability
   - 推送：Android 需要 `google-services.json`，iOS 需要 Push Notifications capability；缺配置时 `push.token` 为空/报错，不属于壳缺陷

### 6.4 结果记录模板

| 检查项 | portal | launcher（业务页） | 结论 |
|---|---|---|---|
| `Shell.env` | `capacitor` | ____ | 必须为 `capacitor` 才能用原生 |
| `Shell.platform` | `android/ios` | ____ | — |
| `capabilities.push` | `✓` | ____ | `web`/`─` 即不可用 |
| `push.request` | `ok` | ____ | `E_UNSUPPORTED` 即无原生 |
| `push.token` | 非空 | ____ | 空需查平台配置 |
| `share` | 原生面板 | ____ | — |
| `location` | 系统授权 | ____ | `E_DENIED` 查权限 |
| `statusBar` | 生效 | ____ | — |
| 重启记忆 | 不适用 | 通过/失败 | launcher 专项 |
| 返回选择页 | 不适用 | 通过/失败 | 依赖历史栈 |

### 6.5 判定与处置

- **portal 全部通过**：正式业务用 portal，多端切换交给主端门户页。
- **launcher 业务页 `env === capacitor`**：可以继续用原生能力；仍需把上表跑完，避免“能注入但插件未装”的假阳性。
- **launcher 业务页 `env === web`**（常见）：
  1. 业务页若只做 Web 功能（表单、列表、离线缓存走店根），launcher 可继续用；
  2. 业务页需要推送/相机/生物识别/状态栏 → **改用 portal**；
  3. 不要试图把原生调用放在选择页里“代劳”，业务页拿不到返回值，也不符合契约；
  4. 若必须 launcher + 原生，需要自定义 Capacitor 插件或改为本地托管业务页（超出 v0.3.1 范围，单独立项）。
- 验证未通过前，不要把 launcher 包发给门店或客户。

### 6.6 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `Shell is not defined` | 桥 404 / CSP / 加载顺序 | 确认 `/shell/acme-shell.js` 可 200，且先于业务脚本 |
| 业务页 `env=web`，但 `window.Capacitor` 存在 | 页面被远程加载，运行时未注入 | 按 6.5 改用 portal |
| `push.token` 为空 | 缺 `google-services.json` / APNs | 补平台配置后重装 |
| 选择页不出现 | 仍旧是 portal 配置 | 检查 `uendos.config.json` 的 `launchMode` 与 `capacitor.config.json` 是否还有 `server.url` |
| 记住端失效 | `endKey` 不一致 / 存储被清 | 对比配置 `endKey` 与页面写键；清理应用数据后重试 |
| 返回键直接退出 | 远程页无历史栈 | 属预期；需要“回选择页”时用 `?picker=1`（仅本机页可达） |

---

## 7. 打包、签名与发布

```bash
# Debug APK（首次自动补依赖与平台工程）
uendos pack --target app

# Release APK（密码只从环境变量读取，不落盘）
UENDOS_KEYSTORE=/abs/release.keystore \
UENDOS_KEYSTORE_PASSWORD='***' \
UENDOS_KEY_ALIAS=release \
UENDOS_KEY_PASSWORD='***' \
uendos pack --target app --release
# → android/app/build/outputs/apk/release/app-release.apk

# iOS（macOS）
uendos pack --target ios --release
# → build/App.xcarchive，再用 Xcode Organizer 导出 IPA

# PC
uendos pack --target pc
```

发布到应用中心（与 `apps.json` 清单配套）：

```bash
uendos publish \
  --file ./app-release.apk \
  --item acme-app-android \
  --manifest ./apps.json \
  --download-dir ./download/latest \
  --url /download/latest/acme-app-0.1.0.apk \
  --status beta
```

`publish` 会计算 SHA-256/大小、复制文件、回写清单条目；`available` 不会被自动放开，需人工确认灰度。

---

## 8. 提交前检查清单

```bash
cd acme
uendos doctor --offline     # 配置、产物、target 文件、品牌资源
uendos doctor               # 额外探测端 URL 可达性
uendos sync --check         # 桥与配置一致
uendos conformance          # 39/39
```

- [ ] 业务页已引入 `shell/<brand>-shell.js`
- [ ] `launcher` 已按第 6 节完成真机记录；未通过不用原生能力
- [ ] `assets/icon.png` 已替换为最终品牌图（`uendos assets --force` 后 `npm run assets`）
- [ ] 签名密码只在 CI Secret/本地环境变量中出现
- [ ] `packageId` 与商店/推送平台登记一致
- [ ] 清单状态先 `beta`，灰度验证后再放开

CI 可用最小步骤（SDK 冒烟）：

```bash
cd sdk && npm ci && npm test
CLI="$(pwd)/packages/cli/bin/uendos.mjs"
node "$CLI" init ci-smoke --brand ci-smoke \
  --ends "hp:个人端:https://example.com/" --targets app --dir /tmp/ci-smoke
cd /tmp/ci-smoke
node "$CLI" doctor --offline && node "$CLI" conformance
```

---

## 9. FAQ

**Q：`launcher` 能不能既记住端，又用推送？**
A：先按第 6 节验证业务页 `env`。若为 `web`，v0.3.1 不支持；用 `portal`，把多端入口做成主端门户页。

**Q：`portal` 下用户怎么换端？**
A：由主端门户页调用 `Shell.call('core.switchEnd', { id })`，壳会写入 `endKey` 并跳转；重启仍回主端是预期行为。

**Q：`allowNavigation` 为什么自动生成？**
A：远程端必须列入白名单，否则 WebView 可能把跳转交给系统浏览器。端 host 变化后重新 `uendos sync` 或重新 `init`。

**Q：图标被覆盖了？**
A：`pack` 只在首次（`android/.uendos-assets` 不存在时）展开图标；之后不会被覆盖。要重新生成：`uendos assets --force && npm run assets`。

**Q：能不能直接上架应用商店？**
A：Debug 包只能内测。公开上架还需要 release 签名、图标/截图、隐私声明；远程 H5 壳在 App Store / Google Play 存在“最低功能”审核风险，建议企业分发或补充原生能力。

---

## 10. 参考

- SDK 使用说明：[`sdk/README.md`](../sdk/README.md)
- 端壳契约：[`docs/shell-contract.md`](./shell-contract.md)
- 运行时唯一真源：`shell-core/src/core.js`
- 下载：[uendos-sdk-v0.3.1](https://github.com/Yorkzhao8888/Trae-RealEnds/releases/tag/uendos-sdk-v0.3.1)

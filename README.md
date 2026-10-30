# Trae-RealEnds · 真实端壳收集仓（Cajob / 知味工场 ZiwayOS / XSO / 捷才工友 Jechan）

收集「真实端 H5 根」之上所有端的薄壳与适配层。**壳不做业务**，只承载 H5 根 + 各端原生能力适配；业务全部在 H5 侧（H5 根 + 多端薄壳统一架构）。

当前覆盖四个品牌：

- **Cajob**（`https://cajob.cewaysoft.com/`，2026-10-30 起从已停用的 `h5.cewaycloud.com` 迁移）
- **知味工场 ZiwayOS**（`https://ziway-hp.ziway.cewaycloud.com/shop`）
- **XSO 智慧企业**（`https://xso.cewaysoft.com/`，企业工作台）
- **捷才工友 Jechan**（`https://hp.jechan.cewaysoft.com/`，挂出技能 · 活来找你）

## 目录

| 目录 | 端 | 技术栈 | 状态 |
|---|---|---|---|
| `cajob-pc-shell/` | PC（macOS/Windows） | Electron 33 | **v0.2.2**（体验层：窗口记忆/主题/下载进度/崩溃重载；自动更新已接入；签名公证待证书） |
| `cajob-app-shell/` | iOS / Android | Capacitor 6（11 插件） | 壳封装收口（桥/兜底/权限/隐私声明齐备）；Android 由 CI 产 Debug APK，iOS 真机包待开发者账号 |
| `cajob-wechat-adapter/` | 微信内置浏览器 | JSSDK（分享/扫码/支付） | 适配层就绪 |
| `cajob-iot-spec/` | IoT 设备 | 设备令牌 API 规范 | 规范定稿 |
| `cajob-watch-spec/` | 手表 Widget | WidgetKit 设计 | 设计定稿 |
| `ziway-app-shell/` | iOS / Android | Capacitor 6 | **v0.1.0** 壳工程就绪（`com.cewaycloud.ziwayos`，图标/启动图/桥/推送渠道） |
| `ziway-mp-shell/` | 微信小程序 | 原生小程序 + `web-view` | **v0.1.0** 单页壳；AppID 为 `touristappid` 占位，业务域名校验待配置 |
| `ziway-pc-shell/` | PC（macOS/Windows） | Electron 33 | **v0.1.0** 同一套代码出 Windows/macOS；更新源 `download/latest/` 待部署 |
| `xso-app-shell/` | iOS / Android | Capacitor 6 | **v0.1.0** 壳工程就绪（`com.cewaycloud.xso`，深底 `#0E1218` + 蓝标 `#1F6FEB`） |
| `xso-pc-shell/` | PC（macOS/Windows） | Electron 33 | **v0.1.0** 一套代码出 Windows/macOS；更新源 `download/latest/` 待部署 |
| `jechan-app-shell/` | iOS / Android | Capacitor 6 | **v0.1.0** 壳就绪（`com.cewaycloud.jechan`，蓝渐变 `#1F6FEB→#0B3F9E`） |
| `jechan-mp-shell/` | 微信小程序 | 原生小程序 + `web-view` | **v0.1.0** 单页壳；AppID 占位，业务域名待配置 |
| `jechan-pc-shell/` | PC（macOS/Windows） | Electron 33 | **v0.1.0** 一套代码出 Windows/macOS；更新源待部署 |
| `btos-app-store/` | 分发入口（H5） | 纯静态 + `data/apps.json` | **M0** 目录/清单/校验和/筛选；入口 `h5.cewaycloud.com`（DNS 在、证书待重签） |
| `docs/` | 跨端契约 | Markdown | `shell-contract.md` v0.2.0（能力矩阵/握手/事件/降级/离线/店根/安全/自检） |
| `shell-core/` | 共享壳运行时 | 单文件 JS（无构建依赖） | **v0.2.0** 四品牌桥由同一份 `core.js` 生成（`window.Shell` + 品牌别名），含真机自检页 |
| `edge-store/` | 店根（门店边缘服务） | Node 24 + 内置 SQLite，零依赖 | **P1** 原子扣减/租约/幂等重放/快照增量 + UDP 局域网发现；7 项测试通过 |

## 关键口径

1. **分发红线**：终端用户下载分发一律走已备案国内渠道 `https://cajob.cewaysoft.com/download/latest/`（稳定文件名，不带版本号）；`btos-app-store/` 只做**索引与校验**（版本/包名/SHA-256），安装包仍在各品牌 `/download/<brand>/<version>/`；本仓只做**源码协作**，不承担用户下载分发。
2. **PC 壳自动更新**：`electron-updater` generic 源指向上述 `/download/latest/`；**发布时 `latest-mac.yml` / `latest.yml` 必须与五产物同版本上传**，缺 yml = updater 静默 404、永不升级。发布用 `cajob-pc-shell/scripts/release.sh`（构建→上传→字节校验）。
3. **签名**：mac 需有效 Developer ID + 公证凭据，win 需 Authenticode——`release.sh` 凭据齐备自动启用，缺失降级未签名构建（仅内测）。
4. **会话/鉴权**：壳内 OAuth 链路跳转 `oas.cewaysoft.com`（ALLOWED_HOSTS 白名单）；多域会话依赖 `xoas_session` + `oas_session` 成对有效。

## 各壳详细说明

- PC 壳：见 `cajob-pc-shell/BRIEF.md`（v0.2.2 变更、验证边界、上线硬性要求、更新可观测性/回滚/兼容矩阵/会话验收）
- 移动壳：见 `cajob-app-shell/`（Capacitor 工程与插件清单）
- 微信/IoT/手表：见各自目录 README
- 知味工场三端：见 `ziway-app-shell/`、`ziway-mp-shell/`、`ziway-pc-shell/` 各自 README

## 版本记录

- 2026-10-20：建仓。导入 PC 壳 v0.2.0、移动壳、微信适配、IoT/手表规范。
- 2026-10-21：壳封装收口。修 CI 构建链；移动壳改用 `server.errorPath` 兜底、补齐原生桥运行时与权限/隐私声明；PC 壳发布脚本改为双架构构建 + 缺失产物硬失败；离线页输入转义。
- 2026-10-30：新增「知味工场 ZiwayOS」生态三端（`ziway-app-shell` / `ziway-mp-shell` / `ziway-pc-shell`），统一包名 `com.cewaycloud.ziwayos` 与品牌色 `#F97316`。
- 2026-10-30：Cajob 四端入口迁移到新根 `https://cajob.cewaysoft.com/`（旧根 `h5.cewaycloud.com` 已停用），OAS 同步为 `oas.cewaysoft.com`，白名单与更新源一并更新；小程序业务域名与校验文件需按新域重新配置。
- 2026-10-30：新增「XSO 智慧企业」两端（`xso-app-shell` / `xso-pc-shell`），包名 `com.cewaycloud.xso`，深底 `#0E1218` + 蓝标 `#1F6FEB`。
- 2026-10-30：新增「捷才工友 Jechan」三端（`jechan-app-shell` / `jechan-mp-shell` / `jechan-pc-shell`），包名 `com.cewaycloud.jechan`，蓝渐变 `#1F6FEB→#0B3F9E`，入口 `hp.jechan.cewaysoft.com`。
- 2026-10-30：知味工场与捷才工友补齐**四端**（个人 hp / 客户 cp / 企业 ep / 生态 sp）：App 改为本地「选择身份」页 + `allowNavigation` 放行四域，PC 加「身份」菜单与首启选择，小程序改为选择页 + `pages/web` 承载；桥新增 `ends` / `currentEnd` / `switchEnd`。
- 2026-10-30：抽取 `shell-core` v0.2.0 —— 四品牌桥改为同一份 `core.js` + 品牌配置生成（`window.Shell` 统一入口，品牌别名兼容），能力矩阵/事件名/错误码集中定义；新增真机自检页 `selftest.html` 与 `build.mjs --check` 一致性校验。
- 2026-10-30：`shell-core` 第二刀——桌面 preload 由模板生成（`ShellDesktop` 6 个最小能力）、小程序承载页统一附加 `shell=mp&brand=&v=`、新增 P0 离线队列（幂等键 + 顺序重放 + 4xx 出队）。
- 2026-10-30：新增 `edge-store` 店根 P1 —— 零依赖 Node 服务（内置 SQLite）：租约、单事务原子扣减、幂等重放、快照增量、UDP 广播发现；7 项测试覆盖整批回滚与超卖拒绝。

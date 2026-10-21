# Trae-RealEnds · Cajob 真实端壳收集仓

收集 Cajob「真实端 H5 根」（`https://h5.cewaycloud.com/`）之上所有端的薄壳与适配层。**壳不做业务**，只承载 H5 根 + 各端原生能力适配；业务全部在 H5 侧（H5 根 + 多端薄壳统一架构）。

## 目录

| 目录 | 端 | 技术栈 | 状态 |
|---|---|---|---|
| `cajob-pc-shell/` | PC（macOS/Windows） | Electron 33 | **v0.2.1**（Phase 3 自动更新已接入；发布脚本双架构 + 缺失产物硬失败；签名公证待证书） |
| `cajob-app-shell/` | iOS / Android | Capacitor 6（11 插件） | 壳封装收口（桥/兜底/权限/隐私声明齐备）；Android 由 CI 产 Debug APK，iOS 真机包待开发者账号 |
| `cajob-wechat-adapter/` | 微信内置浏览器 | JSSDK（分享/扫码/支付） | 适配层就绪 |
| `cajob-iot-spec/` | IoT 设备 | 设备令牌 API 规范 | 规范定稿 |
| `cajob-watch-spec/` | 手表 Widget | WidgetKit 设计 | 设计定稿 |

## 关键口径

1. **分发红线**：终端用户下载分发一律走已备案国内渠道 `https://h5.cewaycloud.com/download/latest/`（稳定文件名，不带版本号）；本仓只做**源码协作**，不承担用户下载分发。
2. **PC 壳自动更新**：`electron-updater` generic 源指向上述 `/download/latest/`；**发布时 `latest-mac.yml` / `latest.yml` 必须与五产物同版本上传**，缺 yml = updater 静默 404、永不升级。发布用 `cajob-pc-shell/scripts/release.sh`（构建→上传→字节校验）。
3. **签名**：mac 需有效 Developer ID + 公证凭据，win 需 Authenticode——`release.sh` 凭据齐备自动启用，缺失降级未签名构建（仅内测）。
4. **会话/鉴权**：壳内 OAuth 链路跳转 `oas.cewaycloud.com`（ALLOWED_HOSTS 白名单）；多域会话依赖 `xoas_session` + `oas_session` 成对有效。

## 各壳详细说明

- PC 壳：见 `cajob-pc-shell/BRIEF.md`（v0.2.1 变更、验证边界、上线硬性要求、更新可观测性/回滚/兼容矩阵/会话验收）
- 移动壳：见 `cajob-app-shell/`（Capacitor 工程与插件清单）
- 微信/IoT/手表：见各自目录 README

## 版本记录

- 2026-10-20：建仓。导入 PC 壳 v0.2.0、移动壳、微信适配、IoT/手表规范。
- 2026-10-21：壳封装收口。修 CI 构建链；移动壳改用 `server.errorPath` 兜底、补齐原生桥运行时与权限/隐私声明；PC 壳发布脚本改为双架构构建 + 缺失产物硬失败；离线页输入转义。

# Trae-RealEnds · Cajob 真实端壳收集仓

收集 Cajob「真实端 H5 根」（`https://h5.cewaycloud.com/`）之上所有端的薄壳与适配层。**壳不做业务**，只承载 H5 根 + 各端原生能力适配；业务全部在 H5 侧（H5 根 + 多端薄壳统一架构）。

## 目录

| 目录 | 端 | 技术栈 | 状态 |
|---|---|---|---|
| `cajob-pc-shell/` | PC（macOS/Windows） | Electron 33 | **v0.2.0**（Phase 3 自动更新已接入；签名公证待证书） |
| `cajob-app-shell/` | iOS / Android | Capacitor 6（11 插件） | 壳工程就绪；iOS 真机包待开发者账号，Android 可直接出 APK |
| `cajob-wechat-adapter/` | 微信内置浏览器 | JSSDK（分享/扫码/支付） | 适配层就绪 |
| `cajob-iot-spec/` | IoT 设备 | 设备令牌 API 规范 | 规范定稿 |
| `cajob-watch-spec/` | 手表 Widget | WidgetKit 设计 | 设计定稿 |

## 关键口径

1. **分发红线**：终端用户下载分发一律走已备案国内渠道 `https://h5.cewaycloud.com/download/latest/`（稳定文件名，不带版本号）；本仓只做**源码协作**，不承担用户下载分发。
2. **PC 壳自动更新**：`electron-updater` generic 源指向上述 `/download/latest/`；**发布时 `latest-mac.yml` / `latest.yml` 必须与五产物同版本上传**，缺 yml = updater 静默 404、永不升级。发布用 `cajob-pc-shell/scripts/release.sh`（构建→上传→字节校验）。
3. **签名**：mac 需有效 Developer ID + 公证凭据，win 需 Authenticode——`release.sh` 凭据齐备自动启用，缺失降级未签名构建（仅内测）。
4. **会话/鉴权**：壳内 OAuth 链路跳转 `oas.cewaycloud.com`（ALLOWED_HOSTS 白名单）；多域会话依赖 `xoas_session` + `oas_session` 成对有效。

## 各壳详细说明

- PC 壳：见 `cajob-pc-shell/BRIEF.md`（v0.2.0 变更、构建验证记录、上线硬性要求）
- 移动壳：见 `cajob-app-shell/`（Capacitor 工程与插件清单）
- 微信/IoT/手表：见各自目录 README

## 版本记录

- 2026-10-20：建仓。导入 PC 壳 v0.2.0、移动壳、微信适配、IoT/手表规范。

# 捷才工友 PC 壳（jechan-pc-shell）

Electron 薄壳，**Windows 与 macOS 共用一套代码**，加载同一个线上 H5 根：

```
https://hp.jechan.cewaysoft.com
```

| 项 | 值 |
|---|---|
| appId | `com.cewaycloud.jechan` |
| productName | 捷才工友 |
| 版本 | 0.1.0 |
| 产物名 | `JECHAN-win-x64.*` / `JECHAN-Setup.exe` / `JECHAN-mac-{arm64,x64}.*` |
| 品牌色 | `#1F6FEB`（窗口底色、离线兜底页主按钮） |
| 更新源 | `https://hp.jechan.cewaysoft.com/download/latest/`（需部署方提供该目录） |

## 已具备的桌面能力

窗口位置/尺寸/最大化/缩放记忆（副屏拔出自动回退）、首帧 `ready-to-show`（不白闪）、
系统深浅色跟随、下载任务栏进度、渲染崩溃自动恢复一次、跨平台快捷键
（`Ctrl±0` / `F11` / `F5` / `Alt+←→` / 鼠标侧键）、macOS 基础菜单与「检查更新」、
自动更新（generic 源，仅打包态启用）、单实例锁、外部链接交系统浏览器。

> 刻意未做：隐藏标题栏（会压住 H5 页头）、托盘常驻、自定义标题栏。

## 构建

```bash
npm ci
npm start            # 本地调试（加载线上 H5）

npm run dist:win     # Windows x64：nsis 安装包 + zip
npm run dist:mac     # macOS arm64 + x64：dmg + zip（需在 macOS 上执行）
```

产物输出到 `dist-release/`。**跨平台构建限制**：mac 产物必须在 macOS 上出；
Windows 产物可在 macOS/Linux 出（需 wine），建议在 Windows 上出以获得正确签名。

## 签名与公证

| 平台 | 环境变量 | 说明 |
|---|---|---|
| macOS 签名 | `CSC_LINK` / `CSC_KEY_PASSWORD` | Developer ID Application 证书（.p12） |
| macOS 公证 | `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | 三者齐备时 `release.sh` 自动加 `-c.mac.notarize=true` |
| Windows | `WIN_CSC_LINK` / `WIN_CSC_PASSWORD` | Authenticode 证书，缺省为未签名安装包（会被 SmartScreen 拦） |

`build/entitlements.mac.plist` 已备（hardened runtime + JIT + 网络）。

## 发布

```bash
./scripts/release.sh                       # 构建 mac + win，上传并校验字节
SKIP_WIN=1 ./scripts/release.sh            # 只出 mac
SKIP_UPLOAD=1 ./scripts/release.sh         # 只构建不上传
REMOTE=user@host DEST_DIR=/opt/jechan/download/latest ./scripts/release.sh
```

脚本会：清空 `dist-release/` → 构建 → **缺产物直接失败**（不静默跳过）→
rsync 到远端 → 用 `Content-Length` 与本地逐文件比对，全部 MATCH 才退出 0。

## H5 侧的桥

`preload.js` 注入 `window.jechanOS`（与移动端同名）：

```js
if (window.jechanOS?.isDesktopShell) {
  console.log(window.jechanOS.platform, window.jechanOS.version); // 'win32' / 'darwin'
}
```

移动端壳用 `window.jechanOS.isMobileShell` 区分，H5 侧按这两个标记分流即可。

## 已知限制

- 自动更新依赖 `download/latest/` 下的 `latest.yml` / `latest-mac.yml` 与产物同名文件；
  未部署该目录时更新逻辑静默失败，不影响使用。
- 未签名/未公证的 mac 包首次打开需在「系统设置 → 隐私与安全性」放行。
- Linux 环境下未安装 Electron 依赖，因此本仓库只做了配置与语法校验，桌面产物需在目标机构建。

# Cajob PC 壳 v0.2.0 交接说明

> 2026-10-20 · 基于 0.1.0 快照升级 · 构建冒烟已验证

## 本次变更（对照 roadmap）

**Phase 3 自动更新（新增）**
- `electron-updater@^6.6.2`（dependencies，已确认打进 app.asar）
- `publish`: generic 源 → `https://h5.cewaycloud.com/download/latest/`
- 更新行为：仅打包态启用；启动 10s 后检查 + 每 30min 轮询；自动下载，完成后弹窗询问重启；**未签名期/网络异常时错误静默，不阻塞主流程**
- 菜单新增「检查更新…」

**Phase 1/4 补齐（此前快照缺失项）**
- P4-1 `isAllowed` 仅放行 `https:`
- P4-2 `did-fail-load` 内联离线兜底页（data: URL，零新文件，含「重新加载」）
- P4-4 发行版菜单收敛：非打包态才显示 reload/toggleDevTools
- P2-1 mac `hardenedRuntime` + `build/entitlements.mac.plist`
- P1-2 `artifactName` 稳定名：`Cajob-mac-arm64.dmg` / `Cajob-mac-x64.dmg` / `Cajob-Setup.exe` / `Cajob-mac-arm64.zip` / `Cajob-win-x64.zip`

**构建/发布脚本（重建）**
- `scripts/release.sh`：构建（凭据齐备自动开公证）→ 上传稳定名产物 + `latest-mac.yml`/`latest.yml` → 线上字节校验
- `SKIP_UPLOAD=1` 只构建；`SKIP_WIN=1` 只出 mac

## 构建验证记录（2026-10-20）

- `node --check main.js` 通过
- `npx electron-builder --mac zip` 冒烟通过：`Cajob-mac-arm64.zip`（96,289,880 bytes）
- `latest-mac.yml` 生成：version 0.2.0 · 稳定名 url · sha512 · size ✓
- app.asar 含 electron-updater（212 条目）✓

## 上线硬性要求（Phase 3 生效前提）

1. **`latest-mac.yml` 与 `latest.yml` 必须与五产物同版本同传 `/download/latest/`**——缺 yml 则 updater 404（静默，不报错但永不升级）
2. DMG 构建须在沙箱外执行（写 /Volumes）
3. Phase 2 签名仍阻塞于有效 Developer ID——构建机现有「深圳策维软件」证书不受信任（`CSSMERR_TP_NOT_TRUSTED`），到位后 release.sh 自动启用签名+公证，updater 端到端升级链路才能验收

## 文件清单

```
main.js                      # v0.2.0 主进程（含 updater/离线兜底/菜单收敛）
preload.js                   # 最小桥（未变更）
package.json                 # v0.2.0（publish/entitlements/artifactName/electron-updater）
package-lock.json
.gitignore
build/icon.png
build/entitlements.mac.plist # 新增
scripts/release.sh           # 新增
```

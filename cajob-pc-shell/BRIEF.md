# Cajob PC 壳 v0.2.2 交接说明

> 2026-10-21 · 基于 v0.2.1 快照 · v0.2.2 只改体验层（窗口/主题/进度/快捷键），不改业务行为
> 读者：接手构建 / 发布 / 上架的同学

## 0. 一句话状态

**代码可构建，发布链已收口；上线仍卡在 Developer ID 证书。**
v0.2.2 的体验改动只通过语法与配置校验，**未在本机运行 GUI**，行为需实机复核。

## 0.1 v0.2.2 本次新增（体验层）

| 项 | v0.2.1 | v0.2.2 |
|---|---|---|
| 窗口状态 | 每次 1280×840 | 记忆位置/尺寸/最大化/缩放，副屏拔出自动回退 |
| 首屏 | 直接显示，可能白闪 | `show:false` + `ready-to-show` |
| 主题 | 固定白底 | 跟随系统深浅色 |
| 下载 | 仅日志 | 任务栏进度 + 完成弹窗 |
| 更新 | 后台静默 | 后台静默 + 手动检查有明确反馈 + 下载进度 |
| 崩溃 | 白屏 | 自动重载一次，二次才提示 |
| Windows 快捷键 | 无（无菜单） | `Ctrl±0` / `F11` / `F5` / `Alt+←→` / 侧键 |
| Windows 通知归属 | electron.exe | `AppUserModelId` |
| macOS 关于面板 | 默认 | 应用名 / 版本 / 版权 |

> 刻意未做：隐藏标题栏（H5 页头会被红绿灯压住）、托盘常驻、自定义标题栏。

---

## 1. v0.2.1 变更

### 1.1 发布链

| 项 | v0.2.0 | v0.2.1 |
|---|---|---|
| mac 构建 | `--mac`（只出宿主架构） | `--mac --arm64 --x64`（显式双架构） |
| win 构建 | `--win` | `--win --x64` |
| 产物校验 | 缺失文件 `continue` 跳过，仍打印"全部 MATCH" | 缺失即 `exit 1`，不再假通过 |
| 产物名 | 依赖 `${os}` 宏推断 | mac/win 各自固定 `artifactName`，与脚本清单一一对应 |
| 构建前 | 不清目录 | 先 `rm -rf dist-release`，避免旧产物混入 |
| 发布动作 | 可能触发 electron-builder 上传 | 显式 `--publish never`（generic 源本身也不上传，见 §7） |

### 1.2 安全与健壮性

- 离线兜底页新增 `escapeHtml`：错误码/描述不再直接拼进 `data:` URL 页面
  （实测传入 `<script>` 被转义，`onclick` 属性完好）
- `did-fail-load` / `setWindowOpenHandler` 补 `mainWindow` 判空
- `isAllowed` 主机名统一小写后再比对

### 1.3 版本与文档

- `0.2.0 → 0.2.1`（`package.json` + `package-lock.json` 同步）
- 本文档 `electron-updater` 版本由 `^6.6.2` 更正为实际值 `^6.8.9`
- `.gitignore` 补 `dist-release/`（此前未忽略，96MB 产物可能误入库）

---

## 2. 历史变更（v0.2.0，保留备查）

**Phase 3 自动更新**
- `electron-updater@^6.8.9`（dependencies，已确认打进 app.asar）
- `publish`: generic 源 → `https://h5.cewaycloud.com/download/latest/`
- 行为：仅打包态启用；启动 10s 后首检 + 每 30min 轮询；自动下载，完成后弹窗询问重启；错误静默不阻塞
- 菜单新增「检查更新…」

**Phase 1/4 补齐**
- P4-1 `isAllowed` 仅放行 `https:`
- P4-2 `did-fail-load` 内联离线兜底页
- P4-4 发行版菜单收敛：非打包态才显示 reload / toggleDevTools
- P2-1 mac `hardenedRuntime` + `build/entitlements.mac.plist`
- P1-2 `artifactName` 稳定名

---

## 3. 产物与命名（权威清单）

`release.sh` 的 `EXPECTED` 必须与本表**逐项一致**，缺一项即失败退出。

| 产物 | 来源 target | 平台/架构 | 必需 |
|---|---|---|---|
| `Cajob-mac-arm64.dmg` | dmg | mac / arm64 | ✅ |
| `Cajob-mac-x64.dmg` | dmg | mac / x64 | ✅ |
| `Cajob-mac-arm64.zip` | zip | mac / arm64 | ✅ |
| `Cajob-mac-x64.zip` | zip | mac / x64 | ✅ |
| `Cajob-Setup.exe` | nsis | win / x64 | ✅（`SKIP_WIN=1` 时豁免） |
| `Cajob-win-x64.zip` | zip | win / x64 | ✅（同上） |
| `latest-mac.yml` | mac zip 元数据 | — | ✅ |
| `latest.yml` | nsis 元数据 | — | ✅（同上） |

说明两点：

1. **zip 是更新载体，dmg 是安装载体**。`latest-mac.yml` 只由 mac zip 生成，删掉 zip 就等于关掉自动更新。
2. `--publish never` 不会抑制 yml 生成：`createUpdateInfoTasks` 只依赖 `build.publish` 能否解析（已对照 `app-builder-lib@25.1.8` 源码确认），generic 的 `scheduleUpload` 本身直接 return。

---

## 4. 构建与校验记录

### 4.1 已执行

| 日期 | 项 | 结果 |
|---|---|---|
| 2026-10-20 | `node --check main.js` | 通过 |
| 2026-10-20 | `electron-builder --mac zip`（宿主架构） | `Cajob-mac-arm64.zip` 96,289,880 bytes |
| 2026-10-20 | `latest-mac.yml` | version 0.2.0 · 稳定名 url · sha512 · size |
| 2026-10-20 | app.asar 内容 | 含 electron-updater（212 条目） |
| 2026-10-21 | `node --check` / JSON / `bash -n` | 全部通过 |
| 2026-10-21 | 离线页注入测试 | `<script>` 被转义，属性未被破坏 |

### 4.2 未验证（v0.2.1 交付前必须补）

| 项 | 原因 |
|---|---|
| `--mac --arm64 --x64` 双架构同时构建 | 需 macOS 构建机 |
| DMG 产物 | 同上（且需 hdiutil 挂载权限） |
| Windows nsis + zip | 需 Windows 或 wine 环境 |
| 签名 / 公证 | 无有效 Developer ID |
| 自动更新端到端 | 依赖上一条 |

> 结论用法：**把 §4.2 全部转绿之前，v0.2.1 只能作为内测未签名包发布。**

---

## 5. 上线硬性要求

1. **元数据同版本同传**：`latest-mac.yml` / `latest.yml` 必须与六产物同版本一起上传 `/download/latest/`。
   缺 yml → updater 404，**静默、不报错、永不升级**。
2. **mac 必须签名+公证**：Phase 2 阻塞于有效 Developer ID。构建机现有「深圳策维软件」证书不受信任（`CSSMERR_TP_NOT_TRUSTED`），不可用于发行。
   排查：`security find-identity -v -p codesigning` 应能看到 `Developer ID Application: ...`。
3. **Windows 必须 Authenticode 签名**：未签名 exe 会触发 SmartScreen「未知发布者」拦截，安装转化率断崖。
   凭据：`WIN_CSC_LINK` / `WIN_CSC_PASSWORD`，`release.sh` 检测到即自动启用。
4. **DMG 必须在沙箱外构建**（写 `/Volumes`）。
5. **分发红线**：终端下载一律走已备案渠道 `https://h5.cewaycloud.com/download/latest/`，本仓只做源码协作。

---

## 6. 更新可观测性

### 6.1 现状（有盲区）

`main.js` 里 `autoUpdater.logger = console`，而**打包态没有控制台**，所以更新失败的信息全部丢失。
错误策略是「静默不阻塞主流程」，代价是：**线上"永不升级"这件事在产品侧完全不可见**。

### 6.2 三步判定法（线上排障用）

```bash
# 1. 线上元数据是否存在、版本是多少
curl -sI  https://h5.cewaycloud.com/download/latest/latest-mac.yml | head -1
curl -s   https://h5.cewaycloud.com/download/latest/latest-mac.yml | grep -m1 '^version:'

# 2. 元数据里指的文件是否真存在（404 是最常见的坑）
curl -s   https://h5.cewaycloud.com/download/latest/latest-mac.yml | grep -m1 '^path:'

# 3. 客户端版本（用户反馈时核对）
#    mac：应用 → 关于 Cajob
```

判定表：

| 现象 | 最可能原因 |
|---|---|
| yml 404 | 元数据没上传，或上传到了错误目录 |
| yml 版本 = 客户端版本 | 发版时忘记改 `version`，或产物未重新构建 |
| yml 版本新但 `path` 404 | 只传了 yml 没传对应 zip/exe |
| 全部正常但客户端不升级 | 签名不匹配（macOS 拒绝）、或客户端版本更高（不支持降级） |

### 6.3 待办（未实现）

- [ ] updater 日志落盘（`app.getPath('logs')`），便于用户回传
- [ ] 壳版本上报：请求头 `X-Cajob-Shell` 或 UA 后缀，服务端可统计存量版本分布

---

## 7. 回滚与灰度

### 7.1 通道事实

- 只有 **generic 单通道**（`/download/latest/`），electron-builder 不会上传（generic publisher 直接 return），发布靠 `release.sh` 的 `rsync`。
- **没有内建灰度**，也没有服务端版本闸门：一个坏版本对全量用户立即可见。

### 7.2 回滚步骤（必须同时回滚元数据）

1. 保留上一版的**六产物 + 两个 yml**（建议每次发版前把 `dist-release/` 整目录归档）。
2. 把上一版产物覆盖回 `/download/latest/`。
3. **`latest-mac.yml` / `latest.yml` 里的 `version` 必须是回退后的值**，否则客户端仍认为已是最新。
4. 走 `release.sh` 的 [4/4] 字节校验，确认线上 size 与本地一致。

**禁令**：只替换安装包而不同步 yml —— 结果是新用户装到旧版、老用户永远收不到通知，且线上状态自相矛盾。

### 7.3 灰度可行做法

| 手段 | 成本 | 适用 |
|---|---|---|
| 按平台分批（先 mac 后 win） | 低，改 `SKIP_WIN` | 小步验证 |
| 临时把 `publish.url` 指向 `/download/beta/` | 中，需重新构建 | 定向内测 |
| 服务端按版本号下发不同 yml | 高，需网关 | 真正灰度 |

⚠️ macOS 通常**不支持自动降级**（Squirrel.Mac 只升不降），回滚后旧版用户需手动重装。

---

## 8. 壳 - H5 兼容矩阵

### 8.1 契约

壳是纯容器：`loadURL('https://h5.cewaycloud.com/')`，业务、路由、SSR 全在 H5。
这意味着 **H5 发版即刻影响所有存量壳**，而壳只能靠应用商店更新——两端节奏天然不同步。

| H5 侧变更 | 对壳的影响 | 处置 |
|---|---|---|
| 新增页面 / 改样式 | 无 | H5 自行发布 |
| 新增 API | 无 | 同上 |
| 修改已有 API 契约 | **老壳直接报错**（页面在壳内，无法回退） | 服务端保留旧字段 ≥ 2 个壳版本 |
| 改登录/回跳路径 | 登录中断（白名单 = `h5` / `oas` + 任意 `*.cewaycloud.com`；换域或降为 http 即被外抛到系统浏览器） | 需壳发版或确认回跳仍在白名单内 |
| 新增原生能力依赖（相机/推送） | 老壳无对应权限，调用即失败 | 必须做能力检测，不可硬依赖 |
| 依赖微信 JSSDK | 壳内不可用 | 必须降级到 `cajobShell.share()` |

### 8.2 当前缺口

壳**没有版本上报**（`main.js` 未改 UA、未加请求头），服务端无法知道请求来自哪个壳版本。
在补上之前，"保留旧字段 2 个版本"只能靠人工约定，无法度量。

### 8.3 建议窗口

- 破坏性 H5 变更：服务端兼容 **≥ 2 个已发布壳版本**；
- 若必须立即破坏：先发壳（商店审核周期），壳内做版本闸门，再改 H5。

---

## 9. 会话链路验收

壳内登录走 `oas.cewaycloud.com`，会话依赖 `xoas_session` + `oas_session` **成对有效**。

### 9.1 验收步骤

| # | 操作 | 预期 |
|---|---|---|
| 1 | 冷启动 Cajob | 加载 `h5.cewaycloud.com`，无白屏 |
| 2 | 未登录访问需登录页 | 跳 `oas.cewaycloud.com/oauth/login?txn=...`，**不新开外部浏览器** |
| 3 | 完成登录 | 回跳 `h5.cewaycloud.com`，落地原目标页 |
| 4 | 完全退出应用后重启 | 仍为登录态（`persist:cajob` 分区持久化生效） |
| 5 | 主动退出登录 | 再访问受限页重新跳 oas |
| 6 | 域外链接（如 `https://github.com`） | 交给系统浏览器，壳内不导航 |

### 9.2 失败特征对照

| 现象 | 原因 |
|---|---|
| 登录页在系统浏览器打开 | `ALLOWED_HOSTS` 未含 oas 域，或协议不是 https |
| 登录成功但回跳后仍未登录 | 两枚 cookie 只到其一（域/路径/SameSite 不一致） |
| 重启掉登录 | 分区被改成非 `persist:`，或系统清理了 WebView 数据 |
| 回跳停在空白页 | `did-fail-load` 触发，检查是否被兜底页接管 |

---

## 10. 文件清单

```
main.js                      # 主进程（updater / 离线兜底 / 菜单收敛 / 导航白名单）
preload.js                   # 最小桥：暴露 window.cajobShell{ platform, isDesktopShell }
                             #   注意：与移动端同名不同实现，勿假设桌面端有 share()/getLocation()
package.json                 # v0.2.1（publish / entitlements / 固定 artifactName / 双架构脚本）
package-lock.json            # v0.2.1
.gitignore                   # 含 dist-release/
build/icon.png
build/entitlements.mac.plist
scripts/release.sh           # 构建 → 完整性硬校验 → 上传 → 字节校验
```

---

## 11. 待办与阻塞

**阻塞（他人依赖）**
- [ ] 有效 Developer ID 证书 → 解锁签名 + 公证 + 自动更新端到端
- [ ] Windows Authenticode 证书 → 解锁 SmartScreen 正常安装

**本仓待办**
- [ ] 在 macOS 构建机跑通 `--mac --arm64 --x64` 与 DMG
- [ ] 在 Windows/wine 跑通 nsis + zip
- [ ] updater 日志落盘
- [ ] 壳版本上报（UA / 请求头）
- [ ] 发版前归档上一版六产物 + 两 yml（回滚前提）

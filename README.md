# Trae-RealEnds · 真实端壳收集仓（Cajob / 知味工场 ZiwayOS / XSO / 捷才工友 Jechan）

收集「真实端 H5 根」之上所有端的薄壳与适配层。**壳不做业务**，只承载 H5 根 + 各端原生能力适配；业务全部在 H5 侧（H5 根 + 多端薄壳统一架构）。

**新同学先看 [STATUS.md](STATUS.md)**：一页说明三层架构、各模块验证程度、线上地址、接口清单、本地跑法与当前卡点。

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
| `btos-app-store/` | 分发入口（H5） | 纯静态 + `data/apps.json` | **M0 已上线 + M1/M2 页面就绪**：目录/清单/筛选、通道（stable/beta）、下载计数、灰度配置、运营台；入口 `https://cajob.cewaysoft.com/store/`（复用现有证书，零新增） |
| `docs/` | 跨端契约 | Markdown | `shell-contract.md` v0.2.0（能力矩阵/握手/事件/降级/离线/店根/安全/自检） |
| `shell-core/` | 共享壳运行时 | 单文件 JS（无构建依赖） | **v0.2.0** 四品牌桥由同一份 `core.js` 生成（`window.Shell` + 品牌别名），含真机自检页 |
| `edge-store/` | 店根（门店边缘服务） | Node 24 + 内置 SQLite，零依赖 | **P2** 原子扣减/租约/幂等重放/快照增量/回传游标/冲突分级/定时退避回传/下行商品读模型/冲突复核页 + UDP 发现；24 项测试通过 |
| `cloud-root/` | 云根参考实现（联调/契约样板） | Node 24 + 内置 SQLite，零依赖 | **v0.1.2** 上行幂等接收/冲突判定/下行商品读模型 + 商店 M1 授权（租户/座位/门店配额/过期）+ M2 下载统计与百分比灰度；与店根端到端打通，14 项测试通过。**已在 47 机常驻**服务 `/store/*`（systemd + Caddy `@storeapi`） |

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
- 2026-10-30：`edge-store` 升 P2 —— 云根 outbox 回传（409 停在冲突点、不跳过）、冲突分级（库存自动 / 资金人工）、`/edge/outbox` `/edge/sync` `/edge/conflicts`；测试增至 11 项。`shell-core` 同步接入 `edge.*` 适配器（3s 超时、租约缓存、`E_STOCK` 映射、可回落离线队列）。
- 2026-10-30：`edge-store` 补「定时回传 + 指数退避」——配 `EDGE_CLOUD_URL` 即自动后台循环：成功归位 30s、失败 `30s→…→15min` 封顶、连续 3 次置 `cloudOffline`、409 冲突暂停等人裁决、4xx 直退最慢档；新增 `GET /edge/sync/status`、`POST /edge/sync/now`；测试增至 16 项。
- 2026-10-30：`edge-store` 补「下行读模型」——`POST /edge/pull` 按游标拉 `/cloud/catalog`，整批落库后才推进 `catalogSeq`（失败不跳批），重复下发幂等不刷事件，`on/off/deleted` 三态，变化写 `catalog.upsert`/`catalog.delete` 供端壳经 `/edge/snapshot` 增量获取；调度器每次 tick 先拉后传，下行失败不污染上行退避；测试增至 23 项。
- 2026-10-30：`edge-store` 补「冲突复核运营页」——`GET /edge/ui/conflicts` 免构建静态页，填 `EDGE_TOKEN` 后 4s 自动刷新，逐条 accept/reject/auto；资金类自动放行按钮直接禁用（服务端再拒一次）；页面免鉴权、数据接口仍要 token；测试增至 24 项。
- 2026-10-30：新增 `cloud-root` 云根参考实现 —— 零依赖 Node 服务：`POST /cloud/events` 幂等接收（`(store,seq)` 主键）、冲突停在冲突点、库存不足/对账不符返回 409；`GET /cloud/catalog?since=` 下行商品增量；管理接口写商品与库存。与店根端到端打通（上行回传 + 下行落库 + 冲突裁决），7 项测试通过。
- 2026-10-30：商店 M1 解除证书阻塞 —— 商店改挂 `cajob.cewaysoft.com/store/`（复用 47 边缘已有效证书，Caddy `handle_path` 一行接入），页面保持相对路径可任意子路径部署；`apps.json` 的 `store.entry` 从已停用的 `h5.cewaycloud.com` 修正为 `cajob.cewaysoft.com`。h5 独立域名的补证诊断与两条路径写入 `btos-app-store/README.md`。
- 2026-10-30：商店 M1 最小实现 —— `cloud-root` 新增 `/store/*`：许可总览、设备占座/退座（幂等）、门店注册/注销（配额）、管理建租户（`CLOUD_ADMIN_TOKEN`）；座位与门店以服务端计数硬约束（`409 seat_exhausted`/`store_quota`），过期即拒；身份复用 OAS，参考实现用 `dev:<tenantId>` 模拟。测试增至 12 项。
- 2026-10-30：商店 M1 前端 —— `btos-app-store/tenant.html`「我的许可」：令牌 + 接口地址查询 `/store/entitlements`，座位/门店配额进度条、有效期、品牌-端授权表；401/404/不可达三类错误态；商店顶栏加「我的许可」入口。纯展示，配额仍由服务端裁决。
- 2026-10-30：商店 M2 最小实现 —— 商店页加「通道」筛选（`status=beta` 即测试通道，稳定通道不可见），下载点击向 `POST /store/downloads` 计数（失败不阻塞下载）；`cloud-root` 新增下载计数与聚合（聚合需 `CLOUD_ADMIN_TOKEN`），未知通道归一 `stable`、缺 `itemId` 拒绝；回滚仍以清单为唯一真相。cloud-root 测试增至 13 项；按设备/租户的百分比灰度明确未做。
- 2026-10-30：商店 M2 百分比灰度 —— `PUT /store/rollouts/:itemId` 设 0..100，`POST /store/rollouts` 批量判定；`sha256(itemId|身份)` 前 8 位取模 100 稳定分桶，有租户令牌按租户、否则按设备，匿名且 <100% 一律 `no_identity`；商店页把 beta 条目交给云根判定，命中才在测试通道渲染。cloud-root 测试增至 14 项。
- 2026-10-30：商店 M2 运营台 —— `btos-app-store/ops.html`：管理令牌换 `GET /store/rollouts` + `GET /store/downloads`，表格内改比例即 `PUT`，可新增条目；令牌只存本机，写操作仍由服务端校验。浏览器验收：两条灰度、合计 2 次下载、改 40% 保存生效。
- 2026-10-30：商店 M0 上线 —— `https://cajob.cewaysoft.com/store/` 公网 200（`/store/`、`index.html`、`tenant.html`、`ops.html`、`data/apps.json` 全通），主站 `/` 回归 200。落点：47 边缘机 `i-uf6ctneanpjturpbp3j5`（cn-shanghai），静态文件 `/opt/baitos/caddy/data/store`，Caddy 容器内 `/data/store`，站点块加 `redir /store /store/ 308` + `handle_path /store/*`；配置备份 `/opt/baitos/caddy/Caddyfile.bak-store-20261030-172601`。注意：该 Caddyfile 是单文件 bind mount，宿主机改写会换 inode 导致容器仍读旧文件，需 `docker exec -i ... cat > /etc/caddy/Caddyfile` 就地写入再 reload。
- 2026-10-30：面向团队补齐说明 —— 新增 `STATUS.md`（三层架构、模块验证度、线上落点、接口清单、本地跑法、外部依赖、协作约定），README 顶部加导览；`cloud-root` 版本号对齐至 0.1.2（14 项测试）。
- 2026-10-30：商店 M1/M2 接口上线 —— 47 机新增 `cloud-root` systemd 常驻（Node 24.8.0 独立安装，宿主 Node 20 无 `node:sqlite`），监听 `172.18.0.1:7331`；Caddy 在静态 `handle_path /store/*` 之前加 `@storeapi` → `reverse_proxy`，页面同源无需配接口地址。公网验证：`/store/entitlements` 401→带 token 200、占座 1/20、退座归零、`/store/downloads` 公开计数 200、运营台 `rollouts`/`downloads` 均 200；演示租户 `t-demo` 已建。另加 `.github/workflows/tests.yml`：`edge-store` + `cloud-root` 在 Node 24 上跑测试，PR 必绿。

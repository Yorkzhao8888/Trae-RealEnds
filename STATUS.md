# 团队速览 · 真实端壳落地现状

> 一页看清：我们已经有什么、验证到什么程度、线上在哪、下一步卡在哪。
> 详细契约见 [docs/shell-contract.md](docs/shell-contract.md)，逐日变更见 [README.md](README.md#版本记录)。

## 1. 三层架构（当前口径）

```
端壳  shell-core（共享桥）+ 各品牌壳工程（App / 小程序 / PC）
        │  window.Shell 统一入口，品牌别名兼容
        ▼
店根  edge-store（门店边缘服务，Node 24 + 内置 SQLite）
        │  上行 POST /cloud/events      下行 GET /cloud/catalog?since=
        ▼
云根  cloud-root（参考实现，非生产）+ 商店 btos-app-store（分发与许可）
```

红线：**壳只决定怎么送、送多少、何时送**；送什么、算得对不对由店根 / 云根裁决。壳内不得判定优惠、改订单状态或金额。

## 2. 模块状态

| 模块 | 做到什么 | 验证 |
|---|---|---|
| `shell-core/` | 四品牌桥由同一份 `core.js` 生成（`window.Shell` + `ziwayOS/jechanOS/xsoOS/cajobOS` 别名）；能力矩阵、事件双写、`build.mjs --check` 一致性校验、真机自检页 | 构建校验通过 |
| `cajob-pc-shell/` | Electron 33 壳 v0.2.2：窗口记忆/主题/下载进度/崩溃重载；`electron-updater` 指向 `/download/latest/` | 打包脚本可用；签名公证待证书 |
| `cajob-app-shell/` | Capacitor 6，11 插件，桥/兜底页/权限/隐私声明齐备 | Android Debug APK 由 CI 产出；iOS 待开发者账号 |
| `ziway-* / jechan-* / xso-*` | 知味工场、捷才工友各四端（hp/cp/ep/sp），XSO 两端；四端身份选择页 + `allowNavigation` | 工程就绪；包名/品牌色已定 |
| `edge-store/` | 租约、单事务原子扣减、幂等重放、冲突分级（库存自动 / 资金人工）、定时退避回传、下行商品读模型、冲突复核页、UDP 发现 | **24 项测试全过** |
| `cloud-root/` | 上行幂等接收（`(store,seq)` 主键）、冲突停在冲突点、下行商品增量；商店 M1 许可（座位/门店配额、过期即拒）+ M2 下载统计与百分比灰度 | **14 项测试全过**；与店根端到端跑通 |
| `btos-app-store/` | 应用中心 M0 目录/清单 + M1「我的许可」+ M2 通道/下载计数/运营台 | **已上线**，公网 200 |

## 3. 线上

- 入口：**https://cajob.cewaysoft.com/store/**（M0 静态页已上线；主站 `/` 未受影响）
- 落点：ECS `i-uf6ctneanpjturpbp3j5`（`47.117.131.103`，cn-shanghai），TLS 由该机 Caddy 容器 `baitos-caddy` 终止
- 文件：宿主机 `/opt/baitos/caddy/data/store/` → 容器 `/data/store/`；**发布只需覆盖文件，无需 reload**
- 配置：`cajob.cewaysoft.com` 块内 `redir /store /store/ 308` + `handle_path /store/*`（静态页）
- API 路由：同一站点块内 `@storeapi` 匹配 `/store/entitlements`、`/activate`、`/deactivate`、`/stores`、`/downloads`、`/rollouts`、`/tenants/*`，`reverse_proxy 172.18.0.1:7331`，**位于静态 `handle_path` 之前**，页面无需配置接口地址（同源）
- 服务端：`cloud-root` 由 systemd 常驻（`cloud-root.service`），二进制 `/opt/node24/bin/node`（v24.8.0，宿主机自带 Node 20 不支持 `node:sqlite`，故独立安装），监听 `172.18.0.1:7331`，代码 `/opt/baitos/cloud-root`，DB `/opt/baitos/cloud-root/data/cloud.db`，密钥在 `/opt/baitos/cloud-root/cloud.env`（0600，不入库）
- 演示租户：`t-demo`（20 座 / 3 店 / ziway 四端 + cajob hp），许可页用 `Authorization: Bearer dev:t-demo` 可直接看到数据
- 下载目录：`/download/latest/` → 容器 `/data/download`（宿主 `/opt/baitos/caddy/data/download`），备份 `Caddyfile.bak-download-20261030-180929`；已放首个真实包 `cajob-app-0.2.2-debug.apk`（7,375,846 B，`SHA-256 1563db5e…169b`）+ `SHA256SUMS`
- 回滚：`cat /opt/baitos/caddy/Caddyfile.bak-store-20261030-172601 | docker exec -i baitos-caddy sh -c 'cat > /etc/caddy/Caddyfile'` 后 reload（API 接入前的备份是 `Caddyfile.bak-storeapi-20261030-175710`）
- 坑：`/etc/caddy/Caddyfile` 是单文件 bind mount，宿主机改写换 inode 容器读不到，必须就地写入
  （细节见 [btos-app-store/README.md](btos-app-store/README.md#上线状态2026-10-30)）

## 4. 接口一览

**店根 `edge-store`**（`Authorization: Bearer $EDGE_TOKEN`）

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/edge/stock/dec` `/edge/stock/inc` | 原子扣减 / 回补（租约 + 超卖拒绝） |
| GET | `/edge/snapshot` | 全量快照 + 版本号 |
| GET | `/edge/catalog` | 本地商品读模型 |
| POST | `/edge/pull` | 按游标拉云根商品增量 |
| POST | `/edge/sync/now` | 立即回传 |
| GET | `/edge/sync/status` | 退避状态 / `cloudOffline` |
| GET | `/edge/outbox` `/edge/conflicts` | 待回传事件 / 冲突列表 |
| GET | `/edge/ui/conflicts` | 冲突复核运营页（免鉴权，数据接口仍需 token） |

**云根 `cloud-root`**（`/cloud/*` 需 `CLOUD_TOKEN`）

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/cloud/events` | 上行幂等接收；冲突 409 停在该事件之前 |
| GET | `/cloud/catalog?since=` | 商品增量下发 |
| GET/PUT | `/cloud/admin/catalog` 等 | 管理写商品与库存 |

**商店 `cloud-root` `/store/*`**（`Bearer dev:<tenantId>` 模拟 OAS 身份）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/store/entitlements` | 座位/门店配额、品牌-端、有效期 |
| POST | `/store/activate` `/store/deactivate` | 设备占座/退座（幂等，超额 409） |
| POST | `/store/stores`，DELETE `/store/stores/:id` | 门店注册/注销（配额 409） |
| PUT | `/store/tenants/:id` | 管理建租户（`CLOUD_ADMIN_TOKEN`） |
| POST | `/store/downloads` | 下载计数（公开） |
| GET | `/store/downloads` | 下载聚合（需管理员 token） |
| PUT | `/store/rollouts/:itemId`，POST `/store/rollouts` | 设置 / 批量判定灰度 |

## 5. 本地跑法

```bash
# 店根：24 项测试
cd edge-store && npm test
node src/server.js                    # EDGE_TOKEN=dev EDGE_DB=/tmp/edge.db

# 云根：14 项测试（含与店根的端到端）
cd cloud-root && npm test
CLOUD_TOKEN=tk CLOUD_ADMIN_TOKEN=adm CLOUD_DB=/tmp/cloud.db node src/server.js

# 商店静态页（任意静态服务即可，页面全相对路径）
cd btos-app-store && python3 -m http.server 8099
```

## 6. 待办与外部依赖

| 事项 | 卡点 | 谁给 |
|---|---|---|
| OAS 真实身份接入 | 需 OAuth 客户端 ID、授权/回调地址、userinfo 或 introspect 端点；接入点集中在 `cloud-root/src/server.js` 的 `tenantOf()` | 平台方 |
| 商店 M1/M2 接口上线 | ~~需部署 `cloud-root` + 反代~~ → **已完成 2026-10-30**（systemd + Caddy `@storeapi`） | 已闭环 |
| 安装包分发 | cajob Android **Debug** 已以 `beta` 上线（灰度 100%，下载 200）；其余 18 条仍 `pending`；PC 更新源仍空——无签名包、无 `latest.yml` | 发行团队 |
| iOS / macOS 真机包 | 需 Apple 开发者账号与公证凭据 | 账号方 |
| h5.cewaycloud.com 独立域名 | 443 无证书，DNS/证书不在当前账号；已改用 cajob 子路径，仅作可选 | 边缘维护方 |

## 7. 协作约定

1. **契约先行**：改能力/事件/接口先改 `docs/shell-contract.md`（唯一真相），再改实现；契约版本语义化递增。
2. **测试门槛**：`edge-store`、`cloud-root` 改动后 `npm test` 必须全过，新增行为补用例。测试工作流 `.github/workflows/tests.yml`（Node 24）已就绪，但推送需 PAT 具备 `workflow` scope，落地后 PR 必须绿。
3. **提交**：`feat|fix|docs(scope): 中文简述`，一次提交一个主题；文档与代码同批提交。
4. **不落凭证**：仓库内不提交任何 token / AccessKey / 证书私钥；线上配置走环境变量。
5. **商店清单是唯一真相**：`btos-app-store/data/apps.json` 的 `status` 未置 `available` 时，页面按钮不可点，不允许前端自行放开。
6. **上线留痕**：每次线上变更同步更新本文件第 3 节与根 README 版本记录，并保留 Caddy 备份。

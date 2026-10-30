# 百泰OS 应用商店 · BTOS App Store（M0）

生态自有端的**分发与版本中心**，部署入口 `https://cajob.cewaysoft.com/store/`（复用已备案、证书有效的 cajob 域，不再依赖已停用的 `h5.cewaycloud.com`）。

## 定位（先说清，避免误解）

- 只分发**百泰生态自有端**：知味工场、捷才工友、XSO、Cajob 的 App / 小程序 / PC 客户端。
- **不是第三方应用商店**：不接受外部上架；iOS 安装一律经 App Store / TestFlight，小程序只在微信内跳转或扫码。
- 页面只做**索引与校验**：版本、包名、SHA-256、壳契约版本以 `data/apps.json` 为唯一真相，页面不做二次判断。
- “App Store” 为权利人标识，本站与 Apple Inc. 无关，页脚已声明。

## 目录

```
btos-app-store/
├── index.html          # 单页目录（无外部依赖，纯静态）
├── tenant.html         # 「我的许可」：查座位/门店配额与品牌授权（M1）
├── data/apps.json      # 清单（唯一真相）
└── README.md
```

## 清单结构（schemaVersion 1）

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "ISO 时间",
  "store": { "contractVersion": "0.2.0", ... },
  "brands": [{ "id": "ziway", "name": "知味工场", "accent": "#F97316", "ends": ["hp","cp","ep","sp"] }],
  "items": [{
    "id": "ziway-app-android",
    "brand": "ziway",
    "end": "hp",                    // hp / cp / ep / sp / org
    "platform": "android",          // android | ios | mp-weixin | win32 | darwin
    "platformLabel": "Android APK",
    "packageId": "com.cewaycloud.ziwayos",
    "version": "0.1.0",
    "contractVersion": "0.2.0",     // 对应 docs/shell-contract.md
    "size": null,                   // 字节数，未上架为 null
    "sha256": null,                 // 安装包校验和
    "url": null,                    // 直链；iOS/小程序留空
    "status": "pending",            // pending 待上架 | beta 测试 | available 可下载
    "notes": "四端选择页；待签名"
  }]
}
```

## 上架流程（发行团队）

1. 出包并签名（App / PC），小程序上传微信后台。
2. 计算校验和：`sha256sum app-release.apk`。
3. 放到下载目录：`/download/<brand>/<version>/<file>`（由站点托管）。
4. 改 `data/apps.json`：填 `version`、`size`、`sha256`、`url`、`status=available`、更新 `generatedAt`。
5. 提 PR 合并 → 静态页随部署刷新。

> 清单变更即发布。`status` 未填 `available` 时，页面按钮为「待上架」且不可点。

## 部署（推荐路径：挂到已有效的 cajob 域）

页面只用相对路径（`./data/apps.json`），可挂**任意子路径**，不需要独立域名，也不需要新证书。

前置事实：`cajob.cewaysoft.com` 的 TLS 由 `47.117.131.103` 边缘终止，证书有效；该站点的 Caddy 用 `tls internal` 回源，仅在 `remote_ip 47.117.131.103` 时可达。因此商店直接作为该站点的子路径即可：

```caddyfile
https://cajob.cewaysoft.com {
  tls internal
  @edge remote_ip 47.117.131.103
  # 商店：挂子路径，不与主站冲突
  handle_path /store/* {
    root * /srv/btos-app-store
    file_server
    header Cache-Control "public, max-age=60"
    header /data/apps.json "Cache-Control no-cache, max-age=0, must-revalidate"
  }
  # … 原有主站业务 handle 保持不变
}
```

`handle_path` 会剥掉 `/store` 前缀，页面里的 `./data/apps.json` 正好落到 `/srv/btos-app-store/data/apps.json`。

验证（在 ECS 上）：

```bash
curl -sI https://cajob.cewaysoft.com/store/            # 期望 200 + text/html
curl -s  https://cajob.cewaysoft.com/store/data/apps.json | head -c 120
```

安装包目录同域挂在 `/download/`，保证下载计数与清单同源。

## 如果坚持独立域名（h5.cewaycloud.com）

该域现状是**死结**，不是"补一张证书"那么简单：A 记录指向 `182.92.105.231`，80 返回 308，**443 握手失败（无可用证书）**；阿里云账号内既无该域 DNS 托管、也无任何证书。必须先判定 443 由谁应答：

```bash
dig +short h5.cewaycloud.com A
echo | openssl s_client -connect h5.cewaycloud.com:443 -servername h5.cewaycloud.com 2>&1 | head -20
curl -sI http://h5.cewaycloud.com | head -5
```

- 若 443 由 `47.117.131.103` 边缘应答（与 cajob 同一入口）→ 让边缘维护方把 `h5.cewaycloud.com` 加进该证书的 SAN（或单独签发），再按上面同一段 Caddy 挂站点。
- 若 443 落在 ECS 的 Caddy 且 80 可达公网 → 给 Caddy 加站点块，用 **HTTP-01** 自动签：

  ```caddyfile
  h5.cewaycloud.com {
    root * /srv/btos-app-store
    file_server
    encode gzip
  }
  # Caddy 默认自动 ACME；前提：80 不被边缘/防火墙拦截，且 308 重定向不能吞掉
  # /.well-known/acme-challenge/
  ```

- 若 80 被前置 308 吞掉或 DNS 不可写 → HTTP-01 与 DNS-01 都做不了，只能回到"边缘补证书"或继续用 cajob 子路径。

结论：**M1 不应被这张证书卡住**。商店先落 `cajob.cewaysoft.com/store/`，证书问题独立推进。

## M1 授权与租户（最小实现）

接口落在 `../cloud-root/`（参考实现），身份**不新建**，生产由 OAS（`oas_mother`）校验后下发租户 ID；参考实现用 `Authorization: Bearer dev:<tenantId>` 模拟。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/store/entitlements` | 许可总览：座位/门店配额、已授权品牌与端、有效期 |
| POST | `/store/activate` | `{deviceId, platform}` 设备占座；到上限 `409 seat_exhausted` |
| POST | `/store/deactivate` | `{deviceId}` 退座释放 |
| POST | `/store/stores` | `{storeId, name}` 注册门店；超配额 `409 store_quota` |
| DELETE | `/store/stores/:storeId` | 注销门店 |
| PUT | `/store/tenants/:id` | **管理**：建租户、配额、品牌授权（需 `CLOUD_ADMIN_TOKEN`） |

规则：

1. **占座幂等**：同一 `deviceId` 重复激活返回 `replayed:true`，不重复占位。
2. **配额硬约束**：座位与门店都以服务端计数为准，前端只展示；超额一律 `409`，不静默降级。
3. **过期即拒**：`expires` 到期后 `entitlements.expired=true`，激活与建店全部 `409 expired`。
4. **身份单一来源**：租户 ID 来自 OAS，不在本服务建账号、不存密码。

调用示例：

```bash
# 运营侧建租户（20 座、3 家门店、授权 ziway 四端）
curl -X PUT http://127.0.0.1:7331/store/tenants/t-ziway-cs1 \
  -H 'Authorization: Bearer <CLOUD_ADMIN_TOKEN>' -H 'content-type: application/json' \
  -d '{"name":"知味长沙一店","seats":20,"stores":3,"brands":[{"brand":"ziway","ends":["hp","cp","ep","sp"]}]}'

# 端侧查许可并激活
curl http://127.0.0.1:7331/store/entitlements -H 'Authorization: Bearer dev:t-ziway-cs1'
curl -X POST http://127.0.0.1:7331/store/activate \
  -H 'Authorization: Bearer dev:t-ziway-cs1' -H 'content-type: application/json' \
  -d '{"deviceId":"pos-001","platform":"android"}'
```

**落地待办**：OAS 侧提供 OAuth 客户端与 userinfo（或 introspect）端点；本服务把 `tenantOf()` 从 `dev:` 换成真实校验即可，其余逻辑不动。

### 前端：`tenant.html`（我的许可）

商店顶栏「我的许可」→ `./tenant.html`。纯静态、无依赖，只做**展示**，配额裁决全在服务端：

- 顶部两个输入：**租户令牌**（存 `localStorage` 的 `store:token`）、**接口地址**（`store:api`，留空即同源）。
- 点「查询许可」→ `GET {api}/store/entitlements` 带 `Authorization: Bearer <token>`，渲染座位/门店进度条、有效期、品牌-端授权表。
- 错误态区分：`401` 令牌无效、`404` 租户不存在、其他显示 `code`；接口不可达单独提示。
- 配额满时进度条转警示色；过期显示「已过期」pill。
- 接口地址留空要求页面与 `cloud-root` **同源**（例如由 Caddy/反向代理把 `/store/*` 与静态页挂到同一域）。跨域联调时填完整地址，服务端需放行 CORS。

本地联调：

```bash
# 1) 起云根（建租户见上一节 curl）
cd ../cloud-root && CLOUD_TOKEN=dev-token CLOUD_ADMIN_TOKEN=adm-token CLOUD_DB=/tmp/cloud.db npm start
# 2) 起静态页（同源代理 /store/* 到 7331，或直接把 tenant.html 与接口放同一域）
# 3) 打开 http://127.0.0.1:<静态端口>/tenant.html，令牌填 dev:<tenantId>
```

## M2 更新通道与下载统计（最小实现）

**通道**：不新增清单字段，直接复用 `status`——`beta` 即测试通道，其余（`pending` / `available`）归稳定通道。页面顶部「通道」切换稳定版 / 测试版，默认稳定版；`beta` 条目在稳定通道不可见。

**灰度（按租户 / 按设备）**：`beta` 条目能否在测试通道出现，由云根判定，不由页面猜测。

1. 运营设比例：`PUT /store/rollouts/:itemId`，`percent` 0..100（0 = 关，100 = 全量），越界夹紧。
2. 端侧批量问：`POST /store/rollouts`，带 `{itemIds[], deviceId}`；有租户令牌时按 **租户** 分桶（同租户各设备结果一致），没有才按 **设备**。
3. 分桶规则：`sha256(itemId|tenant:<id> 或 device:<id>)` 取前 8 位十六进制 → `% 100`；同一身份永远同一桶，比例调大只放不放回。
4. 匿名（无租户、无 `deviceId`）且比例 <100 时一律不命中，理由 `no_identity`——不拿 IP 猜身份。

页面首次访问生成 `store:device`（UUID）存 `localStorage`，只用于分桶；页面把 `beta` 条目 id 送去 `/store/rollouts`，命中才渲染。接口不可达时测试通道保持空。

| 方法 | 路径 | 作用 |
|---|---|---|
| PUT | `/store/rollouts/:itemId` | 设放量比例（需 `CLOUD_ADMIN_TOKEN`） |
| POST | `/store/rollouts` | 批量判定 `{itemIds[], deviceId}`，返回 `{bucket, eligible, reason}` |
| GET | `/store/rollouts` | 查看全部放量配置（需 `CLOUD_ADMIN_TOKEN`） |

**下载统计**：已上架条目点「下载」时向 `POST /store/downloads` 记一次——尽力而为，失败不影响下载；同源访问或把 `store:api` 指向云根。

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/store/downloads` | 计数 `{itemId, channel?, version?, deviceId?}`；无 `itemId` → `400 bad_item`；未知通道归一 `stable` |
| GET | `/store/downloads?itemId=` | 聚合 `{total, items:[{itemId, channel, count}]}`，需 `CLOUD_ADMIN_TOKEN` |

**回滚**：清单是唯一真相——把 `version` / `size` / `sha256` / `url` 改回上一版并更新 `generatedAt` 即回滚。macOS 与 iOS 不支持自动降级，旧版用户需手动重装（细节见 `../cajob-pc-shell/BRIEF.md` §7）。

**未做**（明确边界）：下载去重、灰度放量自动化（按留存/崩溃率自动收缩）、CDN 访问日志对账、统计看板页。

## 与壳的闭环

- PC 壳自动更新源 → 本站 `/download/latest/`。
- App 壳启动时读本站清单比对 `version`，有新版则跳商店页（iOS 跳 App Store/TestFlight）。
- 小程序不受本站控制，只登记 AppID 与二维码。
- 每个条目声明 `contractVersion`，与 [../docs/shell-contract.md](../docs/shell-contract.md) 对齐；契约升级时清单同步升级。

## 分期

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 静态目录 + 清单 + 校验和 + 筛选 | 已完成 |
| M1 | 授权与租户（座位数、许可下发、门店数） | 最小实现（`cloud-root` + 商店「我的许可」页，待接 OAS 身份） |
| M2 | 更新通道 stable/beta、灰度比例、回滚、下载统计 | 最小实现（通道筛选 + 租户/设备分桶灰度 + 下载计数） |

M1 起才需要登录，且必须共享 `oas_mother` 身份，不新建账号体系。

## 合规要点

- iOS：App Store / TestFlight / ABM 企业分发，站内不提供 ipa。
- Android：正式签名；如需国内商店上架另行提审。
- 小程序：不允许本站跳转安装，只能扫码或微信内跳转。
- 备案与隐私：上架条目需提供隐私政策 URL。

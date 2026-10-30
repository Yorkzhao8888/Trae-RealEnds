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

## 与壳的闭环

- PC 壳自动更新源 → 本站 `/download/latest/`。
- App 壳启动时读本站清单比对 `version`，有新版则跳商店页（iOS 跳 App Store/TestFlight）。
- 小程序不受本站控制，只登记 AppID 与二维码。
- 每个条目声明 `contractVersion`，与 [../docs/shell-contract.md](../docs/shell-contract.md) 对齐；契约升级时清单同步升级。

## 分期

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 静态目录 + 清单 + 校验和 + 筛选 | 已完成 |
| M1 | 授权与租户（座位数、许可下发、门店数） | 未启动 |
| M2 | 更新通道 stable/beta、灰度比例、回滚、下载统计 | 未启动 |

M1 起才需要登录，且必须共享 `oas_mother` 身份，不新建账号体系。

## 合规要点

- iOS：App Store / TestFlight / ABM 企业分发，站内不提供 ipa。
- Android：正式签名；如需国内商店上架另行提审。
- 小程序：不允许本站跳转安装，只能扫码或微信内跳转。
- 备案与隐私：上架条目需提供隐私政策 URL。

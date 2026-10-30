# 百泰OS 应用商店 · BTOS App Store（M0）

生态自有端的**分发与版本中心**，部署入口 `https://h5.cewaysoft.com/`。

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

## 部署

静态托管即可（Caddy / Nginx / OSS + CDN）：

```caddyfile
h5.cewaysoft.com {
  root * /srv/btos-app-store
  file_server
  header Cache-Control "public, max-age=60"
  header /data/apps.json "Cache-Control no-cache, max-age=0, must-revalidate"
}
```

必需前置：`h5.cewaysoft.com` 的 DNS 解析与证书（当前无解析，需运维开通）。
安装包目录建议同域挂在 `/download/`，保证下载计数与清单同源。

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

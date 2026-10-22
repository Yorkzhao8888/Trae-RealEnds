# Cajob 小程序壳（cajob-mp-shell）

微信小程序最小壳：**打开即进 H5 根**，业务全部在 `h5.cewaycloud.com`，小程序只负责承载、启动层与失败兜底。

- AppID：`wx4b18519a9ab91dfa`（已备案）
- 形态：单页 `web-view`，无 tabBar、无自建业务页面
- 与 App / PC 同源：改版只发一次 H5，小程序无需重新提审

```
cajob-mp-shell/
├── project.config.json          # AppID / 编译配置
└── miniprogram/
    ├── app.js / app.json / app.wxss
    ├── sitemap.json
    ├── assets/logo.png          # 与 iOS/Android 同款品牌标记
    └── pages/
        ├── index/               # 品牌启动层 + web-view
        └── error/               # 加载失败的独立兜底页
```

## 一、业务域名（已完成配置）

`web-view` 打不开 90% 是这一步没做。本小程序已于 2026-10-21 配置完成：

1. 微信公众平台 → **开发管理 → 开发设置 → 业务域名** 已保存：
   - `https://h5.cewaycloud.com`（`web-view` 直连的 H5 根）
   - `https://oas.cewaycloud.com`（H5 内 OAuth 登录的跳转目标）
2. 校验文件为 `UlB86eY3CY.txt`（内容 `17120890685936c3658348986d420ff2`，32 字节、无换行），
   放在服务器 `/opt/oas/mp-verify/`，由 Caddy 在 `h5`、`oas` 两个站点块里用精确 `handle` 直出。
   两条地址均为 200 且内容一致；文件副本见本仓 `verify/UlB86eY3CY.txt`。
3. 保存时微信要求**小程序管理员扫码确认**，属正常风控。

> 若校验文件被重置：把新文件放进 `/opt/oas/mp-verify/` 并同步改 Caddyfile 里的文件名，
> `caddy validate` 后 `systemctl reload caddy`，再回后台保存。

域名要求：已 ICP 备案（已满足）、HTTPS 证书有效、校验文件可公开访问。

> 小程序本身不需要配置「服务器域名」——本壳不发起任何 `wx.request`。

## 二、开发与上传

1. 微信开发者工具 → 导入项目 → 选择 `cajob-mp-shell` 目录
2. AppID 已写入 `project.config.json`，无需再填
3. 详情 → 本地设置 → 勾选「不校验合法域名」（仅本地调试用；**真机预览仍需业务域名生效**）
4. 上传 → 填版本号与备注 → 公众平台提交审核

审核要点：类目需与「工具 / 企业服务」等实际业务匹配；首屏不能是空白或纯外链跳转说明页。

## 三、已知限制（web-view 形态的代价）

| 限制 | 影响 | 处置 |
|---|---|---|
| `web-view` 覆盖全屏，不可在其上叠原生组件 | 加载态、错误提示不能用浮层 | 启动层在挂载前显示；错误改跳独立页 |
| 小程序内不能调 `wx.login` / 支付 / 订阅消息 | 微信身份只能在 H5 内走 OAuth | 身份仍由 `oas.cewaycloud.com` 负责，不在小程序里另建 |
| 物理返回直接退出 `web-view` 页面 | H5 内部层级无法用小程序返回键回退 | 与 App 一致：页面内自带返回入口 |
| 无法读取 H5 的 URL 与标题 | 分享固定为首页 | 需要分页分享时改走 H5 内 JSSDK |
| `web-view` 页面不能下拉刷新 | — | 错误页提供「重新加载」 |

## 四、安全

- `AppSecret` **不得写入本仓库、不得进小程序代码**。它只允许出现在服务端环境变量里。
- 本壳不包含任何密钥；`project.config.json` 只有 AppID（公开信息）。
- 若 AppSecret 曾在聊天/文档中出现，建议在公众平台重置一次。

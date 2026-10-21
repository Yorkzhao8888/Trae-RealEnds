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

## 一、上线前必须先配业务域名

`web-view` 打不开 90% 是这一步没做。

1. 微信公众平台 → **开发管理 → 开发设置 → 业务域名** → 添加 `h5.cewaycloud.com`
2. 平台会要求下载一个校验文件（形如 `xxxxxxxx.txt`），放到**该域名根目录**，即：

   ```
   https://h5.cewaycloud.com/xxxxxxxx.txt   → 200，内容与文件完全一致
   ```

   放法：H5 仓 `h5-root/public/xxxxxxxx.txt`，随构建一起发布。
3. 回到后台点「保存」，校验通过后 `web-view` 才允许加载该域名。

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

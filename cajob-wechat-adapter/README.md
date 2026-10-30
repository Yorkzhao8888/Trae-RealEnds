# 微信 H5 适配 Checklist

> 加载目标：`https://cajob.cewaysoft.com/`（在微信内置浏览器里直接打开）
> 壳角色：**微信自己是壳，我们只在 H5 上加微信 SDK 适配**

## 一、微信公众平台侧（运维/后台）

- [ ] 注册微信公众号（服务号，需企业资质）
- [ ] 后台 → 开发 → 基本配置 → 获取 `AppID` + `AppSecret`
- [ ] 后台 → 开发 → 公众号设置 → 功能设置：
  - [ ] **JS 接口安全域名**：填 `cajob.cewaysoft.com`
  - [ ] **业务域名**：填 `cajob.cewaysoft.com` + 下载校验文件 `MP_verify_xxx.txt` 放根目录（Caddy 配 `handle_path /MP_verify_*.txt`）
  - [ ] **网页授权域名**：填 `cajob.cewaysoft.com`（OAuth2 用）
- [ ] 后台 → 开发 → 订阅消息 → 添加模板（需要审核）→ 记下模板 ID
- [ ] 微信支付商户号（JSAPI 支付需要）

## 二、OAS 鉴权系统侧（后端）

- [ ] 新增微信授权源（类似已有的 xoas）：
  - 微信 OAuth2 授权地址：`https://open.weixin.qq.com/connect/oauth2/authorize`
  - 回调地址：`https://cajob.cewaysoft.com/api/backend/wechat/callback`
  - scope：`snsapi_userinfo`（获取 openid + nickname + avatar）
- [ ] 新增接口 `GET /api/backend/wechat/jsapi-config?url=xxx`
  - 服务端用 `jsapi_ticket`（Access Token 换的，7200s 过期需缓存）签名传入的 URL
  - 返回 `{ appId, timestamp, nonceStr, signature }`
- [ ] 新增接口 `GET /api/backend/wechat/access-token` 缓存 access_token + jsapi_ticket（Redis 存，带 TTL）
- [ ] 绑定映射：openid → 现有 phone:13927411918 身份（首次微信登录让用户填手机号 + OTP）
- [ ] 新增设备令牌（IoT 也用，见 cajob-iot-spec）

## 三、H5 根前端侧（Next.js）

代码在 `cajob-wechat-adapter/wechat-adapter.ts`，复制到 H5 项目后：

- [ ] 页面加载时调 `initWeChat()`（在微信 UA 下自动初始化）
- [ ] 分享按钮 → `wechatShareToFriend()` / `wechatShareToTimeline()`
- [ ] 扫一扫按钮 → `wechatScanQR()`（返回码字符串）
- [ ] 定位 → `wechatGetLocation()`
- [ ] 微信支付 → `wechatPay()`（后端下单返回支付参数）
- [ ] 订阅消息 → `wechatSubscribe(['tmplId1','tmplId2'])`
- [ ] 适配新版微信授权：`<button open-type="chooseAvatar">` 替代废弃的 `open-type="getUserInfo"`

## 四、坑点速查

| 坑 | 表现 | 解法 |
|---|---|---|
| JS-SDK 签名失败 | `wx.config fail: invalid signature` | URL 必须是 `window.location.href.split('#')[0]`（带 # 之后的路径签名对不上）；签名算法官方文档里有 |
| 业务域名校验失败 | 微信里页面显示「该网址未授权」 | 校验文件必须在根目录可直接访问：`https://cajob.cewaysoft.com/MP_verify_xxx.txt` 200 |
| open-type="getUserInfo" 废弃 | 微信开发者工具控制台警告 | 改用 `<button open-type="chooseAvatar">` + `<input type="nickname">` |
| Service Worker | 微信内置浏览器不支持 SW | H5 根不要依赖 SW 做离线缓存 |
| 微信里不能下载文件 | `window.open` 会跳浏览器 | 下载改为跳系统分享面板或引导用浏览器打开 |
| H5 域名 https 必填 | 微信 JSSDK 不支持 http | cajob.cewaysoft.com 已是 https，OK |
| 公众号未认证 | 高级接口用不了（扫一扫/支付/订阅消息） | 企业资质认证（300 元/年） |

## 五、测试方法

```bash
# 1. 检查业务域名校验文件
curl -I https://cajob.cewaysoft.com/MP_verify_xxx.txt

# 2. 检查签名接口（需要后端先实现）
curl -s "https://cajob.cewaysoft.com/api/backend/wechat/jsapi-config?url=https%3A%2F%2Fcajob.cewaysoft.com%2F" \
  -b cookie.txt | python3 -m json.tool
# 预期：{ "appId": "...", "timestamp": 172xxxx, "nonceStr": "...", "signature": "..." }

# 3. 微信开发者工具
#    扫码打开 cajob.cewaysoft.com → Console 看 "wechat-adapter ✅"
#    调试器 → Storage → Cookies / LocalStorage 看值

# 4. 真机测试
#    关注公众号 → 菜单里加链接跳转 → 全流程走一遍
```

# Cajob 壳 P0 桥接契约（评审稿）

> 范围：推送+深链、安全存储、扫码、拍照
> 原则：壳只执行、不判断；H5 必须能在无壳环境下降级
> 现状基线：`shell/cajob-shell.js` v0.2.2 + `shell/cajob-shell.d.ts`

## 0. 本期边界与前置

| 能力 | 现有状态 | 本期要做 | 需新增依赖 |
|---|---|---|---|
| 推送 | 已有 `requestPushPermission` / `getPushToken` + 3 个事件 | 补冷启动取 URL、角标、payload 约定 | 无（PushNotifications 已装） |
| 深链 | 已有 `cajob:deeplink` 事件 | 补 `getLaunchUrl()`，解决冷启动事件丢失 | 无（App 插件已装） |
| 安全存储 | **无** | 新增 `secureGet/Set/Remove` | `@capacitor-community/secure-storage`（Keychain / Keystore） |
| 扫码 | **无** | 新增 `scan()` | `@capacitor-mlkit/barcode-scanning` |
| 拍照 | 插件已装但未暴露 | 新增 `takePhoto()` | 无（Camera 已装） |

> 标注为「需新增依赖」的两项，在插件装上并 `npx cap sync` 之前，H5 侧调用必须走降级分支。

## 1. 通用契约

### 1.1 能力探测

```js
const shell = window.cajobShell;
const has = (k) => !!(shell && typeof shell[k] === 'function');
```

`capabilities` 用来判断「这一版壳有没有这个能力」，而不是靠版本号猜：

```js
// 新增只读字段
capabilities: ['push', 'secureStorage', 'scan', 'photo', 'deeplink']
```

### 1.2 调用约定

- 所有方法返回 `Promise`，失败**不抛异常**，返回 `null` 或 `false`
- H5 侧统一加 8 秒超时：超时按失败处理并降级
- 壳不读取、不缓存业务参数；参数原样使用，用完即弃

### 1.3 错误码

| code | 含义 | H5 处理 |
|---|---|---|
| `DENIED` | 用户拒绝权限 | 引导去系统设置，本次不重试 |
| `UNAVAILABLE` | 设备/系统不支持 | 直接降级到 Web 方案 |
| `CANCELLED` | 用户取消 | 静默，不提示 |
| `TIMEOUT` | 超时 | 降级 |
| `FAILED` | 其他失败 | 提示并降级 |

返回结构统一为 `{ ok: true, data } | { ok: false, code }`，已有方法保持原样不改（避免破坏 v0.2.2 兼容）。

### 1.4 事件

沿用 `cajob:` 前缀，`window.addEventListener` 订阅。事件只做通知，不做状态存储；H5 重新挂载后可通过查询接口补齐。

## 2. 接口定义

### 2.1 推送

```ts
requestPushPermission(): Promise<boolean>
getPushToken(): Promise<string | null>
setBadge(count: number): Promise<void>      // 新增；iOS/Android 支持，PC 空实现
clearBadge(): Promise<void>                 // 新增
```

事件：

| 事件 | 时机 | detail |
|---|---|---|
| `cajob:push-token` | 注册成功/刷新 | `string` |
| `cajob:push-received` | 前台收到 | 原始通知对象 |
| `cajob:push-action` | 用户点击通知 | `{ route, params, coldStart }` |

**服务端 payload 约定**（壳不解析业务，只透传）：

```json
{
  "notification": { "title": "新工单", "body": "浦东现场 · 3 项待处理" },
  "data": { "route": "/cajob/work/123", "params": { "from": "push" } }
}
```

- `route` 必须是 H5 内部路径，壳不拼接、不改写
- 壳只负责把它作为 `cajob:push-action` 的 detail 交给 H5，由 H5 决定跳哪

### 2.2 深链与冷启动

```ts
getLaunchUrl(): Promise<string | null>   // 新增；冷启动被拉起时的 URL
```

为什么必须补：`cajob:deeplink` 是事件，冷启动时壳先派发、H5 后挂载会**丢事件**。H5 启动后应主动取一次：

```js
const url = await shell.getLaunchUrl();
if (url && !handled) route(url);
```

### 2.3 安全存储

```ts
secureSet(key: string, value: string): Promise<boolean>
secureGet(key: string): Promise<string | null>
secureRemove(key: string): Promise<boolean>
```

约束：

- 只存字符串，单条 ≤ 8KB；大对象存服务端
- key 必须以 `cajob.` 开头，壳拒绝其他前缀
- iOS 走 Keychain（`kSecAttrAccessibleAfterFirstUnlock`），Android 走 EncryptedSharedPreferences
- **不得**把 token 再写进 `localStorage`；H5 每次启动从壳取

```js
await shell.secureSet('cajob.token', jwt);
const jwt = await shell.secureGet('cajob.token');
```

### 2.4 扫码

```ts
scan(options?: { formats?: string[]; prompt?: string }):
  Promise<{ ok: true; data: { text: string; format: string } } | { ok: false; code: string }>
```

- 默认格式：`qr`、`code128`、`ean13`
- 需要相机权限；拒绝返回 `DENIED`
- H5 降级：`BarcodeDetector` + `getUserMedia`，再不行给手动输入框

### 2.5 拍照

```ts
takePhoto(options?: {
  quality?: number;        // 0-100，默认 80
  maxWidth?: number;       // 默认 1600
  watermark?: { text: string; sub?: string }
}): Promise<{ ok: true; data: { path: string; width: number; height: number } } | { ok: false; code: string }>
```

边界说明：

- **水印文案由 H5 传入**（时间、地点、工单号），壳只负责绘制，不生成内容
- 返回 `path`（本地文件路径），上传由 H5 用 `fetch` 或后续的分片接口完成
- 不返回 base64，避免大图撑爆内存

## 3. H5 侧接入示例

```js
// bridge.js —— H5 内唯一的壳适配层
const shell = window.cajobShell;

function call(name, args, ms = 8000) {
  if (!shell || typeof shell[name] !== 'function') {
    return Promise.resolve({ ok: false, code: 'UNAVAILABLE' });
  }
  return Promise.race([
    Promise.resolve(shell[name].apply(shell, args)),
    new Promise((r) => setTimeout(() => r({ ok: false, code: 'TIMEOUT' }), ms)),
  ]);
}

export const native = {
  isShell: !!(shell && shell.isMobileShell),

  async login(token) {
    if (this.isShell && shell.capabilities.includes('secureStorage')) {
      await shell.secureSet('cajob.token', token);
    }
    // 浏览器环境仍用内存 + httpOnly cookie，不写 localStorage
  },

  async push() {
    const ok = await call('requestPushPermission');
    if (ok === true) {
      const token = await call('getPushToken');
      return token || null;
    }
    return null;
  },

  async scan() {
    const r = await call('scan', [{ formats: ['qr', 'code128'] }]);
    if (r && r.ok) return r.data.text;
    return webScanFallback(); // BarcodeDetector / 手动输入
  },
};
```

推送点击路由：

```js
window.addEventListener('cajob:push-action', (e) => {
  const { route, params } = e.detail || {};
  if (route) router.push(route, params);
});

// 冷启动补一次
window.cajobShell?.getLaunchUrl?.().then((url) => {
  if (url) router.push(url);
});
```

## 4. 壳侧实现要点

### iOS

- 推送：`AppDelegate` 里 `registerForRemoteNotifications`，entitlements 已有 `aps-environment=production`（随描述文件）
- Keychain：`kSecClassGenericPassword`，不开启 iCloud 同步
- 扫码：AVFoundation `AVCaptureMetadataOutput`
- 拍照：`UIImagePickerController`（相机源），方向校正后再压

### Android

- 推送：优先厂商通道（华为/小米/OPPO/vivo），FCM 作为兜底
- Keystore：`EncryptedSharedPreferences`（Jetpack Security）
- 扫码：ML Kit Barcode Scanning（离线）
- 拍照：CameraX + `EXIFInterface`

### 权限声明

| 平台 | 需声明 |
|---|---|
| iOS | `NSCameraUsageDescription`（已有）、推送（entitlements） |
| Android | `CAMERA`（已有）、`POST_NOTIFICATIONS`（13+）、`VIBRATE` |

## 5. 验收用例

| # | 场景 | 期望 |
|---|---|---|
| 1 | 首次启动请求推送权限 | 允许 → 拿到 token；拒绝 → 返回 false，不反复弹 |
| 2 | 杀进程后点通知 | H5 启动 → `getLaunchUrl` 拿到路由 → 直达详情 |
| 3 | 前台收到推送 | 触发轻提示音 + 双短振，不弹系统横幅 |
| 4 | 杀进程后安全存储读取 | token 仍可读（AfterFirstUnlock） |
| 5 | 相机权限拒绝后扫码 | 返回 `DENIED`，H5 显示手动输入 |
| 6 | 拍照后取消 | 返回 `CANCELLED`，不报错 |
| 7 | 老版本壳（无 `capabilities`） | H5 全部走 Web 降级，不白屏 |
| 8 | 断网状态下推送点击 | 路由可达，页面显示离线兜底 |

## 6. 不在本期

后台定位与地理围栏、蓝牙/NFC、SSL Pinning、防截屏、Widget/实时活动、大文件分片上传。这些进入 P1/P2，接口设计另出文档。

## 7. 变更影响面

| 文件 | 变更 |
|---|---|
| `shell/cajob-shell.js` | 新增 `capabilities` 与 6 个方法，不改已有方法签名 |
| `shell/cajob-shell.d.ts` | 同步类型 |
| `package.json` | 新增 2 个 Capacitor 插件（扫码、安全存储） |
| `ios/App/Podfile` | `pod install` 后自动生成，无需手改 |
| `android/app/src/main/AndroidManifest.xml` | 补 `POST_NOTIFICATIONS` |

评审通过后按此清单实现，H5 侧可先用第 3 节的降级封装接入，不影响现网。

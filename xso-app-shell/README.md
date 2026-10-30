# XSO 智慧企业 App Shell · iOS / Android 桌面壳

> 版本 0.1.0 · 加载目标：`https://xso.cewaysoft.com`（企业工作台）
> 壳不做业务，所有页面与逻辑在 H5 根；原生能力通过 Capacitor 插件桥接。

## 品牌参数

| 项 | 值 |
|---|---|
| 应用名 | XSO 智慧企业 |
| Bundle / applicationId | `com.cewaycloud.xso` |
| URL Scheme | `com.cewaycloud.xso` |
| 品牌色 | 底色 `#0E1218`，强调色 `#1F6FEB`（与站点 `--primary` 一致） |
| 图标 | 深底白色「X」+ 蓝色装饰条；启动页为深底标记 + XSO 智慧企业 / X |
| 载入页 | `/`（企业工作台入口，登录走 `/api/auth/login`） |

## 架构

```
┌─────────────────────────────────────────────────────┐
│           iOS App / Android App                      │
│  ┌─────────────────────────────────────────────┐    │
│  │  Capacitor App Shell (这个工程)             │    │
│  │  - 加载 .../shop                            │    │
│  │  - 原生桥: window.xsoOS.*                 │    │
│  │  - 推送/定位/分享/震动 通过插件供给          │    │
│  └──────────────────────┬──────────────────────┘    │
│                         │ HTTPS WebView              │
│  ┌──────────────────────▼──────────────────────┐    │
│  │  xso.cewaysoft.com (Next.js)    │    │
│  │  业务逻辑 / SSR / CSR / API                  │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

## 目录结构

```
xso-app-shell/
├── package.json              # 依赖 + 构建脚本
├── capacitor.config.json     # 壳配置（server.url 指向线上 H5，errorPath 指向离线页）
├── shell/
│   ├── xso-shell.js      # 原生桥运行时（无构建，可被远程页面直接加载）
│   └── xso-shell.d.ts    # 桥的类型契约（window.xsoOS）
├── index.html                # 本地占位页（仅在 webDir 被独立打开时生效）
├── offline.html              # server.errorPath 兜底页（断网时展示）
├── scripts/prepare-web.sh    # 组装 dist/（index + offline + 桥）
├── tsconfig.json
├── ios/                      ← 已生成 Xcode 工程（brand 已替换）
│   ├── App/App.xcodeproj/
│   ├── App/App/AppDelegate.swift
│   └── Podfile + Podfile.lock
├── android/                  ← 已生成 Android Studio 工程（brand 已替换）
│   ├── app/build.gradle
│   ├── gradle/wrapper/
│   └── app/src/main/AndroidManifest.xml
├── dist/                     壳 web 资源（只放壳自身三个文件，不含业务页面）
├── node_modules/             依赖（gitignore，团队 npm install 装）
├── .gitignore
└── README.md
```

## 关键前提：server.url 模式下本地入口页不执行

壳配置了 `server.url`，Capacitor 会**直接加载** `https://xso.cewaysoft.com`，
本地 `index.html` 的启动逻辑不会运行。因此：

| 能力 | 承载位置 |
|---|---|
| 业务页面 | 线上 H5 根（唯一真源） |
| 断网兜底 | `server.errorPath = offline.html`（本地静态页，零远程依赖） |
| 原生桥 | `shell/xso-shell.js`，由 H5 根引入后执行 |
| 启动画面 | 原生 SplashScreen（`capacitor.config.json` 的 `plugins.SplashScreen`） |

> 不要把健康探测、启动屏、兜底页写进 `index.html` —— 在 `server.url` 模式下它们全是死代码。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 打开原生 IDE
npm run open:ios      # macOS + Xcode 15+ → Cmd+R 跑模拟器
npm run open:android  # JDK 17 + Android Studio → Run 'app'

# 3. 改了壳配置后重新 sync（macOS 上会自动 pod install）
npm run sync

# 4. 构建产物（需原生 IDE）
#    iOS：Xcode → Product → Archive → Export → App Store Connect
#    Android：AS → Build → Generate Signed Bundle / APK
```

> 本仓库在 Linux 环境完成到 `cap sync`；未安装 Android SDK / Xcode，因此**未产出安装包**。
> `ios/App/Podfile.lock` 沿用上一工程的插件集合，首次在 macOS 打开前请执行一次 `pod install`。

## 原生桥（H5 根可直接调用）

### 接入方式

桥运行时是 `shell/xso-shell.js`（自包含 IIFE，无 import、无打包依赖）。
H5 根任选其一接入：

1. **随 H5 同域部署**（推荐）：把 `xso-shell.js` 放进 H5 根的 `public/`，
   在根布局加 `<script src="/xso-shell.js" defer></script>`；
2. **直接调用 Capacitor 原生插件**（不引本文件）：
   `window.Capacitor.Plugins.Share.share(...)`，桥只是更顺手的封装；
3. 由壳原生侧注入（需 Android/iOS 原生改动，暂未启用）。

桥自带幂等保护（重复引入不会重复绑定监听），并在 `deviceready` 后兜底重试。

### 调用示例

```typescript
if (window.xsoOS?.isMobileShell) {
  window.xsoOS.vibrate();
  await window.xsoOS.share({
    title: 'XSO 智慧企业',
    text: '好味道，来自工场',
    url: 'https://xso.cewaysoft.com',
  });
  const loc = await window.xsoOS.getLocation();
  await window.xsoOS.openExternal('https://oas.cewaysoft.com/...');
}
```

H5 根监听壳事件：

```typescript
window.addEventListener('xso:app-resume', () => refreshUnread());
window.addEventListener('xso:push-token', (e) => {
  api.post('/device/push-token', { token: (e as CustomEvent).detail });
});
window.addEventListener('xso:deeplink', (e) => {
  router.push(parseDeeplink((e as CustomEvent).detail));
});
```

事件前缀统一为 `xso:`：`shell-ready` / `app-resume` / `push-token` / `push-received` / `push-action` / `deeplink`。

## 权限与隐私声明（已配齐，改动时勿删）

| 能力 | Android 清单 | iOS 用途文案 |
|---|---|---|
| 相机 | `CAMERA` + `uses-feature required=false` | `NSCameraUsageDescription` |
| 相册 | （系统 Photo Picker 无需权限） | `NSPhotoLibraryUsageDescription`、`NSPhotoLibraryAddUsageDescription` |
| 定位 | `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` | `NSLocationWhenInUseUsageDescription` |
| 通知 | `POST_NOTIFICATIONS`（13+） | `UIBackgroundModes: remote-notification` |
| 震动 | `VIBRATE` | — |
| 外部浏览器 | `<queries>` https VIEW | — |

> iOS 缺用途文案不是「弹不出权限」，而是**调用即终止进程**；Android 缺权限是**运行时异常**。两者都在真机上一票否决。

## 推送配置

通知渠道已在原生侧创建（`MainActivity.java`）：`xso_messages`（消息/订单）与 `xso_alerts`（系统/结算）。

### iOS（APNs）
1. Apple Developer → Identifiers → 新建 `com.cewaycloud.xso` → 勾 Push Notifications
2. Production SSL 证书 → 转 `.p12` → 后端接 APNs 网关

### Android（FCM）
1. Firebase Console → 创建项目 → Add Android App（包名 `com.cewaycloud.xso`）
2. 下 `google-services.json` → 放 `android/app/`
3. 后端接 FCM HTTP v1 API

## 签名与分发

| 目标 | 前置 | 构建 | 分发 |
|---|---|---|---|
| iOS 内测 | Apple Developer Team | Xcode Archive → Ad Hoc | UDID 注册 + 直接安装 |
| iOS App Store | 同上 + Connect 已建应用 | Xcode Archive → App Store | App Store Connect 上传 |
| Android 内测 | Keystore 文件 | AS → Generate Signed APK | 直接安装 |
| Android Google Play | Play 开发者账号 + keystore | AS → Generate Signed Bundle | Google Play 上传 AAB |

iOS 首次导出前需在 Apple Developer 后台为该 bundle id 新建 Distribution 描述文件，
并把名字填进 `ios/App/ExportOptions.plist`（当前占位为 `XSO ASC`）。

## 已知限制

| 项 | 状态 | 说明 |
|---|---|---|
| H5 鉴权 | ✅ 正常 | Cookie 与 PC 端一致 |
| 微信 JS-SDK | ❌ 壳里不可用 | 微信 SDK 只在微信内置浏览器生效；壳里用 `window.xsoOS.share()` 替代 |
| 支付 | ⚠️ 待接 | 需 Capacitor 支付插件或自建 |
| Service Worker | ❌ 默认禁用 | Capacitor WebView 环境 SW 有坑，H5 根不要依赖 |
| 热更新 | ⚠️ 版本同频 | H5 发版后，壳在回到前台时比对 chunk 指纹并重载；原生包仍走商店更新 |
| iPad | ✅ 自动覆盖 | iOS 壳自动生成 iPhone + iPad target |

## 插件清单（已 sync）

```
@capacitor/app          生命周期（回到前台通知 H5、deeplink）
@capacitor/browser      打开系统浏览器
@capacitor/camera       拍照/选图
@capacitor/filesystem   文件读写
@capacitor/geolocation  定位
@capacitor/haptics      震动
@capacitor/keyboard     键盘
@capacitor/local-notifications  本地通知
@capacitor/push-notifications   远程推送
@capacitor/share        系统分享
@capacitor/splash-screen        启动屏
@capacitor/status-bar   状态栏
```

## 构建问题排查

| 错误 | 原因 | 解法 |
|---|---|---|
| Xcode `No signing certificate` | Team 没选 | Xcode → Signing & Capabilities → Team 选开发者账号 |
| `pod install` 失败 | 网络 | 换源 `pod repo update` 或 CDN 源 |
| AS `Gradle sync` 超时 | 网络 | gradle-wrapper.properties 换国内镜像 |
| Android `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 签名不一致 | 卸载旧版本重装，或用同一个 keystore 签 |
| iOS 运行时白屏 | H5 根不可达 | 已由 `server.errorPath` 兜底；否则检查 sync 进原生工程的 url / errorPath |

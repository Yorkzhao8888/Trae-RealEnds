# Cajob App Shell · iOS / Android 桌面壳

> 版本 0.2.2 · 加载目标：`https://h5.cewaycloud.com`
> 壳不做业务，所有页面/逻辑在 H5 根；原生能力通过 Capacitor 插件桥接

## 架构

```
┌─────────────────────────────────────────────────────┐
│           iOS App / Android App                      │
│  ┌─────────────────────────────────────────────┐    │
│  │  Capacitor App Shell (这个工程)             │    │
│  │  - 加载 https://h5.cewaycloud.com          │    │
│  │  - 原生桥: window.cajobShell.*              │    │
│  │  - 推送/定位/分享/震动 通过插件供给          │    │
│  └──────────────────────┬──────────────────────┘    │
│                         │ HTTPS WebView              │
│  ┌──────────────────────▼──────────────────────┐    │
│  │  h5.cewaycloud.com  (Next.js App Router)    │    │
│  │  业务逻辑 / SSR / CSR / API                  │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

## 目录结构

```
cajob-app-shell/
├── package.json              # 依赖 + 构建脚本
├── capacitor.config.json     # 壳配置（server.url 指向线上 H5，errorPath 指向离线页）
├── shell/
│   ├── cajob-shell.js        # 原生桥运行时（无构建，可被远程页面直接加载）
│   └── cajob-shell.d.ts      # 桥的类型契约（window.cajobShell）
├── index.html                # 本地占位页（仅在 webDir 被独立打开时生效）
├── offline.html              # server.errorPath 兜底页（断网时展示）
├── scripts/prepare-web.sh    # 组装 dist/（index + offline + 桥）
├── tsconfig.json
├── ios/                      ← ✅ 已生成 Xcode 工程
│   ├── App/App.xcodeproj/
│   ├── App/App/AppDelegate.swift
│   └── Podfile + Podfile.lock
├── android/                  ← ✅ 已生成 Android Studio 工程
│   ├── app/build.gradle
│   ├── gradle/wrapper/
│   └── app/src/main/AndroidManifest.xml
├── dist/                     壳 web 资源（只放壳自身的三个文件，不含业务页面）
├── node_modules/             依赖（gitignore，团队 npm install 装）
├── .gitignore
└── README.md
```

## 关键前提：server.url 模式下本地入口页不执行

壳配置了 `server.url`，Capacitor 会**直接加载** `https://h5.cewaycloud.com`，
本地 `index.html` 的启动逻辑不会运行。因此：

| 能力 | 承载位置 |
|---|---|
| 业务页面 | 线上 H5 根（唯一真源） |
| 断网兜底 | `server.errorPath = offline.html`（本地静态页，零远程依赖） |
| 原生桥 | `shell/cajob-shell.js`，由 H5 根引入后执行 |
| 启动画面 | 原生 SplashScreen（`capacitor.config.json` 的 `plugins.SplashScreen`） |

> 不要把健康探测、启动屏、兜底页写进 `index.html` —— 在 `server.url` 模式下它们全是死代码。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 打开原生 IDE
npm run open:ios      # macOS + Xcode 15+ → Cmd+R 跑模拟器
npm run open:android  # JDK 17 + Android Studio → Run 'app'

# 3. 改了壳配置后重新 sync（自动 pod install / gradle sync）
npm run sync

# 4. 构建产物（需原生 IDE）
#    iOS：Xcode → Product → Archive → Export → App Store Connect
#    Android：AS → Build → Generate Signed Bundle / APK
```

## 原生桥（H5 根可直接调用）

### 接入方式

桥运行时是 `shell/cajob-shell.js`（自包含 IIFE，无 import、无打包依赖）。
H5 根任选其一接入：

1. **随 H5 同域部署**（推荐）：把 `cajob-shell.js` 放进 H5 根的 `public/`，
   在根布局加 `<script src="/cajob-shell.js" defer></script>`；
2. **直接调用 Capacitor 原生插件**（不引本文件）：
   `window.Capacitor.Plugins.Share.share(...)`，桥只是更顺手的封装；
3. 由壳原生侧注入（需 Android/iOS 原生改动，暂未启用）。

桥自带幂等保护（重复引入不会重复绑定监听），并在 `deviceready` 后兜底重试。

### 调用示例

壳初始化后，H5 根里通过 `window.cajobShell` 访问（`shellVersion` 可用于能力判断）：

```typescript
// 判断环境
if (window.cajobShell?.isMobileShell) {
  // 震动提醒
  window.cajobShell.vibrate();
  // 系统分享
  await window.cajobShell.share({
    title: 'Cajob - 真实端职聘',
    text: '下载 Cajob 找工友',
    url: 'https://h5.cewaycloud.com/download',
  });
  // 定位
  const loc = await window.cajobShell.getLocation();
  // 打开系统浏览器
  await window.cajobShell.openExternal('https://oas.cewaycloud.com/...');
}
```

H5 根监听壳事件：

```typescript
window.addEventListener('cajob:app-resume', () => refreshUnread());
window.addEventListener('cajob:push-token', (e) => {
  api.post('/device/push-token', { token: (e as CustomEvent).detail });
});
window.addEventListener('cajob:deeplink', (e) => {
  router.push(parseDeeplink((e as CustomEvent).detail));
});
```

## 权限与隐私声明（已配齐，改动时勿删）

| 能力 | Android 清单 | iOS 用途文案 |
|---|---|---|
| 相机 | `CAMERA` + `uses-feature required=false` | `NSCameraUsageDescription` |
| 相册 | （系统 Photo Picker 无需权限） | `NSPhotoLibraryUsageDescription`、`NSPhotoLibraryAddUsageDescription` |
| 定位 | `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` | `NSLocationWhenInUseUsageDescription` |
| 通知 | `POST_NOTIFICATIONS`（13+） | `UIBackgroundModes: remote-notification` |
| 震动 | `VIBRATE` | — |
| 外部浏览器 | `<queries>` https VIEW | — |

> iOS 缺用途文案不是"弹不出权限"，而是**调用即终止进程**；Android 缺权限是**运行时异常**。两者都在真机上一票否决。

## 推送配置

### iOS（APNs）
1. Apple Developer → Identifiers → App ID → 勾 Push Notifications
2. Production SSL 证书 → 转 `.p12` → 后端接 APNs 网关

### Android（FCM）
1. Firebase Console → 创建项目 → Add Android App
2. 下 `google-services.json` → 放 `android/app/`
3. 后端接 FCM HTTP v1 API

## 签名与分发

| 目标 | 前置 | 构建 | 分发 |
|---|---|---|---|
| iOS 内测 | Apple Developer Team | Xcode Archive → Ad Hoc | UDID 注册 + 直接安装 |
| iOS App Store | 同上 + 应用已在 Connect 创建 | Xcode Archive → App Store | App Store Connect 上传 |
| Android 内测 | Keystore 文件 | AS → Generate Signed APK | 微信/QQ 传文件安装 |
| Android Google Play | Google Play 开发者账号 + keystore | AS → Generate Signed Bundle | Google Play 上传 AAB |

Android 签名配置（Keystore 放 `android/app/release.keystore`）：

```gradle
// android/app/build.gradle
android {
    signingConfigs {
        release {
            storeFile file('release.keystore')
            storePassword "your-store-password"
            keyAlias "cajob"
            keyPassword "your-key-password"
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled true
        }
    }
}
```

## 已知限制

| 项 | 状态 | 说明 |
|---|---|---|
| H5 鉴权 | ✅ 正常 | OAuth + cookie 与 PC 壳一致 |
| 微信 JS-SDK | ❌ 壳里不可用 | 微信 SDK 只在微信内置浏览器生效；壳里用 `window.cajobShell.share()` 替代 |
| 支付 | ⚠️ 待接 | 需 Capacitor Stripe 插件或自建 |
| Service Worker | ❌ 默认禁用 | Capacitor WebView 环境 SW 有坑，H5 根不要依赖 |
| 热更新 | ❌ 未接 | 发版走商店；可接 Capacitor Live Updates 做 H5 热更 |
| iPad | ✅ 自动覆盖 | Capacitor iOS 壳自动生成 iPhone + iPad target |
| 鸿蒙 NEXT | ✅ 官方支持 | `npm install @capacitor/harmonyos`（等 HarmonyOS NEXT 正式版） |

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
@capacitor/status-bar   状态栏
```

## 构建问题排查

| 错误 | 原因 | 解法 |
|---|---|---|
| Xcode `No signing certificate` | Team 没选 | Xcode → Signing & Capabilities → Team 选你的开发者账号 |
| `pod install` 失败 | 网络 | 换源 `pod repo update` 或 `CDN` 源 |
| AS `Gradle sync` 超时 | 网络 | 配置 gradle-wrapper.properties 用国内镜像（阿里） |
| Android `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 签名不一致 | 卸载旧版本后重装，或用同一个 keystore 签 |
| iOS 运行时白屏 | H5 根不可达 | 已由 `server.errorPath` 兜底；若仍白屏，检查 `capacitor.config.json` 的 url 与 errorPath 是否被 sync 进原生工程 |

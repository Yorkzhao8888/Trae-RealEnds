# 手表 Widget 设计 Spec

> 状态：待实现（Phase 2）｜目标：iOS WatchOS + Android WearOS 极简原生界面，显示 Cajob 关键信息 + 快捷操作
> 关键约束：手表 1.5"-2" 屏、算力有限、必须原生 UI（WebView 体验灾难）、通过 API 拉数据不走 H5

## 架构

```
手表 Widget（原生 SwiftUI / Compose）
  │
  │  App Group / Data Layer 共享
  ▼
手机壳 App（Capacitor iOS/Android）
  │
  │  HTTPS API + device_token 或 App 内共享 session
  ▼
h5.cewaycloud.com/api/backend/*
```

## 为什么用 Widget 而不是独立手表壳

| 选项 | 可行性 | 体验 | 成本 |
|---|---|---|---|
| 独立手表 Electron 壳 | ❌ WatchOS 没有 Electron | — | — |
| 独立手表内嵌 WebView | ⚠️ WatchOS 有 WKWebView | ❌ 1.5" 屏显示普通网页 = 不可用 | 极高 |
| **Widget Extension** | ✅ WatchOS WidgetKit / WearOS Tiles | ✅ 原生 UI、秒开、系统级显示 | 低 |

Widget 是手表端**唯一正确的选择**。

## iOS Widget（WatchOS + iOS 锁屏/桌面）

### Widget Kit 三种尺寸

| 尺寸 | 位置 | 内容 |
|---|---|---|
| **Accessory Circular** | Apple Watch 表盘 Complication | 未读消息数 + 小圆点 |
| **Accessory Rectangular** | iOS 锁屏小组件、Watch 通知卡片 | 最新一条未读消息预览 |
| **Widget Small** | iOS 桌面 | 今日订单统计 + 接单按钮 |

### SwiftUI 代码骨架（iOS Widget Extension）

```swift
// CajobWidget.swift
import WidgetKit
import SwiftUI

// MARK: - Provider（数据层）
struct CajobEntry: TimelineEntry {
    let date: Date
    let unreadCount: Int
    let latestMessage: String
    let latestFrom: String
    let todayOrders: Int
}

struct CajobProvider: TimelineProvider {
    func placeholder(in context: Context) -> CajobEntry {
        CajobEntry(date: .now, unreadCount: 3, latestMessage: "老板好",
                   latestFrom: "张三", todayOrders: 2)
    }
    func getSnapshot(in context: Context, completion: @escaping (CajobEntry) -> Void) {
        fetchData { completion($0) }
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<CajobEntry>) -> Void) {
        fetchData { entry in
            let nextUpdate = Calendar.current.date(byAdding: .minute, value: 15, to: .now)!
            completion(Timeline(entries: [entry], policy: .after(nextUpdate)))
        }
    }
    
    private func fetchData(_ cb: @escaping (CajobEntry) -> Void) {
        // 方案 A：走手机壳 App 共享的 App Group + Keychain 拿 session
        // 方案 B：走 device_token 直调 API（需要后端支持）
        // 这里用 URLSession 示例，token 从 App Group UserDefaults 读
        let token = UserDefaults(suiteName: "group.com.cewaycloud.cajob")?.string(forKey: "deviceToken") ?? ""
        var req = URLRequest(url: URL(string: "https://h5.cewaycloud.com/api/backend/widget/overview")!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: req) { data, _, _ in
            if let data = data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                cb(CajobEntry(
                    date: .now,
                    unreadCount: json["unread"] as? Int ?? 0,
                    latestMessage: json["latest_msg"] as? String ?? "",
                    latestFrom: json["latest_from"] as? String ?? "",
                    todayOrders: json["today_orders"] as? Int ?? 0
                ))
            } else {
                cb(CajobEntry(date: .now, unreadCount: 0, latestMessage: "", latestFrom: "", todayOrders: 0))
            }
        }.resume()
    }
}
```

```swift
// MARK: - Widget 视图
@main
struct CajobWidgetBundle: WidgetBundle {
    var body: some Widget {
        CajobWidget()
        CajobWatchComplication()
    }
}

// iOS 桌面小组件（Widget Small）
struct CajobWidget: Widget {
    let kind = "CajobWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: CajobProvider()) { entry in
            VStack(alignment: .leading, spacing: 6) {
                Text("Cajob")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack {
                    Image(systemName: "bag.fill")
                    Text("\(entry.todayOrders) 单")
                }
                .font(.title3)
                if entry.unreadCount > 0 {
                    HStack {
                        Image(systemName: "envelope.badge")
                        Text("\(entry.unreadCount) 未读")
                    }
                    .font(.caption)
                    .foregroundStyle(.blue)
                }
            }
            .padding()
            .widgetBackground(Color(red: 0.04, green: 0.42, blue: 0.37))
            .widgetURL(URL(string: "cajob://orders")!)
        }
        .configurationDisplayName("Cajob")
        .description("今日订单与未读消息")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// WatchOS Complication（表盘小圆形）
struct CajobWatchComplication: Widget {
    let kind = "CajobWatch"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: CajobProvider()) { entry in
            ZStack {
                Color(red: 0.04, green: 0.42, blue: 0.37)
                VStack(spacing: 0) {
                    Image(systemName: "envelope.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(.white)
                    Text("\(entry.unreadCount)")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                }
            }
            .widgetURL(URL(string: "cajob://messages")!)
        }
        .configurationDisplayName("Cajob")
        .description("未读消息数")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular])
    }
}
```

### iOS 端需要加的配置

```xml
<!-- Info.plist（Widget Extension）-->
<key>NSExtension</key>
<dict>
  <key>NSExtensionPointIdentifier</key>
  <string>com.apple.widgetkit-extension</string>
</dict>
<!-- App Group（Widget 和 主 App 共享数据）-->
<!-- Signing & Capabilities → + Capability → App Groups → group.com.cewaycloud.cajob -->
```

## Android Widget（WearOS + Android 桌面）

### WearOS Tiles

Android 手表端用 **Tiles** 而不是 App Widget（更轻量，支持 Wear OS 3+）：

```kotlin
// CajobTileService.kt（Tiles 是一次性渲染，不能交互）
class CajobTileService : TileService() {
    override fun onTileRequest(requestParams: RequestBuilders.TileRequest) =
        Futures.immediateFuture(Tile.Builder(requestParams.VERSION, requestParams.DEVICE_PARAMETERS)
            .setResourcesVersion("1")
            .apply {
                val unread = fetchUnread() // API 调用
                addTimelineEntry(Tile.TimelineEntry.Builder()
                    .setKey("hello")
                    .setConfiguration(
                        androidx.wear.tiles.material.TileLayout.Builder(requestParams)
                            .addContainers(
                                Column.Builder()
                                    .addContent(Text.Builder("Cajob $unread 未读").build())
                                    .build()
                            )
                            .build()
                    )
                    .build())
            }.build())
}
```

### Android 桌面 App Widget

```kotlin
// CajobWidgetProvider.kt
class CajobWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        val views = RemoteViews(context.packageName, R.layout.widget_cajob)
        val data = fetchFromDeviceToken()  // API 调用
        views.setTextViewText(R.id.widget_unread, "${data.unread} 未读")
        views.setTextViewText(R.id.widget_orders, "${data.todayOrders} 单")
        appWidgetManager.updateAppWidget(appWidgetIds, views)
    }
}
```

## 后端需要加一个 Widget 专用接口

```
GET /api/backend/widget/overview
Authorization: Bearer <device_token>

→ {
    "unread": 3,
    "latest_msg": "老板好，订单确认下",
    "latest_from": "张三",
    "latest_avatar": "https://.../avatar_xxx.jpg",
    "today_orders": 2,
    "pending_orders": 1,
    "updated_at": "2026-10-19T09:15:00Z"
  }
```

Widget 每 15-30 分钟刷新一次，后端**必须加 Redis 缓存**（避免每次刷新查 DB）。

## 数据共享方案

| 端 | 方案 | 说明 |
|---|---|---|
| iOS Widget | App Group + Keychain | Widget Extension 和 Capacitor 主 App 共享 device_token |
| Android Widget | SharedPreferences + FileProvider | AppWidgetProvider 和主 App 共享 token |
| 直接 API（两边通用） | device_token（见 cajob-iot-spec） | Widget 自己直调 `/api/backend/widget/*` |

**推荐直接用 device_token 方案**：Widget 自己带 token 调 API，不依赖主 App 活着。App Group 方案作为 fallback（token 读不到时用 App Group 里的 cookie session）。

## 开发阶段建议

| 步骤 | 产出 | 工作量 |
|---|---|---|
| 1. 后端 widget/overview 接口 + 缓存 | API | 后端 1 天 |
| 2. iOS WidgetKit 基础框架 | Xcode 工程 + SwiftUI | 原生 2-3 天 |
| 3. Android App Widget + WearOS Tile | Android Studio + Kotlin | 原生 2-3 天 |
| 4. device_token 对接 IoT spec | API 鉴权 | 后端 1 天 |
| 5. 真机调优（刷新频率/耗电量） | 测试 | 1 天 |

**总估算：1 周左右（后端 2 天 + 原生 5 天）**，可以和 Capacitor 壳并行开发。

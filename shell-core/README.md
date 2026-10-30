# shell-core — 共享壳运行时

一份代码，四个品牌，三种平台。`window.Shell` 是契约入口，品牌别名（`ziwayOS` / `jechanOS` / `xsoOS` / `cajobOS`）是兼容层。

## 为什么合并

此前 4 份桥是同一份代码改名复制（Capacitor 插件调用、返回键、推送、H5 同频重载逐行相同），改动要同步 4 次，且各品牌能力上报不一致。合并后：

- 能力矩阵、事件名、错误码只有一处定义
- 品牌差异收敛到 `src/brands/*.json`（域名、四端、色值、别名）
- 产物仍是**自包含单文件**，H5 只需 `<script src="/<brand>-shell.js" defer>`

## 结构

```
shell-core/
  src/core.js           运行时（适配器探测 + 方法分发 + 事件）
  src/brands/*.json     品牌配置（只放数据，不放逻辑）
  src/selftest.html     真机自检页（10 项 + 事件流）
  dist/*.js             构建产物（供 H5 部署）
  build.mjs             生成器（--check 用于 CI）
```

## 使用

```bash
node shell-core/build.mjs          # 生成四个品牌桥
node shell-core/build.mjs --check  # 校验产物与源一致（CI）
```

构建会把 `core.js` + 品牌配置拼成单文件，写入 `<project>/shell/<brand>-shell.js` 与 `shell-core/dist/`。**不要手改产物**。

## H5 接入

```html
<script src="/ziwayos-shell.js" defer></script>
<script>
  window.addEventListener('shell:ready', function (e) {
    if (e.detail.data.capabilities.push === '✓') requestNotification();
  });
</script>
```

- `Shell.call('core.handshake')` 可在错过 `shell:ready` 后补取
- `Shell.call('core.net')` 返回 `{ online, type, weak }`，弱网降级以此为准
- 旧调用不变：`Shell.vibrate()` / `Shell.share()` / `Shell.getLocation()` / `Shell.switchEnd(id)`

## 店根接入（edge）

店内局域网有店根时，成交走高置信事务；店根不可达再回落离线队列。

```js
await Shell.call('edge.configure', { baseUrl: 'http://192.168.1.20:7321', token: '...' });
const h = await Shell.call('edge.health');           // {ok, version, cloudOffline}
await Shell.call('edge.lease', {});                  // 自动缓存租约（TTL 内复用）
await Shell.call('edge.commit', {
  ops: [{ idem: 'pos1-000123', op: 'dec', sku: 'SKU-1', qty: 2 }],
  fallback: 'queue',                                 // 店根不可达则入离线队列
});
```

- 桌面壳默认店根为 `http://127.0.0.1:7321`（PC 壳即店根本机）
- 移动壳需显式 `edge.configure`，或用 `?edge=http://<门店IP>:7321`
- 超时 3s，快速失败；错误码 `E_EDGE_OFFLINE` / `E_STOCK`（带 `onHand`）/ `E_LEASE` / `E_LIMIT`
- 幂等键由端生成，重放安全；库存不足整批回滚

## 平台适配

| 环境 | 探测方式 | 说明 |
|---|---|---|
| Capacitor | `window.Capacitor.getPlatform()` | 原生插件直连，状态栏/返回键/推送/启动屏 |
| Electron | `window.ShellDesktop.isDesktopShell` | 桌面能力由 preload 提供，未提供则降级 |
| 小程序 | `?shell=mp` 或 UA `miniProgram` | 只上报能力，不碰原生 API |
| 浏览器 | 兜底 | 震动/网络可用，其余标 `◐` |

## 自检

`dist/selftest.html` 与桥同目录部署，真机打开 `?brand=ziway|jechan|xso|cajob`：
桥注入、握手重放、环境识别、能力字段、品牌别名，加上震动/分享/定位/网络/状态栏/推送授权六个探针，以及事件流时间线。

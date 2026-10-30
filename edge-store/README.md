# edge-store — 店根

云根不可达时，店内仍然能做生意。店根是「店内真相」的持有者：库存、租约、成交事件都落在这一层，端壳只负责界面与排队。

契约：[docs/shell-contract.md](../docs/shell-contract.md) §店根。

## 为什么需要它

只靠端壳各自缓存会出现两类硬伤：

1. **超卖**：两台收银、两桌点同一份菜，端上各自扣减都会「成功」。
2. **对账黑洞**：断网期间每端各记一套账，恢复后无人能判哪条为准。

把原子性收到店根（单机 SQLite + 单事务），端壳只提交意图，问题从「分布式」退化为「单机事务」。

## 启动

```bash
EDGE_TOKEN=dev-token npm start
# → http://0.0.0.0:7321  store=store-local token=on
```

无第三方依赖，Node 24 内置 `node:sqlite`；门店 Windows POS / Linux 收银机不需要编译原生模块。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `EDGE_PORT` | 7321 | 监听端口 |
| `EDGE_HOST` | 0.0.0.0 | 门店局域网监听 |
| `EDGE_TOKEN` | 空 | 非空时要求 `Authorization: Bearer <token>` |
| `EDGE_STORE_ID` | store-local | 门店标识 |
| `EDGE_LEASE_TTL_MS` | 900000 | 租约有效期（15 分钟） |
| `EDGE_MAX_QTY` | 20 | 单笔上限（离线额度） |
| `EDGE_DB` | ./edge.db | 本地库路径 |

## API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/edge/health` | 存活、版本、云根连通性、活跃租约数 |
| POST | `/edge/lease` | `{deviceId, ttlMs}` → `{leaseId, ttl, limits}` |
| POST | `/edge/commit` | `{leaseId, ops:[{idem,op:'dec'\|'inc',sku,qty}]}`，整批成功或整批失败 |
| GET | `/edge/snapshot?since=` | 事件增量 + 当前库存 + 版本号 |
| POST | `/edge/cloud` | `{offline}` 由探针写入云根连通性 |
| GET | `/edge/outbox` | 待回传事件（游标之后的批次） |
| POST | `/edge/sync` | `{cloudUrl, token}` 触发回传；`200` 完成、`409` 冲突、`502` 可重试 |
| GET | `/edge/conflicts` | 未处理的冲突 |
| POST | `/edge/conflicts/:id/resolve` | `{action:'accept'\|'reject'\|'auto'}`，`auto` 仅限库存类 |

返回约定：

- `200` 成功，`{ok:true, version, applied, replayed}`
- `409` + `code`: `stock`（库存不足，带上 `sku`/`onHand`）/ `lease_expired` / `lease_unknown` / `limit`（超单笔上限）
- `401` 鉴权失败；`400` 参数错误

## 三条不可妥协的规则

1. **幂等**：同 `idem` key 重放不重复扣减，`replayed` 计数可见。
2. **原子**：一批 ops 里只要有一件库存不足，整批回滚——包括已写入的幂等键与事件。
3. **租约**：过期即降级只读，端必须重新取租约；离线不是无限授权。

## 局域网发现

```js
import { startBeacon, discover } from './src/beacon.js';
startBeacon('store-local');            // 店根侧：每 3s 广播 UDP 7322
const edge = await discover();         // 端侧：拿到 {storeId, port}
```

用广播而非 mDNS：门店 AP 常屏蔽组播；发现失败时端壳允许手填 IP。

## 测试

```bash
npm test
```

11 项覆盖：鉴权、租约、幂等重放、整批回滚、过期拒单、单笔上限、快照游标、云根离线标记，以及回传游标推进、409 不跳过、资金类禁止自动放行、5xx 可重试。

## 云根回传与冲突裁决

店根先本地提交，再异步回传（outbox 游标 `syncedSeq`）。三条不可妥协：

1. **不跳过**：云根 409 时游标停在冲突事件之前，不允许"跳过继续传"。
2. **不动资金账**：`money.settle` / `money.refund` / `member.points` 一律 `manual_pending`，`auto` 解析会返回 `400 manual_required`。
3. **未知类型保守**：未登记的事件类型按资金类处理，宁可人工复核。

库存类（`stock.dec` / `stock.inc` / `order.draft`）可自动放行；云根 5xx 视为可重试、游标不动。

## 尚未做

- **云根侧接口**：`/cloud/events` 目前由店根调用，需云根按同契约实现（幂等 + 409 冲突体 `{seq, reason}`）
- **定时回传**：现为手动 `POST /edge/sync` 触发，未做后台定时器与退避
- **读模型下发**：只有上行事件，没有云根把商品/价格变更推到店根（`/edge/pull`）
- **冲突复核界面**：只有 API，没有运营端页面

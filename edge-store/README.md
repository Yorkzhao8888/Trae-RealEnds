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
| `EDGE_CLOUD_URL` | 空 | 云根地址；**非空即启动后台定时回传 + 下行拉取** |
| `EDGE_CLOUD_TOKEN` | 空 | 回传用的云根凭据（Bearer） |

## API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/edge/health` | 存活、版本、云根连通性、活跃租约数 |
| POST | `/edge/lease` | `{deviceId, ttlMs}` → `{leaseId, ttl, limits}` |
| POST | `/edge/commit` | `{leaseId, ops:[{idem,op:'dec'\|'inc',sku,qty}]}`，整批成功或整批失败 |
| GET | `/edge/snapshot?since=` | 事件增量 + 当前库存 + 版本号 |
| POST | `/edge/cloud` | `{offline}` 由探针写入云根连通性 |
| GET | `/edge/outbox` | 待回传事件（游标之后的批次） |
| POST | `/edge/sync` | `{cloudUrl, token}` 手动触发一次回传；`200` 完成、`409` 冲突、`502` 可重试 |
| GET | `/edge/sync/status` | 调度器状态：`configured/running/paused/backoffMs/fails/last`（`last.pull` 含本次下行结果） |
| POST | `/edge/sync/now` | 立即跑一次（不等待下一个定时点），返回本次结果 |
| POST | `/edge/pull` | `{cloudUrl, token}` 拉一批商品/价格；`200` 完成、`502` 可重试 |
| GET | `/edge/catalog` | 店根本地商品读模型 + 下行游标 `cursor` |
| POST | `/iot/ingest` | 网关批量上报事件 + 设备台账；按 `idem` 幂等 |
| POST | `/iot/heartbeat` | 网关心跳：刷新设备在线状态与 `last_seen` |
| GET | `/iot/devices` | 设备列表 + 最新值（超期自动标 `stale`） |
| GET | `/iot/gateways` | 网关存活与运维读模型：最后心跳、版本、积压/失败计数、名下设备在线数；90s 未心跳判离线 |
| GET | `/iot/devices/:id` | 设备详情 + 最近 50 条事件 |
| GET | `/iot/devices/:id/series?metric=&since=&limit=` | 指标时序（`since` 为毫秒时间戳，`limit` ≤ 1000） |
| GET | `/iot/stream?since=&wait=` | 长轮询事件流（`since` 为 `seq` 游标，`wait` ≤ 30s） |
| GET | `/edge/conflicts` | 未处理的冲突 |
| POST | `/edge/conflicts/:id/resolve` | `{action:'accept'\|'reject'\|'auto'}`，`auto` 仅限库存类 |
| GET | `/edge/ui/conflicts` | 冲突复核运营页（静态，免鉴权；页内数据接口仍需 token） |
| GET | `/edge/ui/iot` | IoT 只读看板（静态，免鉴权；设备列表、详情、事件与时序，无控制操作） |

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

31 项覆盖：鉴权、租约、幂等重放、整批回滚、过期拒单、单笔上限、快照游标、云根离线标记；回传游标推进、409 不跳过、资金类禁止自动放行、5xx 可重试；退避归位、连续失败置离线、恢复归零、冲突暂停、冲突解决后恢复；下行的首次落库与事件、增量带 `since`、下架/删除、重复下发幂等、5xx 与网络异常不动游标、下行失败不影响上行；运营页免鉴权可开而数据接口仍要 token；IoT 批量幂等、心跳超期降级、设备时序、长轮询唤醒与超时、参数校验、网关存活登记与超期判定、看板页面可开。

## 云根回传与冲突裁决

店根先本地提交，再异步回传（outbox 游标 `syncedSeq`）。三条不可妥协：

1. **不跳过**：云根 409 时游标停在冲突事件之前，不允许"跳过继续传"。
2. **不动资金账**：`money.settle` / `money.refund` / `member.points` 一律 `manual_pending`，`auto` 解析会返回 `400 manual_required`。
3. **未知类型保守**：未登记的事件类型按资金类处理，宁可人工复核。

库存类（`stock.dec` / `stock.inc` / `order.draft`）可自动放行；云根 5xx 视为可重试、游标不动。

## 定时回传与退避

配了 `EDGE_CLOUD_URL` 就自带后台循环（`src/scheduler.js`），不用人点按钮：

| 情形 | 行为 |
|---|---|
| 回传成功且有量 | 退避归位到基准 30s，`cloudOffline` 归零 |
| 可重试失败（5xx / 网络） | 失败计数 +1，退避 `30s→60s→…→15min` 封顶；连续 3 次置 `cloudOffline=1` |
| 云根 409 冲突 | **暂停回传**，等人工裁决；不累计失败次数，不刷屏 |
| 4xx 非冲突（参数/凭据） | 重试无意义，直接退到最慢档 15min |

所有定时器 `unref()`，不会拖住进程退出；`status()` 可随时观察 `paused / backoffMs / fails / last`。冲突全部处理完后自动恢复。每次 tick 先跑一次下行拉取，再跑上行回传——下行失败只记在 `last.pull`，不参与上行退避、不改 `cloudOffline`。

## 下行读模型（商品/价格）

云根是商品与价格的权威，店根只做增量跟随。契约：

```
GET {cloud}/cloud/catalog?since=<catalogSeq>
→ { cursor, items: [{ sku, name, price, status: 'on'|'off'|'deleted', updatedAt }] }
```

| 字段 | 说明 |
|---|---|
| `price` | 整数，单位**分**（避免浮点误差） |
| `status` | `on` 可售 / `off` 下架 / `deleted` 从店根移除 |
| `cursor` | 云根游标；缺省时取本批最大 `updatedAt`，且永不回退 |

落库规则：

1. **整批落库后才推进游标**——失败绝不跳批（与上行同一条红线）。
2. **重复下发幂等**：内容完全相同则 `unchanged`，不写事件，不刷事件流。
3. **事件化**：有变化才写 `catalog.upsert` / `catalog.delete` 并 `bumpVersion`，端壳通过 `/edge/snapshot?since=` 增量拿到全量读模型。

## 冲突复核运营页

`GET /edge/ui/conflicts`（或 `GET /edge/ui` 自动跳转）：打开即用，无需构建、无外部依赖。

- 顶部填 `EDGE_TOKEN` → 「保存」写入 `localStorage`，之后每 4 秒自动刷新。
- 每行给出三个动作：**按云根为准**（accept）/ **作废**（reject，二次确认）/ **自动放行**（auto）。
- 资金类（`money.*` / `member.points` / 未知类型）的「自动放行」按钮直接禁用，避免误点；服务端也会再拒一次（`400 manual_required`）。
- 页面本身不鉴权（浏览器导航带不了 `Authorization`），页内调用的 `/edge/health`、`/edge/conflicts` 仍需 token。

## IoT 数据面（只读）

设备 → 网关 → `POST /iot/ingest` → SQLite（`iot_device` / `iot_metric_latest` / `iot_event`）→ 端壳看板。
本期只做采集与展示，**不提供控制闭环**：适配器不声明 write，`iot.write` 仍返回 `E_UNSUPPORTED`。

| 规则 | 说明 |
|---|---|
| 批量幂等 | 同一 `idem` 重放只计 `replayed`，不重复写事件；落库键带 `gatewayId` 前缀，多网关不撞车 |
| 旧值不冒充在线 | 设备 `last_seen` 超过 `staleAfterMs`（默认 60s）时，读侧把状态与指标质量降级为 `stale` |
| 事务边界 | 设备台账与事件在同一事务内落库；任一步失败整批回滚 |
| 长轮询 | 有增量立即返回，无增量挂起至 `wait` 超时；`cursor` 即 `iot_event.seq` |

### 网关运维面

- `POST /iot/heartbeat` 可带 `gateway` 状态快照（版本、profile 数、积压、失败、最后错误）；店根单独记 `iot_gateway`，不混进设备事件流。
- `GET /iot/gateways` 返回最后心跳、版本、名下设备在线数；超过 90s 未心跳判离线。只 ingest 不心跳的旧网关也会登记。
- 设备与网关分开判定：设备默认 60s 超期、网关 90s 离线，避免网关进程挂掉后设备继续“在线”。
- 看板顶部显示 `网关 在线/总数`；全部网关离线时提示「采集网关离线，设备数据可能停更」。

网关是独立进程（串口/BLE/MQTT 原生依赖不进店根）：

```bash
cd iot-gateway
EDGE_TOKEN=dev-token npm start   # 默认 fixture 假设备，5s 一轮
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `IOT_EDGE_URL` | `http://127.0.0.1:7321` | 店根地址 |
| `IOT_EDGE_TOKEN` | `EDGE_TOKEN` | 店根鉴权 |
| `IOT_GATEWAY_ID` | `gw-local` | 网关标识（写入事件幂等键与设备来源） |
| `IOT_PROFILES_DIR` | `./profiles` | 型号 profile 目录 |
| `IOT_SPOOL` | `./iot-spool.ndjson` | 离线 spool；店根不可达时先落盘再重投 |
| `IOT_FIXTURE_INTERVAL_MS` | `5000` | fixture 发数间隔（真实适配器忽略） |
| `IOT_HEARTBEAT_MS` | `30000` | 网关心跳间隔；店根 90s 未收到即判网关离线 |
| `IOT_MQTT_CONFIG` | 空 | 非空时改用 MQTT 订阅源（配置示例 `iot-gateway/config/mqtt.example.json`），不再启动 fixture |
| `IOT_VENDOR_CONFIG` | 空 | 非空时改用厂商云 HTTP 轮询源（配置示例 `iot-gateway/config/vendor.example.json`）；优先级低于 MQTT |

profile 契约见 [`iot-gateway/schema/profile.schema.json`](../iot-gateway/schema/profile.schema.json) 与示例 `retail.scanner.v1` / `retail.sensor.v1` / `retail.gate.v1` / `retail.badge.v1`：新增型号只加 profile + fixture，不改网关代码。网关监听 `profiles/` 目录热加载，坏文件不会替换当前映射；移除 profile 后对应设备的后续事件会被拦下，并在 `lastProfileReload.unmapped` 中可见。

### MQTT 只读接入

裁决：**自研零依赖最小 MQTT 3.1.1 订阅端**，不引入第三方库，也不并行实现“厂商 broker 推 HTTP”。

- 只用订阅：CONNECT / SUBSCRIBE / PUBLISH（QoS 0-1）/ PING，支持 TCP/TLS、断线重连与重新订阅；QoS 2 直接拒绝。
- worker 不 publish，不做控制；MQTT 只作为采集入口，`iot.write` 语义不变。
- 固定 topic 映射在 `IOT_MQTT_CONFIG` 的 `topics` 中声明（`topic` / `deviceId` / `metric` 或 `metrics` / `field` / `units`），新增设备不改代码。
- retained 消息标记 `quality: degraded`，不把 broker 缓存的旧值伪装成实时；载荷自带 `at`/`ts` 时按时效判定超期。
- 传感器丢一个采样可接受（下一采样会补齐），因此不实现 QoS 2。

### 厂商云 HTTP 轮询（Wave3）

保持零依赖：配置文件 `IOT_VENDOR_CONFIG`，worker 只做只读查询，不调用任何控制接口。

| 字段 | 说明 |
|---|---|
| `pollMs` / `timeoutMs` | 轮询间隔与单次请求超时（默认 30s / 10s） |
| `devices` | 本地设备，`vendorId` 对应厂商返回的设备 id；显式 `profile` 决定指标类型 |
| `sources[].url` / `method` | `GET` 或 `POST`（POST 用于只读查询体） |
| `sources[].tokenEnv` | 从环境变量取 Bearer token，不落配置文件 |
| `sources[].headers` | 自定义头，支持 `${ENV_VAR}` 展开 |
| `sources[].itemsPath` | 返回体里的设备数组路径；省略时按根数组解析 |
| `sources[].deviceField` / `atField` | 厂商 id 与时间字段；时间支持毫秒、秒与 ISO 字符串 |
| `sources[].metrics` | 本地指标 → 厂商字段路径；省略时直接读条目的 `metrics` 对象 |

- 多个 source 逐个拉取、互不拖累：一个失败只记 `lastError`，其余继续采；恢复后自动回到正常。
- 指标值仍由 gateway 按 profile 校验，单位取 profile；厂商没给时间时用采集时刻。
- 设备停更由店根 `staleAfterMs` 判超期，不靠轮询接口自报在线。

### 只读看板

`GET /edge/ui/iot`：与冲突复核页同源，打开即用，无需构建、无外部依赖。

- 顶部填 `EDGE_TOKEN` → 「保存」写入 `localStorage`，与冲突页共享同一份 token。
- 左列设备卡片：在线 / 超期 / 离线，最近活动时间与最新指标速览。
- 右列详情：指标卡（质量 `good` / `stale` 标注）、最近事件、数值指标近 15 分钟时序图。
- 事件通过 `/iot/stream` 长轮询实时刷新，另有 5 秒定时刷新覆盖心跳状态。
- 页面只读：没有开锁、打印、下发等控制按钮；页面本身免鉴权，页内数据接口仍需 token。

## 尚未做

- **云根侧接口**：`/cloud/events`（上行）与 `/cloud/catalog`（下行）需云根按同契约实现（幂等 + 409 冲突体 `{seq, reason}`）

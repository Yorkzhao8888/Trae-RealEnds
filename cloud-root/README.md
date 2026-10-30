# cloud-root — 云根参考实现

店根（`../edge-store/`）已经按契约在调 `/cloud/events` 与 `/cloud/catalog`。本目录是**应答方**：零依赖 Node 服务，用来联调、给部署团队当契约样板——**不是生产实现**（没有真实鉴权、多租户、审计与限流）。

契约见 [docs/shell-contract.md](../docs/shell-contract.md) §10。

## 启动

```bash
CLOUD_TOKEN=dev-token npm start
# → http://0.0.0.0:7331 token=on
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CLOUD_PORT` | 7331 | 监听端口 |
| `CLOUD_HOST` | 0.0.0.0 | 监听地址 |
| `CLOUD_TOKEN` | 空 | 非空时要求 `Authorization: Bearer <token>`（仅 `/cloud/*`） |
| `CLOUD_ADMIN_TOKEN` | 空 | 建租户等管理接口所需（`PUT /store/tenants/:id`） |
| `CLOUD_DB` | ./cloud.db | 本地库路径（Node 24 内置 SQLite） |

## API

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/cloud/events` | 上行接收 `{storeId, cursor, events[]}`：幂等、冲突即 409 |
| GET | `/cloud/catalog?since=` | 下行商品/价格增量 `{cursor, items[]}` |
| POST | `/cloud/catalog` | 管理：批量写商品（`{items:[...]}`） |
| POST | `/cloud/stock` | 管理：设云根库存（`{sku, onHand}`） |
| GET | `/cloud/events?storeId=` | 观测：某店已接收事件（调试） |
| GET | `/cloud/health` | 存活 |

商店 M1（授权与租户，见 [../btos-app-store/README.md](../btos-app-store/README.md#m1-授权与租户最小实现)）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/store/entitlements` | 座位/门店配额、品牌授权、有效期 |
| POST | `/store/activate` / `/store/deactivate` | 设备占座/退座（幂等） |
| POST | `/store/stores`；DELETE `/store/stores/:id` | 门店注册/注销（受配额） |
| PUT | `/store/tenants/:id` | 管理：建租户与配额（需 `CLOUD_ADMIN_TOKEN`） |

## 上行规则（对应店根的三条红线）

1. **幂等**：主键 `(store_id, seq)`，重传只计 `replayed`，不重复扣减。
2. **不跳过**：遇到冲突就在冲突事件之前停下——前序事件照常落库，409 带 `seq` 与 `reason`，游标停在已应用的最后一条。
3. **冲突判定**（云根权威）：
   - `stock.dec` 超过云根库存 → 409 `库存不足`（带 `onHand`）
   - `money.settle` 的 `expected` 与实际 `amount` 不符 → 409 `对账不符`
   - 其他类型只记账，不判冲突

## 与店根对接

```bash
# 店根侧：配了云根地址即自动双向（先拉后传）
EDGE_CLOUD_URL=http://127.0.0.1:7331 EDGE_CLOUD_TOKEN=dev-token EDGE_TOKEN=dev-token npm start
```

之后：店内成交在 `/edge/commit` 落库 → 后台回传 `/cloud/events`；云根商品经 `/cloud/catalog` 增量下发到店根，端壳从 `/edge/snapshot` 拿到 `catalog.upsert` / `catalog.delete` 事件。

冲突产生后，用店根运营页 `http://<店根>:7321/edge/ui/conflicts` 裁决。

## 测试

```bash
npm test
```

12 项：鉴权与健康、幂等重传、库存冲突停在冲突点、对账冲突、商品游标与删除；商店 M1 的租户配额与品牌授权、占座上限与幂等、门店配额、过期拦截、管理接口鉴权；再加两项**真端到端**——店根租约+扣减+回传打到这里，云根商品再下行回店根；以及库存冲突 → 运营裁决 → 游标越过冲突。

## 与生产云的差距

参考实现只覆盖契约本身。真正上线还需：OAuth/租户鉴权、按店与按设备的限流、事件审计留痕、catalog 批量发布与版本回滚、跨店库存归集、可观测（trace/指标）。

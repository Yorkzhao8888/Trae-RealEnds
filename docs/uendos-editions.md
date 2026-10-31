# UendOS 版本档位与能力矩阵（v0.3.2）

同一套云根、同一套壳代码，按 `profile` 裁剪端能力与默认产物。回答一个产品问题：**壳 App 能不能出轻量版、简洁版，甚至比云根端功能更多的版本？**

可以，但版本差异是**构建期策略**，不是业务分叉，也不是权限边界。

---

## 1. 先把“功能”拆层

| 层 | 内容 | 版本策略 |
|---|---|---|
| 云根 | 业务规则、价格、库存、权限、租户/门店配额 | 不按端分叉，始终唯一真源 |
| 店根 | 门店本地库存、离线交易、租约、对账 | 只进增强版 |
| 端壳 | 推送、相机/扫码、生物识别、文件、离线队列、硬件对接 | 按档位裁剪 |
| 端策略 | 入口编排、角色视图、主题、更新通道 | 按档位配置 |

「比云根端更多功能」只在端侧成立：NFC、蓝牙打印、离线收银、摄像头采集可以比云端 Web 多；业务规则不能多，否则出现第二真源。

---

## 2. 三档定义

| 档位 | 定位 | 默认 target | 允许 target | 端能力 |
|---|---|---|---|---|
| `lite` 轻量版 | 顾客、访客、临时工 | `app` | `app` | 9/18 |
| `standard` 标准版（简洁版） | 常规员工 | `app/pc` | `app/pc/mp` | 16/18 |
| `pro` 增强版 | 门店、仓、收银 | `app/pc/mp` | `app/pc/mp` | 18/18 |

```bash
# 轻量版：默认只出 App
uendos init acme-lite --brand acme --ends "hp:个人端:https://hp.acme.example.com/" \
  --profile lite --dir ./acme-lite

# 标准版：默认 App + PC
uendos init acme-std --brand acme --ends "..." --profile standard --dir ./acme-std

# 增强版：默认三端全出
uendos init acme-pro --brand acme --ends "..." --profile pro --dir ./acme-pro

# 查看档位与能力集
uendos profile [--json]
```

规则：

- 不传 `--profile` 时按 `pro` 校验，但默认 target 仍为 `app`（兼容旧工程）。
- `lite` 只允许 `app`；`standard/pro` 允许 `app/pc/mp`。
- `launchMode` 默认 `portal`；三档都可显式改为 `launcher`（launcher 的原生兼容性仍按接入指南第 6 节真机验证）。
- `profile` 会写入 `uendos.config.json`，`doctor` 会校验档位与 target 是否匹配。

---

## 3. 能力矩阵

| 能力 | lite | standard | pro |
|---|:---:|:---:|:---:|
| `vibrate` 震动 | ✓ | ✓ | ✓ |
| `share` 分享 | ✓ | ✓ | ✓ |
| `geolocation` 定位 | ✓ | ✓ | ✓ |
| `statusBar` 状态栏 | ✓ | ✓ | ✓ |
| `splash` 启动图 | ✓ | ✓ | ✓ |
| `backButton` 返回键 | ✓ | ✓ | ✓ |
| `openExternal` 外链 | ✓ | ✓ | ✓ |
| `network` 网络状态 | ✓ | ✓ | ✓ |
| `safeArea` 安全区 | ✓ | ✓ | ✓ |
| `push` 推送 | — | ✓ | ✓ |
| `haptics` 触感 | — | ✓ | ✓ |
| `files` 文件 | — | ✓ | ✓ |
| `camera` 相机/扫码 | — | ✓ | ✓ |
| `biometric` 生物识别 | — | ✓ | ✓ |
| `offlineQueue` 离线队列 | — | ✓ | ✓ |
| `deeplink` 深链 | — | ✓ | ✓ |
| `subscribeMsg` 订阅消息 | — | — | ✓ |
| `edge.storeRoot` 店根 | — | — | ✓ |

说明：

- 表中“能力”是壳声明的上限；实际运行值仍由 `Shell.capabilities` 按环境计算（如 Web 环境为 `web`）。
- `lite` 不声明推送/相机/店根，业务页不应依赖；即便调用也会按运行时返回 `E_UNSUPPORTED` 或降级。
- `standard` 的 `mp` 模板可加，但小程序没有 Capacitor 能力，`subscribeMsg` 不计入标准版。

---

## 4. 边界：profile 不是权限

- **构建期**：决定出哪些 target、默认启动方式、品牌资源与文档能力集。
- **运行期**：`Shell.capabilities` 按环境探测；profile 不改变原生能力。
- **权限**：必须由云根按租户、角色、门店校验。客户端版本号可被改装，不能当授权依据。
- **计费/配额**：云根统一管理，不按 App 版本发额度。

一句话：**profile 管“这个包带什么”，云根管“这个人能做什么”。**

---

## 5. 分发策略

| 场景 | 建议 |
|---|---|
| 同渠道、角色差异 | 一个包 + 角色视图/服务端 entitlement，不拆包 |
| 顾客端与员工端权限差异大 | 拆两个包（lite / standard） |
| 门店需要离线与硬件 | 单独 `pro` 包，配店根 |
| 企业内分发 vs 应用商店 | 同代码，按签名与通道区分，不另起分支 |
| 品牌差异 | 同档位复制配置，品牌桥由 `sync` 生成，不复制业务代码 |

版本数量控制在 3 档以内。每增加一档，测试矩阵、签名、上架、客服成本都会上升。

---

## 6. 升级路径

- 配置向前兼容：`profile` 与 `launchMode` 都是可选字段，旧配置可继续用。
- 数据兼容：`endKey`、离线队列键、登录态不随档位变化；升级只换包，不清数据。
- 能力升级：`lite → standard` 需要补推送证书/权限声明；`standard → pro` 需要店根地址、租约与对账配置。
- 回滚：保留上一版签名包与清单条目，`publish --status beta` 灰度后再放开。

---

## 7. 验证与 CI

```bash
# 每个档位单独冒烟
uendos doctor --offline        # 含档位与 target 校验
uendos conformance             # 39/39
uendos sync --check

# 能力边界（真机）
# 业务页探针读取 Shell.capabilities，确认 lite 不含 push/camera/edge.storeRoot
```

接入指南中的探针页可直接复用：[开发者接入指南 v0.3.1 · 第 6 节](./uendos-dev-onboarding-v0.3.1.md)。

---

## 8. 反模式

- 为“简洁”复制一份 H5 业务代码；
- 端上新增云端没有的计价/审批规则；
- 用 `profile` 当权限开关；
- 每档维护一套打包脚本；
- 同一渠道为每个角色拆一个包。

---

## 9. 版本记录

- **v0.3.2**：新增 `profile`（`lite/standard/pro`）、`uendos profile` 命令、`init --profile` 默认 target/启动模式、`doctor` 档位校验；测试 16/16。
- v0.3.1：一键出包、`--release` 签名、launcher 多端启动、品牌图标。

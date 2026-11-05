# UendOS v0.6 规划：插件生态、工程升级、发布闭环与运行时深化

承接 [v0.5 方案](./uendos-v0.5-plan.md)。v0.5 已把 L2 的「配置 + 主题 + 插件 + 能力白名单」收口；v0.6 继续把**开发者真正用得上的四条链路**补齐：

1. 插件能自己写、能锁版本、能声明依赖（不再是 SDK 内部 fixture）。
2. 老工程能一键升到新契约，不用手工比对产物。
3. 发布产物有清单、PC 更新有 `latest.yml`、上架前可校验。
4. 运行时把离线队列与事件补齐（风险最高，放最后）。

红线不变：壳不做业务；插件只构建期嵌入，禁止运行时远程加载；`caps` 是裁剪不是权限边界；桥协议 `BRIDGE_VERSION` 不轻易变。

## 1. 里程碑与顺序

| 里程碑 | 内容 | 主要风险 | 验收标准 |
|---|---|---|---|
| M1 插件生态闭环（已实现） | `plugin init` 脚手架、`uendos.plugins.lock`、`requires` 依赖与拓扑激活、锁校验进 `doctor`/`sync --check` | 低（纯 CLI/契约） | 脚手架产物通过自身 `validatePluginManifest`；新工程 `plugin init → 安装 → add → conformance` 全过；改插件运行时后 `sync --check` 必须失败 |
| M2 老工程升级（已实现） | `uendos upgrade`（迁移配置版本 + 备份 + 重生成 + 回归）、`uendos diff`（配置/产物/插件锁差异） | 中（要兼容历史配置） | 无 `caps`/`theme` 的旧工程 `upgrade` 后 `doctor`/`conformance`/`sync --check` 全过；`--check` 只报差异不改文件 |
| M3 发布与真机闭环（已实现） | `pack` 产物清单（`release/MANIFEST.json`：版本/大小/SHA-256/签名态）、PC `latest.yml` 自动生成、`publish --verify` 校验清单、`doctor --release-check` | 中（依赖证书的部分仍受外部阻塞） | 出包后清单与实物哈希一致；`publish` 拒绝哈希不符；无证书时明确标注「未签名」而非静默通过 |
| M4 运行时深化（已实现） | 离线队列持久化（重启不丢、容量上限、版本迁移）、`shell:queue-restored` 恢复上报、`Shell.events.recent` 事件回看、桥能力扩展评估（本阶段保持 bridge=3） | 高（触及 `shell-core` 与四品牌桥） | 重启后离线队列可继续重放且不重复；四品牌桥 `build.mjs --check` 一致；`conformance` 不退化（39 → 44） |
| M5 `0.6.0` 发版（已实现） | 版本/契约升 `0.6.0`、文档收口、四品牌桥重建、分发包与 Release | 全新解压 `npm ci && npm test` 全绿；`init → doctor --offline → conformance 44/44 → sync --check` 全过；包内 `check-core` 一致 |

顺序理由：M1/M2 只动 SDK 层，先落地；M3 依赖真实产物与证书，能做的先做、做不了的显式标注；M4 改共享运行时，放最后单独评审；M5 统一发版。

## 2. M1：插件生态闭环

### 2.1 `uendos plugin init <包名>`

在工程内生成一个可直接安装的插件包：

```
plugins/<短名>/
├── package.json          # 包名 / 版本 / files
├── uendos.plugin.json    # id / version / runtime / asserts / env / capabilities / methods
├── runtime.js            # 返回 { version, capabilities, methods }
└── conformance.mjs       # 默认导出断言数组
```

- 默认能力名由短名推导（`@acme/uendos-plugin-printer` → `printer`），可用 `--capability` 覆盖。
- 生成前用 `validatePluginManifest` 自检，不合法直接拒绝写盘。
- 不自动改 `uendos.config.json`：插件必须先安装，`plugin add` 才落配置。
- 输出下一步：`npm install ./plugins/<短名> --save-exact` → `uendos plugin add <包名>` → `doctor` / `conformance`。

### 2.2 `uendos.plugins.lock`

```json
{
  "version": 1,
  "plugins": {
    "@acme/uendos-plugin-printer": {
      "version": "0.1.0",
      "integrity": "sha256-…",
      "env": ["capacitor", "electron", "web"],
      "capabilities": ["printer"],
      "methods": ["printer.ping", "printer.status"],
      "requires": ["@acme/uendos-plugin-core"]
    }
  }
}
```

- `integrity` 是插件 `runtime` 内容的 SHA-256，防止「锁了版本但代码被换掉」。
- `plugin add` / `remove` / `update` 与 `sync` 负责生成；`sync --check`、`doctor` 负责校验。
- 锁缺失或多出、版本漂移、运行时哈希不符 → `sync --check` 失败；`doctor` 逐条报错。
- 配置没有插件时不生成锁文件；从有插件改到无插件时删除旧锁。

### 2.3 插件依赖 `requires`

- manifest 新增可选键 `requires`：插件包名数组，不能引用自身、不能重复。
- `resolvePlugins` 做拓扑排序：依赖先注册；依赖未配置、或存在环 → 直接失败并给出链。
- `plugin remove` 若被其他已配置插件依赖 → 拒绝并列出依赖方。
- `plugin list` 展示依赖；`--json` 增加 `requires` 与 `locked` 字段。

### 2.4 测试

- 脚手架：生成 → 自检 → 装入 `node_modules` → `plugin add` → `conformance` 全过。
- 锁：`plugin add` 后有锁；篡改 runtime 后 `sync --check` 失败；恢复后通过。
- 依赖：逆序配置仍按依赖顺序注册；缺依赖与环依赖分别报错；被依赖时禁止移除。

## 3. M2：老工程升级

- `uendos upgrade [--check]`：
  1. 读配置 → 备份 `uendos.config.json` 为 `.bak`（仅实际改写时）；
  2. 把 `contractVersion` 补/升到当前版本，缺 `schemaVersion` 时补齐；
  3. 重新 `sync`（含插件锁），跑 `doctor --offline` 的静态项；
  4. 列出未识别的历史键，提示人工确认，不静默删除。
- `uendos diff`：只读比对「配置期望 vs 现有产物」与「插件锁 vs 实装」，以 `+/-` 行输出；`--json` 供 CI。

## 4. M3：发布与真机闭环

- `pack` 成功后写 `release/MANIFEST.json`：`target/version/artifact/size/sha256/signed/signer`。
- `pack --target pc` 输出 `latest.yml`（版本、文件名、sha512、releaseDate），`doctor --release-check` 校验与 `MANIFEST.json` 同版本。
- `publish --verify`：安装包哈希/大小必须与清单一致；清单缺失 → 拒绝（除非显式 `--allow-unlisted`）。
- 证书缺失时不在清单里造「已签名」，统一写 `signed: false` 并给出原因。

## 5. M4：运行时深化

- 离线队列持久化：`localStorage` 键按品牌作用域 `shell:offline-queue:<prefix>`，版本化信封 `{v:1,items:[]}`，容量上限 200 条淘汰最旧；兼容旧裸数组一次性迁移；启动恢复非空队列时派发 `shell:queue-restored`（不自动重放，重放仍由 `offline.flush` / 联网事件触发，幂等键保证不重复）。
- 事件回看：`Shell.events.recent([event], [limit=20])` 内存环形缓冲最近 50 条事件，供调试与断线对账；只读、不落盘、不自动重放，不改变 `on()` 的即时派发语义。
- 桥能力扩展：评估 `BRIDGE_VERSION=4`；本阶段保持 `3`，握手字段不变，旧端零改动。

## 6. 风险与对策

- **锁文件引发 CI 失败**：首次升级工程需跑一次 `sync` 生成锁；文档与报错文案都给明确下一步。
- **插件本地开发**：推荐 `npm install file:`，锁记录的是内容哈希而非来源，允许本地迭代后重新 `sync`。
- **依赖成环**：拓扑排序前置检测，报错给出完整链，避免运行期才发现。
- **升级误删配置**：`upgrade` 只补版本与已知字段，未知键原样保留并列出。
- **运行时改动**：M4 单独评审，先补 conformance 断言再改 `core.js`，四品牌桥重建后跑一致性校验。

## 7. 版本记录

- **v0.6 M1（已实现，2026-11-04）**：`plugin init` 脚手架、`uendos.plugins.lock`（版本 + 运行时 SHA-256，`sync --check` / `doctor` 校验）、manifest `requires` 依赖拓扑注册、`plugin remove` 依赖保护、`plugin list` 增加依赖与锁状态；契约 §23；测试 30/30。
- **v0.6 M2（已实现，2026-11-04）**：`uendos upgrade`（补/升 `schemaVersion` 与 `contractVersion`，备份 `.bak`，重生成产物与锁，保留未知键）、`uendos upgrade --check`（只读报告，退出码 1）、`uendos diff [--json]`（产物 `-`/`+` 行与插件锁差异）；测试 31/31。
- **v0.6 M3（已实现，2026-11-04）**：`pack` 写 `release/MANIFEST.json`（多 target 累积、产物 SHA-256、签名态如实标注）、PC 缺省时补 `latest.yml`（sha512/size/releaseDate，electron-builder 已生成则跳过）、`publish --verify`、`doctor --release-check`；测试 32/32。
- **v0.6 M4（已实现，2026-11-05）**：离线队列按品牌作用域存储（`shell:offline-queue:<prefix>`，版本化信封，旧数组迁移）、启动派发 `shell:queue-restored`、`Shell.events.recent` 事件回看；契约 §24；conformance 内置断言 39 → 44；四品牌桥重建一致，测试 32/32。
- **v0.6 发版（已实现，2026-11-05）**：版本/契约/内核统一升 `0.6.0`（`BRIDGE_VERSION` 保持 `3`），四品牌桥与 3 个 preload 重建；分发包 `BTOS-UendOS-SDK-0.6.0.zip`（214,427 B）/ `.tar.gz`（173,091 B）已生成并解压实测（`npm ci && npm test` 32/32、`init → doctor --offline → conformance 44/44 → sync --check` 全过）；GitHub Release 待推送。

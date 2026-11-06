/**
 * @uendos/contract — UendOS 壳契约（唯一真相的机读版）
 *
 * 与 docs/shell-contract.md 对齐。运行时（@uendos/shell）与一致性测试
 * （@uendos/conformance）都以本文件为准；改契约先改这里，再改实现。
 */

export const CONTRACT_VERSION = '0.7.0';
export const SCHEMA_VERSION = 1;

/** 能力矩阵：键名固定，值由运行时按环境计算（✓ / ◐ / ─ / web） */
export const CAPABILITIES = [
  'vibrate',
  'share',
  'geolocation',
  'push',
  'haptics',
  'statusBar',
  'splash',
  'backButton',
  'openExternal',
  'deeplink',
  'network',
  'safeArea',
  'files',
  'camera',
  'biometric',
  'offlineQueue',
  'subscribeMsg',
  // 安全存储：原生 Keychain/Keystore ✓；内存降级 ◐；禁止凭证落 localStorage
  'secureStore',
  // 设备身份：默认 none；配置 security.identity 后可用，令牌只存 secureStore
  'identity',
  // IoT 总开关；iot.ble / iot.serial / iot.mqtt / iot.nfc 由适配器插件声明
  'iot',
  'edge.storeRoot',
];

/** 核心方法：所有壳必须实现，缺一即视为不合格 */
export const CORE_METHODS = [
  'core.handshake',
  'core.capabilities',
  'core.ready',
  'core.statusBar',
  'core.splash',
  'core.vibrate',
  'core.share',
  'core.location',
  'core.openExternal',
  'core.push.request',
  'core.push.token',
  'core.net',
  'core.end',
  'core.switchEnd',
];

/** 可选方法：按能力矩阵可用，缺失时返回 E_UNSUPPORTED，不得抛异常 */
export const OPTIONAL_METHODS = [
  'offline.enqueue',
  'offline.flush',
  'offline.list',
  'edge.configure',
  'edge.health',
  'edge.lease',
  'edge.commit',
  'edge.snapshot',
  'iot.devices',
  'iot.read',
  'iot.write',
  'entry.open',
  'secure.get',
  'secure.set',
  'secure.remove',
  'identity.current',
  'identity.refresh',
];

/** 安全存储后端：memory 为 Web/小程序降级，其余由构建期原生适配器提供 */
export const SECURE_BACKENDS = ['keychain', 'keystore', 'native', 'memory'];
export const SECURE_MAX_VALUE = 8192;
export const SECURE_KEY_PREFIX = '<brand>:<purpose>';

/** 设备身份（v0.8 M2）：默认 none；device 模式令牌只存 secureStore，不暴露给 H5 */
export const IDENTITY_MODES = ['device', 'none'];
export const IDENTITY_KEYS = ['mode', 'endpoint', 'storeKey'];
export const IDENTITY_STORE_PURPOSE = 'identity.device';
export const IDENTITY_SOURCE = 'device';

/** 插件与产物完整性（v0.8 M3）：签名文件、信任链与发布清单签名态 */
export const PLUGIN_SIG_ALG = 'ed25519';
export const PLUGIN_SIG_FILE = 'uendos.plugin.sig';
export const TRUSTED_FILE = 'uendos.trusted.json';
export const PLUGIN_SIG_VERSION = 1;
export const RELEASE_SIGNATURE_STATES = ['signed', 'unsigned', 'dev'];

/** 更新通道（v0.8 M4）：stable / beta 各自独立指针与灰度，互不影响 */
export const UPDATE_CHANNELS = ['stable', 'beta'];
export const UPDATE_CHANNEL_DEFAULT = 'stable';

/** 预留的 IoT 适配器能力 ID：由构建期插件声明，核心只提供 iot 总开关 */
export const IOT_TRANSPORT_CAPABILITIES = ['iot.ble', 'iot.serial', 'iot.mqtt', 'iot.nfc'];

/** IoT 事件信封 v1：所有 shell:iot-* 事件的 data 都必须满足该形状 */
export const IOT_EVENT_VERSION = 1;
export const IOT_EVENT_KEYS = [
  'v',
  'deviceId',
  'kind',
  'metric',
  'value',
  'unit',
  'at',
  'seq',
  'idem',
  'quality',
  'source',
];

/** 契约事件：全部带 { event, seq, at, data } */
export const EVENTS = [
  'shell:ready',
  'shell:resume',
  'shell:pause',
  'shell:end-changed',
  'shell:network',
  'shell:deeplink',
  'shell:queued',
  'shell:queue-replayed',
  'shell:queue-failed',
  'shell:queue-drained',
  'shell:iot-device',
  'shell:iot-data',
  'shell:iot-ack',
  'shell:iot-error',
  'shell:identity-changed',
  'shell:identity-expired',
];

/** 稳定错误码：H5 只能按 code 分支，不得依赖 message 文案 */
export const ERRORS = {
  E_BAD_ARGS: '参数不合法',
  E_UNSUPPORTED: '当前壳/环境不支持该能力',
  E_DENIED: '用户拒绝授权',
  E_NATIVE: '原生调用失败',
  E_EDGE: '店根返回业务错误',
  E_EDGE_OFFLINE: '店根不可达（可回落离线队列）',
  E_STOCK: '库存不足（店根 stock）',
  E_LIMIT: '额度/限购（店根 limit）',
  E_LEASE: '租约失效或不存在（lease_expired / lease_unknown）',
  E_NOT_FOUND: '资源不存在',
};

export const TARGETS = ['app', 'pc', 'mp', 'web'];

const LITE_CAPS = ['vibrate', 'share', 'geolocation', 'statusBar', 'splash', 'backButton', 'openExternal', 'network', 'safeArea'];

/**
 * 版本档位：同一套云根与壳代码，按档位裁剪「端能力 + 默认产物」。
 * 注意：profile 是构建期策略，不是权限边界；权限必须由云根按租户/角色校验。
 */
export const PROFILES = {
  lite: {
    label: '轻量版',
    targets: ['app'],
    allowedTargets: ['app'],
    launchMode: 'portal',
    capabilities: LITE_CAPS,
  },
  standard: {
    label: '标准版',
    targets: ['app', 'pc'],
    allowedTargets: ['app', 'pc', 'mp'],
    launchMode: 'portal',
    capabilities: [...LITE_CAPS, 'push', 'haptics', 'files', 'camera', 'biometric', 'offlineQueue', 'deeplink'],
  },
  pro: {
    label: '增强版',
    targets: ['app', 'pc', 'mp'],
    allowedTargets: ['app', 'pc', 'mp'],
    launchMode: 'portal',
    capabilities: [...CAPABILITIES],
  },
};

export const PROFILE_NAMES = Object.keys(PROFILES);

/**
 * 主题：只作用于壳自有页面（选择页 / 启动兜底 / 错误页），远程 H5 不强制套用。
 * tokens 是 CSS 变量的唯一来源，客户端不用改 HTML。
 */
export const THEME_MODES = ['light', 'dark'];
export const THEME_TOKEN_KEYS = ['accent', 'bg', 'surface', 'ink', 'inkMuted', 'line', 'radius', 'fontScale'];

export const THEME_DEFAULTS = {
  light: { accent: '#4C8DFF', bg: '#FFFFFF', surface: '#F6F9FD', ink: '#0B1220', inkMuted: '#7B8AA0', line: '#E4E9F2', radius: 16, fontScale: 1 },
  dark: { accent: '#4C8DFF', bg: '#0E1218', surface: '#161C26', ink: '#E8EEF7', inkMuted: '#8A98AD', line: '#253041', radius: 16, fontScale: 1 },
};

/** 合并默认值，得到可直接下发的主题（accent 缺省回落到品牌主色） */
export function resolveTheme(theme, accent) {
  const mode = (theme && theme.mode) || 'light';
  const tokens = { ...(THEME_DEFAULTS[mode] || THEME_DEFAULTS.light), ...((theme && theme.tokens) || {}) };
  if (!(theme && theme.tokens && theme.tokens.accent) && accent) tokens.accent = accent;
  return { mode, tokens };
}

/**
 * 入口编排：只影响 launcher / 选择页，不改 portal 直进逻辑。
 * order 决定展示顺序（未列出的端按配置顺序追加）；groups 只做分组展示，
 * 未分组的端排在分组之后。
 */
export const ENTRY_KEYS = ['title', 'subtitle', 'rememberLast', 'order', 'groups', 'routes'];
export const ENTRY_DEFAULTS = {
  title: '选择你的身份',
  subtitle: '选择后进入对应工作台，可随时返回本页切换。',
  rememberLast: true,
};

/** 入口路由：id 稳定、path 站内相对、params 可校验、requires 可降级 */
export const ENTRY_ROUTE_KEYS = ['id', 'label', 'path', 'params', 'requires', 'fallback'];
export const ENTRY_PARAM_KEYS = ['type', 'required', 'enum', 'maxLength'];
export const ENTRY_PARAM_TYPES = ['string', 'number', 'boolean'];
export const ENTRY_SOURCES = ['launcher', 'deeplink', 'scan', 'nfc', 'notification', 'device'];

export function resolveEntry(cfg) {
  const ids = Object.keys(cfg.ends || {});
  const entry = cfg.entry || {};
  const order = Array.isArray(entry.order) ? entry.order.filter((id) => ids.includes(id)) : [];
  const ordered = [...order, ...ids.filter((id) => !order.includes(id))];
  const groups = (Array.isArray(entry.groups) ? entry.groups : []).map((g) => ({
    label: g.label,
    ends: (g.ends || []).filter((id) => ids.includes(id)),
  }));
  const grouped = new Set(groups.flatMap((g) => g.ends));
  return {
    title: entry.title || ENTRY_DEFAULTS.title,
    subtitle: entry.subtitle === undefined ? ENTRY_DEFAULTS.subtitle : entry.subtitle,
    rememberLast: entry.rememberLast !== false,
    order: ordered,
    groups,
    rest: ordered.filter((id) => !grouped.has(id)),
  };
}

const RE_URL = /^(https?:\/\/[^\s]+)$/;
const RE_BRAND = /^[a-z][a-z0-9-]{1,15}$/;
const RE_ENTRY_ID = /^[a-z][a-z0-9.-]{1,31}$/;
const RE_ROUTE_PATH = /^\/[^\s]*$/;
const RE_PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const RE_END_ID = /^[a-z]{2,4}$/;
const RE_ACCENT = /^#[0-9A-Fa-f]{6}$/;
const RE_PKG = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const RE_SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const RE_CAP = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;
const RE_PLUGIN_METHOD = /^[a-z][a-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const RE_SECURE_KEY = /^[a-z][a-z0-9-]*:[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/** 插件不得占用的内置命名空间 */
export const PLUGIN_RESERVED_NS = ['core', 'edge', 'offline', 'desktop', 'shell'];

export const PLUGIN_MANIFEST_KEYS = ['id', 'version', 'runtime', 'asserts', 'env', 'capabilities', 'methods', 'requires'];
export const PLUGIN_ENVS = ['capacitor', 'electron', 'mp', 'web'];

/**
 * 校验插件包根目录的 uendos.plugin.json。
 * 能力声明以插件包为唯一真相；与内置能力重名、方法越权命名空间一律拒绝。
 * @param {object} m
 * @param {{name?: string, profile?: string}} [opts]
 */
export function validatePluginManifest(m, opts = {}) {
  const errors = [];
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  if (!isObj(m)) return { ok: false, errors: ['插件声明必须是 JSON 对象'] };
  for (const k of Object.keys(m)) {
    if (!PLUGIN_MANIFEST_KEYS.includes(k)) errors.push(`插件声明不支持的键：${k}`);
  }
  if (typeof m.id !== 'string' || !RE_PKG.test(m.id)) {
    errors.push('插件 id 必须是合法 npm 包名（如 @acme/uendos-plugin-printer）');
  } else if (opts.name && m.id !== opts.name) {
    errors.push(`插件 id 与包名不一致：${m.id} != ${opts.name}`);
  }
  if (typeof m.version !== 'string' || !RE_SEMVER.test(m.version)) {
    errors.push('插件 version 必须是语义化版本（如 1.0.0）');
  }
  if (typeof m.runtime !== 'string' || !m.runtime.trim()) {
    errors.push('插件必须声明 runtime（浏览器侧脚本路径）');
  }
  if (m.asserts !== undefined && (typeof m.asserts !== 'string' || !m.asserts.trim())) {
    errors.push('插件 asserts 必须是非空路径字符串');
  }
  if (m.env !== undefined) {
    if (!Array.isArray(m.env) || m.env.some((e) => !PLUGIN_ENVS.includes(e))) {
      errors.push(`插件 env 只能是 ${PLUGIN_ENVS.join(' / ')} 的子集`);
    }
  }

  if (!Array.isArray(m.capabilities) || !m.capabilities.length) {
    errors.push('插件 capabilities 不能为空');
  } else {
    const seen = new Set();
    for (const cap of m.capabilities) {
      if (typeof cap !== 'string' || !RE_CAP.test(cap)) errors.push(`插件能力名不合法：${cap}`);
      else if (CAPABILITIES.includes(cap)) errors.push(`插件能力与内置能力重名：${cap}`);
      else if (PLUGIN_RESERVED_NS.includes(cap.split('.')[0])) errors.push(`插件能力不得占用内置命名空间：${cap}`);
      else if (seen.has(cap)) errors.push(`插件能力重复：${cap}`);
      else seen.add(cap);
    }
  }

  if (!Array.isArray(m.methods) || !m.methods.length) {
    errors.push('插件 methods 不能为空（至少要有一个可调用方法）');
  } else {
    const seen = new Set();
    for (const method of m.methods) {
      if (typeof method !== 'string' || !RE_PLUGIN_METHOD.test(method)) {
        errors.push(`插件方法名不合法：${method}`);
        continue;
      }
      const ns = method.split('.')[0];
      if (PLUGIN_RESERVED_NS.includes(ns)) errors.push(`插件方法不得占用内置命名空间：${method}`);
      else {
        // 能力可带点（如 iot.ble）：取最长前缀作为方法归属，避免多点能力被误判
        const owner = (m.capabilities || [])
          .filter((cap) => method.startsWith(cap + '.'))
          .sort((a, b) => b.length - a.length)[0];
        if (!owner) errors.push(`插件方法 ${method} 不在声明的能力命名空间内`);
      }
      if (seen.has(method)) errors.push(`插件方法重复：${method}`);
      else seen.add(method);
    }
  }

  if (m.requires !== undefined) {
    if (!Array.isArray(m.requires)) errors.push('插件 requires 必须是插件包名数组');
    else {
      const seen = new Set();
      for (const dep of m.requires) {
        if (typeof dep !== 'string' || !RE_PKG.test(dep)) errors.push(`插件 requires 包名不合法：${dep}`);
        else if (dep === m.id) errors.push('插件 requires 不能引用自身');
        else if (seen.has(dep)) errors.push(`插件 requires 重复：${dep}`);
        else seen.add(dep);
      }
    }
  }

  if (opts.profile === 'lite') errors.push('profile=lite 不允许插件（请升档或移除插件）');

  return { ok: errors.length === 0, errors };
}

/**
 * 校验 uendos.config.json。返回 { ok, errors }，errors 是可直接展示的中文文案。
 * @param {object} cfg
 * @param {{allowHttp?: boolean, capabilities?: string[]}} [opts] allowHttp 允许 http（仅限本地开发/内网店根）；
 *   capabilities 额外允许的能力名（插件能力），与当前档位能力合并后校验 caps.allow
 */
export function validateConfig(cfg, opts = {}) {
  const errors = [];
  const allowHttp = !!opts.allowHttp;
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  if (!isObj(cfg)) return { ok: false, errors: ['配置必须是 JSON 对象'] };

  if (cfg.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须为 ${SCHEMA_VERSION}（当前 ${cfg.schemaVersion}）`);
  }
  if (typeof cfg.brand !== 'string' || !RE_BRAND.test(cfg.brand)) {
    errors.push('brand 必须是小写字母开头、2–16 位的 a-z/0-9/-');
  }
  if (typeof cfg.displayName !== 'string' || !cfg.displayName.trim()) {
    errors.push('displayName 不能为空');
  }
  if (typeof cfg.alias !== 'string' || !/^[A-Za-z][A-Za-z0-9]{1,15}$/.test(cfg.alias)) {
    errors.push('alias 必须是 2–16 位的标识符（如 ziwayOS）');
  }
  if (typeof cfg.accent !== 'string' || !RE_ACCENT.test(cfg.accent)) {
    errors.push('accent 必须是 #RRGGBB');
  }
  if (typeof cfg.endKey !== 'string' || !cfg.endKey.trim()) {
    errors.push('endKey 不能为空（建议 <brand>.end）');
  }
  if (cfg.statusBarStyle && !['dark', 'light'].includes(cfg.statusBarStyle)) {
    errors.push('statusBarStyle 只能是 dark 或 light');
  }
  if (cfg.launchMode && !['portal', 'launcher'].includes(cfg.launchMode)) {
    errors.push('launchMode 只能是 portal 或 launcher');
  }
  if (cfg.profile) {
    const p = PROFILES[cfg.profile];
    if (!p) errors.push(`profile 只能是 ${PROFILE_NAMES.join(' / ')}`);
    else {
      for (const t of cfg.targets || []) {
        if (!p.allowedTargets.includes(t)) {
          errors.push(`profile=${cfg.profile} 不允许 target=${t}（允许：${p.allowedTargets.join('/')}）`);
        }
      }
    }
  }

  if (cfg.theme !== undefined) {
    if (!isObj(cfg.theme)) errors.push('theme 必须是对象');
    else {
      for (const k of Object.keys(cfg.theme)) {
        if (!['mode', 'tokens'].includes(k)) errors.push(`theme 不支持的键：${k}`);
      }
      if (cfg.theme.mode !== undefined && !THEME_MODES.includes(cfg.theme.mode)) {
        errors.push('theme.mode 只能是 light 或 dark');
      }
      if (cfg.theme.tokens !== undefined) {
        if (!isObj(cfg.theme.tokens)) errors.push('theme.tokens 必须是对象');
        else {
          for (const [k, v] of Object.entries(cfg.theme.tokens)) {
            if (!THEME_TOKEN_KEYS.includes(k)) { errors.push(`theme.tokens 不支持的键：${k}`); continue; }
            if (k === 'radius') {
              if (typeof v !== 'number' || v < 0 || v > 28) errors.push('theme.tokens.radius 必须是 0–28 的数字');
            } else if (k === 'fontScale') {
              if (typeof v !== 'number' || v < 0.9 || v > 1.2) errors.push('theme.tokens.fontScale 必须是 0.9–1.2 的数字');
            } else if (typeof v !== 'string' || !RE_ACCENT.test(v)) {
              errors.push(`theme.tokens.${k} 必须是 #RRGGBB`);
            }
          }
        }
      }
    }
  }

  if (!isObj(cfg.ends) || !Object.keys(cfg.ends).length) {
    errors.push('ends 至少要有 1 个端');
  } else {
    for (const [id, end] of Object.entries(cfg.ends)) {
      if (!RE_END_ID.test(id)) errors.push(`端 id 不合法：${id}（2–4 位小写字母）`);
      if (!isObj(end)) {
        errors.push(`端 ${id} 必须是对象`);
        continue;
      }
      if (typeof end.name !== 'string' || !end.name.trim()) errors.push(`端 ${id} 缺少 name`);
      if (typeof end.url !== 'string' || !RE_URL.test(end.url)) {
        errors.push(`端 ${id} 的 url 必须是 http(s) 绝对地址`);
      } else if (!allowHttp && !end.url.startsWith('https://')) {
        errors.push(`端 ${id} 的 url 必须是 https（开发期可加 --allow-http）`);
      }
    }
  }

  if (cfg.entry !== undefined) {
    if (!isObj(cfg.entry)) errors.push('entry 必须是对象');
    else {
      for (const k of Object.keys(cfg.entry)) {
        if (!ENTRY_KEYS.includes(k)) errors.push(`entry 不支持的键：${k}`);
      }
      if (cfg.entry.title !== undefined && (typeof cfg.entry.title !== 'string' || !cfg.entry.title.trim())) {
        errors.push('entry.title 不能为空');
      }
      if (cfg.entry.subtitle !== undefined && typeof cfg.entry.subtitle !== 'string') {
        errors.push('entry.subtitle 必须是字符串');
      }
      if (cfg.entry.rememberLast !== undefined && typeof cfg.entry.rememberLast !== 'boolean') {
        errors.push('entry.rememberLast 必须是布尔值');
      }
      const endIds = isObj(cfg.ends) ? Object.keys(cfg.ends) : [];
      if (cfg.entry.order !== undefined) {
        if (!Array.isArray(cfg.entry.order)) errors.push('entry.order 必须是数组');
        else {
          for (const id of cfg.entry.order) {
            if (typeof id !== 'string' || !endIds.includes(id)) errors.push(`entry.order 含未知端：${id}`);
          }
        }
      }
      if (cfg.entry.groups !== undefined) {
        if (!Array.isArray(cfg.entry.groups)) errors.push('entry.groups 必须是数组');
        else {
          const seen = new Set();
          for (const g of cfg.entry.groups) {
            if (!isObj(g)) { errors.push('entry.groups 每项必须是对象'); continue; }
            for (const k of Object.keys(g)) {
              if (!['label', 'ends'].includes(k)) errors.push(`entry.groups 不支持的键：${k}`);
            }
            if (typeof g.label !== 'string' || !g.label.trim()) errors.push('entry.groups.label 不能为空');
            if (!Array.isArray(g.ends)) { errors.push('entry.groups.ends 必须是数组'); continue; }
            for (const id of g.ends) {
              if (typeof id !== 'string' || !endIds.includes(id)) errors.push(`entry.groups 含未知端：${id}`);
              else if (seen.has(id)) errors.push(`端 ${id} 在 entry.groups 中重复出现`);
              else seen.add(id);
            }
          }
        }
      }
      if (cfg.entry.routes !== undefined) {
        if (!Array.isArray(cfg.entry.routes)) errors.push('entry.routes 必须是数组');
        else {
          const seenRoutes = new Set();
          const knownCaps = new Set([...CAPABILITIES, ...(Array.isArray(opts.capabilities) ? opts.capabilities : [])]);
          for (const r of cfg.entry.routes) {
            if (!isObj(r)) { errors.push('entry.routes 每项必须是对象'); continue; }
            for (const k of Object.keys(r)) {
              if (!ENTRY_ROUTE_KEYS.includes(k)) errors.push(`entry.routes 不支持的键：${k}`);
            }
            if (typeof r.id !== 'string' || !RE_ENTRY_ID.test(r.id)) {
              errors.push(`入口 id 必须是小写字母开头、2–32 位的 a-z/0-9/./-`);
            } else if (seenRoutes.has(r.id)) {
              errors.push(`入口 id 重复：${r.id}`);
            } else {
              seenRoutes.add(r.id);
            }
            if (r.label !== undefined && (typeof r.label !== 'string' || !r.label.trim())) {
              errors.push(`入口 ${r.id || '?'} 的 label 不能为空`);
            }
            if (typeof r.path !== 'string' || !RE_ROUTE_PATH.test(r.path)) {
              errors.push(`入口 ${r.id || '?'} 的 path 必须是站内相对路径（以 / 开头，不含空白）`);
            }
            if (r.fallback !== undefined && (typeof r.fallback !== 'string' || !RE_ROUTE_PATH.test(r.fallback))) {
              errors.push(`入口 ${r.id || '?'} 的 fallback 必须是站内相对路径`);
            }
            if (r.params !== undefined) {
              if (!isObj(r.params)) {
                errors.push(`入口 ${r.id || '?'} 的 params 必须是对象`);
              } else {
                for (const [name, p] of Object.entries(r.params)) {
                  if (!RE_PARAM_NAME.test(name)) { errors.push(`入口参数名不合法：${name}`); continue; }
                  if (!isObj(p)) { errors.push(`入口参数 ${name} 必须是对象`); continue; }
                  for (const k of Object.keys(p)) {
                    if (!ENTRY_PARAM_KEYS.includes(k)) errors.push(`入口参数 ${name} 不支持的键：${k}`);
                  }
                  if (!ENTRY_PARAM_TYPES.includes(p.type)) {
                    errors.push(`入口参数 ${name} 的 type 只能是 ${ENTRY_PARAM_TYPES.join(' / ')}`);
                  }
                  if (p.required !== undefined && typeof p.required !== 'boolean') {
                    errors.push(`入口参数 ${name} 的 required 必须是布尔值`);
                  }
                  if (p.maxLength !== undefined) {
                    if (!Number.isInteger(p.maxLength) || p.maxLength < 1 || p.maxLength > 1024) {
                      errors.push(`入口参数 ${name} 的 maxLength 必须是 1–1024 的整数`);
                    } else if (p.type !== 'string') {
                      errors.push(`入口参数 ${name} 的 maxLength 仅适用于 string`);
                    }
                  }
                  if (p.enum !== undefined) {
                    if (!Array.isArray(p.enum) || !p.enum.length) {
                      errors.push(`入口参数 ${name} 的 enum 必须是非空数组`);
                    } else if (p.enum.some((v) => typeof v !== p.type)) {
                      errors.push(`入口参数 ${name} 的 enum 值必须与 type=${p.type} 一致`);
                    }
                  }
                }
              }
            }
            if (r.requires !== undefined) {
              if (!isObj(r.requires)) {
                errors.push(`入口 ${r.id || '?'} 的 requires 必须是对象`);
              } else {
                for (const k of Object.keys(r.requires)) {
                  if (!['capability', 'online'].includes(k)) errors.push(`入口 requires 不支持的键：${k}`);
                }
                if (r.requires.capability !== undefined) {
                  if (typeof r.requires.capability !== 'string' || !knownCaps.has(r.requires.capability)) {
                    errors.push(`入口 ${r.id || '?'} 依赖未知能力：${r.requires.capability}`);
                  }
                }
                if (r.requires.online !== undefined && typeof r.requires.online !== 'boolean') {
                  errors.push(`入口 ${r.id || '?'} 的 requires.online 必须是布尔值`);
                }
              }
            }
          }
        }
      }
    }
  }

  if (cfg.security !== undefined) {
    if (!isObj(cfg.security)) errors.push('security 必须是对象');
    else {
      for (const k of Object.keys(cfg.security)) {
        if (k !== 'identity' && k !== 'plugins') errors.push(`security 不支持的键：${k}`);
      }
      if (cfg.security.plugins !== undefined) {
        if (!isObj(cfg.security.plugins)) errors.push('security.plugins 必须是对象');
        else {
          for (const k of Object.keys(cfg.security.plugins)) {
            if (k !== 'requireSigned') errors.push(`security.plugins 不支持的键：${k}`);
          }
          if (cfg.security.plugins.requireSigned !== undefined
            && typeof cfg.security.plugins.requireSigned !== 'boolean') {
            errors.push('security.plugins.requireSigned 必须是布尔值');
          }
        }
      }
      const id = cfg.security.identity;
      if (id !== undefined) {
        if (!isObj(id)) errors.push('security.identity 必须是对象');
        else {
          for (const k of Object.keys(id)) {
            if (!IDENTITY_KEYS.includes(k)) errors.push(`security.identity 不支持的键：${k}`);
          }
          const mode = id.mode === undefined ? 'none' : id.mode;
          if (!IDENTITY_MODES.includes(mode)) errors.push('security.identity.mode 只能是 device 或 none');
          if (mode === 'device') {
            if (typeof id.endpoint !== 'string' || !RE_URL.test(id.endpoint)) {
              errors.push('security.identity.endpoint 必须是 http(s) 绝对地址');
            } else if (!allowHttp && !id.endpoint.startsWith('https://')) {
              errors.push('security.identity.endpoint 必须是 https（开发期可加 --allow-http）');
            }
          } else if (id.endpoint !== undefined) {
            errors.push('security.identity.endpoint 仅在 mode=device 时使用');
          }
          if (id.storeKey !== undefined) {
            const expected = `${cfg.prefix || cfg.brand}:`;
            if (typeof id.storeKey !== 'string' || !RE_SECURE_KEY.test(id.storeKey)) {
              errors.push('security.identity.storeKey 必须是 <prefix>:<purpose> 形式');
            } else if (!id.storeKey.startsWith(expected)) {
              errors.push(`security.identity.storeKey 必须以 ${expected} 开头`);
            }
          }
        }
      }
    }
  }

  if (cfg.plugins !== undefined) {
    if (!Array.isArray(cfg.plugins)) errors.push('plugins 必须是包名数组');
    else {
      const seen = new Set();
      for (const name of cfg.plugins) {
        if (typeof name !== 'string' || !RE_PKG.test(name)) errors.push(`插件包名不合法：${name}`);
        else if (seen.has(name)) errors.push(`插件重复：${name}`);
        else seen.add(name);
      }
      if (cfg.profile === 'lite' && cfg.plugins.length) {
        errors.push('profile=lite 不允许插件（请升档或移除插件）');
      }
    }
  }

  if (cfg.caps !== undefined) {
    if (!isObj(cfg.caps)) errors.push('caps 必须是对象');
    else {
      for (const k of Object.keys(cfg.caps)) {
        if (k !== 'allow') errors.push(`caps 不支持的键：${k}`);
      }
      if (cfg.caps.allow !== undefined) {
        if (!Array.isArray(cfg.caps.allow)) errors.push('caps.allow 必须是能力名数组');
        else {
          // 只能收窄：allow 必须是当前档位能力 ∪ 插件能力的子集
          const base = (PROFILES[cfg.profile] && PROFILES[cfg.profile].capabilities) || CAPABILITIES;
          const allowed = [...new Set([...base, ...(Array.isArray(opts.capabilities) ? opts.capabilities : [])])];
          const seen = new Set();
          for (const cap of cfg.caps.allow) {
            if (typeof cap !== 'string' || !cap.trim()) errors.push('caps.allow 含非法能力名');
            else if (seen.has(cap)) errors.push(`caps.allow 能力重复：${cap}`);
            else if (!allowed.includes(cap)) {
              errors.push(`caps.allow 含未知能力：${cap}（当前可用：${allowed.join('/')}）`);
            } else seen.add(cap);
          }
        }
      }
    }
  }

  if (cfg.targets) {
    if (!Array.isArray(cfg.targets) || cfg.targets.some((t) => !TARGETS.includes(t))) {
      errors.push(`targets 只能是 ${TARGETS.join(' / ')} 的子集`);
    }
  } else {
    errors.push('targets 不能为空（app / pc / mp / web 的子集）');
  }

  if (cfg.contractVersion && cfg.contractVersion.split('.')[0] !== CONTRACT_VERSION.split('.')[0]) {
    errors.push(`contractVersion 主版本需为 ${CONTRACT_VERSION.split('.')[0]}.x（当前 ${cfg.contractVersion}）`);
  }

  return { ok: errors.length === 0, errors };
}

/** 把 uendos.config.json 收敛成运行时需要的配置片段 */
export function runtimeConfig(cfg) {
  return {
    brand: cfg.brand,
    alias: cfg.alias,
    prefix: cfg.prefix || cfg.brand,
    accent: cfg.accent,
    statusBarStyle: cfg.statusBarStyle || 'dark',
    endKey: cfg.endKey,
    ends: cfg.ends,
    theme: cfg.theme,
    entry: cfg.entry,
    security: cfg.security,
    caps: cfg.caps,
  };
}

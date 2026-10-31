/**
 * @uendos/contract — UendOS 壳契约（唯一真相的机读版）
 *
 * 与 docs/shell-contract.md 对齐。运行时（@uendos/shell）与一致性测试
 * （@uendos/conformance）都以本文件为准；改契约先改这里，再改实现。
 */

export const CONTRACT_VERSION = '0.3.1';
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

const RE_URL = /^(https?:\/\/[^\s]+)$/;
const RE_BRAND = /^[a-z][a-z0-9-]{1,15}$/;
const RE_END_ID = /^[a-z]{2,4}$/;
const RE_ACCENT = /^#[0-9A-Fa-f]{6}$/;

/**
 * 校验 uendos.config.json。返回 { ok, errors }，errors 是可直接展示的中文文案。
 * @param {object} cfg
 * @param {{allowHttp?: boolean}} [opts] 允许 http（仅限本地开发/内网店根）
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
  };
}

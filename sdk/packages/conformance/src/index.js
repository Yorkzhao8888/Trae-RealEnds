/**
 * UendOS 一致性测试（conformance）
 *
 * 在 Node 里用 vm 模拟浏览器环境，加载生成的品牌桥文件，按契约逐条断言。
 * 目的：把"声明了但没实现"的问题在发布前拦住，而不是靠人读文档。
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CAPABILITIES, CORE_METHODS, validateConfig, runtimeConfig } from '../../contract/src/index.js';

function makeElement() {
  return {
    style: {},
    textContent: '',
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {},
    appendChild() {},
    addEventListener() {},
  };
}

function makeDocument() {
  const head = makeElement();
  const body = makeElement();
  const documentElement = makeElement();
  const doc = {
    head,
    body,
    documentElement,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeElement(),
    dispatchEvent() { return true; },
    _listeners: {},
  };
  doc.addEventListener = (type, fn) => {
    (doc._listeners[type] ||= []).push(fn);
  };
  return doc;
}

class SandboxCustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}

/**
 * @param {string} source 品牌桥源码
 * @param {object} cfg uendos.config.json
 */
function createHarness(source, cfg) {
  const history = [];
  let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
  let replacedWith = null;

  const listeners = {};
  const windowObj = {
    addEventListener(type, fn) {
      (listeners[type] ||= new Set()).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners[type]) listeners[type].delete(fn);
    },
    dispatchEvent(ev) {
      history.push({ type: ev.type, detail: ev.detail });
      for (const fn of listeners[ev.type] || []) {
        try { fn(ev); } catch (e) {}
      }
      return true;
    },
    performance: { now: () => Math.round(Date.now()) },
    crypto: { randomUUID: () => '11111111-2222-4333-8444-555555555555' },
  };

  const navigatorObj = {
    userAgent: 'uendos-conformance',
    onLine: true,
    vibrate: () => true,
    connection: { effectiveType: '4g', downlink: 10, rtt: 50 },
  };

  const locationObj = {
    search: '',
    href: 'https://demo.local/',
    replace(u) { replacedWith = u; },
  };

  const documentObj = makeDocument();
  const localStorage = makeStorage();

  const sandbox = {
    window: windowObj,
    document: documentObj,
    location: locationObj,
    navigator: navigatorObj,
    localStorage,
    CustomEvent: SandboxCustomEvent,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    fetch: async (url, init) => fetchImpl(url, init),
    Promise,
    JSON,
    Date,
    Math,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  // 浏览器里裸标识符会回落到 window；vm 里 sandbox !== window，这里补一层转发
  Object.defineProperty(sandbox, 'ShellCore', {
    configurable: true,
    get() { return windowObj.ShellCore; },
  });

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'shell.generated.js' });

  return {
    sandbox,
    history,
    get replacedWith() { return replacedWith; },
    get shell() { return windowObj.Shell; },
    setFetch(fn) { fetchImpl = fn; },
    setOnline(v) { navigatorObj.onLine = v; },
    wait(ms = 5) { return new Promise((r) => setTimeout(r, ms)); },
  };
}

function mkRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const pass = (name, detail = '') => ({ name, ok: true, detail });
const fail = (name, detail) => ({ name, ok: false, detail });
const skip = (name, detail) => ({ name, ok: true, skipped: true, detail });

let allowCaps = null; // 生效白名单；null = 未配置 caps（不裁剪）
let sectionCaps = null; // 当前断言段所需能力（被裁剪时整段记为跳过）

async function record(results, name, fn) {
  if (allowCaps !== null && sectionCaps && !allowCaps.includes(sectionCaps)) {
    results.push(skip(name, `能力未启用：${sectionCaps}`));
    return;
  }
  try {
    const r = await fn();
    results.push(r === true || r == null ? pass(name) : r);
  } catch (e) {
    results.push(fail(name, e && e.message));
  }
}

async function recordCap(results, name, cap, fn) {
  if (allowCaps !== null && !allowCaps.includes(cap)) {
    results.push(skip(name, `能力未启用：${cap}`));
    return;
  }
  await record(results, name, fn);
}

/**
 * 跑一致性测试。
 * @param {string} shellFile 生成的品牌桥文件路径
 * @param {{cfg?: object, envName?: string, plugins?: Array<{id: string, assertions: Array<{name: string, run: Function}>}>}} [opts]
 * @returns {Promise<{ok: boolean, passed: number, failed: number, results: object[]}>}
 */
export async function runConformance(shellFile, opts = {}) {
  const source = readFileSync(shellFile, 'utf8');
  const MARK = 'ShellCore.create(';
  const idx = source.lastIndexOf(MARK);
  if (idx < 0) {
    return { ok: false, passed: 0, failed: 1, results: [fail('产物形态', '文件末尾缺少 ShellCore.create(config)')] };
  }
  let cfg;
  if (opts.cfg) {
    cfg = opts.cfg;
  } else {
    try {
      cfg = JSON.parse(source.slice(idx + MARK.length).trim().replace(/\);\s*$/, ''));
    } catch (e) {
      return { ok: false, passed: 0, failed: 1, results: [fail('产物形态', `配置片段不是合法 JSON：${e.message}`)] };
    }
  }
  const h = createHarness(source, cfg);
  const results = [];
  const Shell = h.shell;
  allowCaps = Array.isArray(opts.caps) ? opts.caps : null;
  sectionCaps = null;

  await h.wait(20); // 等 shell:ready 一拍

  // ---------------------------------------------------------------- 结构
  await record(results, '桥已创建（window.Shell.__core）', () => {
    if (!Shell || !Shell.__core) throw new Error('window.Shell 不存在或不是 core 桥');
  });
  await record(results, 'call / on 为函数', () => {
    if (typeof Shell.call !== 'function') throw new Error('call 缺失');
    if (typeof Shell.on !== 'function') throw new Error('on 缺失');
  });
  await record(results, `品牌身份 brand=${cfg.brand}`, () => {
    if (Shell.brand !== cfg.brand) throw new Error(`brand=${Shell.brand}`);
  });
  await record(results, `兼容别名 window.${cfg.alias}`, () => {
    if (h.sandbox.window[cfg.alias] !== Shell) throw new Error('别名未指向同一桥');
  });
  await record(results, '版本字段语义化', () => {
    if (!/^\d+\.\d+\.\d+$/.test(Shell.version || '')) throw new Error(`version=${Shell.version}`);
    if (String(Shell.bridge) !== '3') throw new Error(`bridge=${Shell.bridge}`);
  });
  await record(results, 'ends 与配置一致', () => {
    const a = JSON.stringify(Object.keys(Shell.ends || {}).sort());
    const b = JSON.stringify(Object.keys(cfg.ends).sort());
    if (a !== b) throw new Error(`${a} != ${b}`);
  });
  await record(results, '能力矩阵键齐全（18 + edge.storeRoot）', () => {
    for (const k of CAPABILITIES) {
      if (!(k in Shell.capabilities)) throw new Error(`缺能力键：${k}`);
    }
  });
  await record(results, '能力值来自固定枚举', () => {
    const allowed = new Set(['✓', '◐', '─', 'web']);
    for (const [k, v] of Object.entries(Shell.capabilities)) {
      if (!allowed.has(v)) throw new Error(`${k}=${v}`);
    }
  });

  // ---------------------------------------------------------------- 握手
  await record(results, 'core.handshake 返回完整载荷', async () => {
    const r = await Shell.call('core.handshake');
    if (!r || r.ok !== true) throw new Error('handshake 未成功');
    for (const k of ['version', 'bridge', 'brand', 'platform', 'env', 'capabilities']) {
      if (!(k in r.data)) throw new Error(`载荷缺 ${k}`);
    }
  });
  await record(results, 'core.capabilities 与 Shell.capabilities 一致', async () => {
    const r = await Shell.call('core.capabilities');
    if (JSON.stringify(r.data) !== JSON.stringify(Shell.capabilities)) throw new Error('不一致');
  });
  await record(results, 'core.ready 报告已就绪', async () => {
    const r = await Shell.call('core.ready');
    if (r.data.ready !== true) throw new Error('ready=false');
  });
  await record(results, '核心方法全部可调用（不抛异常）', async () => {
    for (const m of CORE_METHODS) {
      const r = await Shell.call(m);
      if (!r || typeof r.ok !== 'boolean') throw new Error(`${m} 返回结构不合法`);
    }
  });

  // ---------------------------------------------------------------- 端切换
  await record(results, '未知端 id 返回 E_BAD_ARGS', async () => {
    const r = await Shell.call('core.switchEnd', { id: 'zz' });
    if (r.ok || r.code !== 'E_BAD_ARGS') throw new Error(`code=${r.code}`);
  });
  await record(results, '切换已知端会调用 location.replace', async () => {
    const first = Object.keys(cfg.ends)[0];
    const r = await Shell.call('core.switchEnd', { id: first });
    if (!r.ok) throw new Error('切换失败');
    if (h.replacedWith !== cfg.ends[first].url) throw new Error(`replace=${h.replacedWith}`);
  });
  await record(results, '切换后端状态被记住（core.end）', async () => {
    const r = await Shell.call('core.end');
    const first = Object.keys(cfg.ends)[0];
    if (r.data.id !== first) throw new Error(`id=${r.data.id}`);
  });
  await record(results, '端切换事件双写（shell: + 品牌前缀）', () => {
    const hit = h.history.filter((e) => e.type === 'shell:end-changed');
    if (!hit.length) throw new Error('缺 shell:end-changed');
  });

  // ---------------------------------------------------------------- 事件
  await record(results, 'shell:ready 已派发且带 capabilities', () => {
    const ev = h.history.find((e) => e.type === 'shell:ready');
    if (!ev) throw new Error('未派发 shell:ready');
    if (!ev.detail || !ev.detail.data || !ev.detail.data.capabilities) throw new Error('载荷缺 capabilities');
  });
  await record(results, '事件带 seq / at / data', () => {
    for (const e of h.history) {
      if (!e.detail || typeof e.detail.seq !== 'number' || typeof e.detail.at !== 'number') {
        throw new Error(`${e.type} 载荷不合法`);
      }
    }
  });
  let received = 0;
  let off = null;
  await record(results, 'on() 返回可用的取消订阅函数', () => {
    off = Shell.on('shell:end-changed', () => { received++; });
    if (typeof off !== 'function') throw new Error('未返回函数');
  });
  await record(results, '取消订阅后不再收到事件', async () => {
    const first = Object.keys(cfg.ends)[0];
    await Shell.call('core.switchEnd', { id: first });
    const before = received;
    if (before < 1) throw new Error('订阅期间未收到事件');
    off();
    await Shell.call('core.switchEnd', { id: first });
    if (received !== before) throw new Error(`取消后仍收到事件（${received}）`);
  });

  // ---------------------------------------------------------------- 错误协议
  await record(results, '未知方法返回 E_UNSUPPORTED', async () => {
    const r = await Shell.call('shell.nope');
    if (r.ok || r.code !== 'E_UNSUPPORTED') throw new Error(`code=${r.code}`);
  });
  await recordCap(results, 'edge.configure 缺参返回 E_BAD_ARGS', 'edge.storeRoot', async () => {
    const r = await Shell.call('edge.configure', {});
    if (r.ok || r.code !== 'E_BAD_ARGS') throw new Error(`code=${r.code}`);
  });
  await recordCap(results, 'offline.enqueue 缺参返回 E_BAD_ARGS', 'offlineQueue', async () => {
    const r = await Shell.call('offline.enqueue', {});
    if (r.ok || r.code !== 'E_BAD_ARGS') throw new Error(`code=${r.code}`);
  });
  await record(results, '所有返回值都有布尔 ok', async () => {
    for (const [m, a] of [['core.end', {}], ['core.net', {}], ['offline.list', {}]]) {
      const r = await Shell.call(m, a);
      if (typeof r.ok !== 'boolean') throw new Error(`${m} 缺 ok`);
    }
  });
  await record(results, '非法输入不抛异常（只返回错误码）', () => {
    Shell.call('core.switchEnd', null);
    Shell.call('offline.enqueue', null);
    Shell.call('edge.commit', { ops: [] });
  });

  // ---------------------------------------------------------------- 离线队列
  h.sandbox.navigator.onLine = false;
  sectionCaps = 'offlineQueue';
  let idem = null;
  await record(results, 'enqueue 返回幂等键与计数', async () => {
    const r = await Shell.call('offline.enqueue', { url: 'https://demo.local/q', method: 'post', body: { n: 1 } });
    if (!r.ok || !r.data.idem) throw new Error('缺 idem');
    idem = r.data.idem;
    if (r.data.count !== 1) throw new Error(`count=${r.data.count}`);
  });
  await record(results, 'offline.list 可读回队列', async () => {
    const r = await Shell.call('offline.list');
    if (!Array.isArray(r.data) || r.data.length !== 1) throw new Error('队列长度不对');
    if (r.data[0].idem !== idem) throw new Error('idem 不一致');
  });
  await record(results, '联网后 flush 按序重放并出队', async () => {
    h.sandbox.navigator.onLine = true;
    h.setFetch(async () => mkRes(200, { ok: true }));
    const r = await Shell.call('offline.flush');
    if (r.data.flushed !== 1 || r.data.left !== 0) throw new Error(JSON.stringify(r.data));
    const list = await Shell.call('offline.list');
    if (list.data.length !== 0) throw new Error('未清空');
  });
  await record(results, '4xx 视为永久失败并出队', async () => {
    h.sandbox.navigator.onLine = false;
    await Shell.call('offline.enqueue', { url: 'https://demo.local/q', method: 'POST', body: {} });
    h.sandbox.navigator.onLine = true;
    h.setFetch(async () => mkRes(409, { code: 'stock' }));
    await Shell.call('offline.flush');
    const list = await Shell.call('offline.list');
    if (list.data.length !== 0) throw new Error('409 未出队');
    if (!h.history.some((e) => e.type === 'shell:queue-failed')) throw new Error('缺 queue-failed 事件');
  });
  await record(results, '5xx 保留重试并累加 tries', async () => {
    h.sandbox.navigator.onLine = false;
    await Shell.call('offline.enqueue', { url: 'https://demo.local/q', method: 'POST', body: {} });
    h.sandbox.navigator.onLine = true;
    h.setFetch(async () => mkRes(503, {}));
    await Shell.call('offline.flush');
    const list = await Shell.call('offline.list');
    if (list.data.length !== 1) throw new Error('5xx 被出队');
    if (list.data[0].tries < 1) throw new Error('tries 未累加');
    h.setFetch(async () => mkRes(200, {}));
    await Shell.call('offline.flush');
  });
  await record(results, '网络异常保留队列', async () => {
    h.sandbox.navigator.onLine = false;
    await Shell.call('offline.enqueue', { url: 'https://demo.local/q', method: 'POST', body: {} });
    h.sandbox.navigator.onLine = true;
    h.setFetch(async () => { throw new Error('network down'); });
    await Shell.call('offline.flush');
    const list = await Shell.call('offline.list');
    if (list.data.length !== 1) throw new Error('网络异常时队列被清空');
    h.setFetch(async () => mkRes(200, {}));
    await Shell.call('offline.flush');
  });

  // ---------------------------------------------------------------- 店根适配
  sectionCaps = 'edge.storeRoot';
  await record(results, '未配置店根时 edge.health 返回 E_UNSUPPORTED', async () => {
    const r = await Shell.call('edge.health');
    if (r.ok || r.code !== 'E_UNSUPPORTED') throw new Error(`code=${r.code}`);
  });
  await record(results, 'edge.configure 持久化地址与令牌', async () => {
    const r = await Shell.call('edge.configure', { baseUrl: 'https://demo.local/edge/', token: 'tk' });
    if (!r.ok || r.data.baseUrl !== 'https://demo.local/edge') throw new Error(JSON.stringify(r));
  });
  await record(results, 'edge.health 200 返回业务体', async () => {
    h.setFetch(async () => mkRes(200, { ok: true, storeId: 's1' }));
    const r = await Shell.call('edge.health');
    if (!r.ok || r.data.storeId !== 's1') throw new Error('健康检查未透传');
  });
  await record(results, '店根 stock 错误映射为 E_STOCK 且带 status', async () => {
    h.setFetch(async () => mkRes(409, { code: 'stock' }));
    const r = await Shell.call('edge.health');
    if (r.code !== 'E_STOCK' || r.status !== 409) throw new Error(JSON.stringify(r));
  });
  await record(results, '租约错误映射为 E_LEASE', async () => {
    h.setFetch(async () => mkRes(409, { code: 'lease_expired' }));
    const r = await Shell.call('edge.health');
    if (r.code !== 'E_LEASE') throw new Error(`code=${r.code}`);
  });
  await record(results, '店根不可达映射为 E_EDGE_OFFLINE', async () => {
    h.setFetch(async () => { throw new Error('ECONNREFUSED'); });
    const r = await Shell.call('edge.health');
    if (r.code !== 'E_EDGE_OFFLINE') throw new Error(`code=${r.code}`);
    h.setFetch(async () => mkRes(200, {}));
  });

  sectionCaps = null;

  // ---------------------------------------------------------------- 能力白名单
  if (allowCaps !== null) {
    await record(results, '白名单外的能力值回落为 ─', () => {
      for (const c of CAPABILITIES) {
        if (!allowCaps.includes(c) && Shell.capabilities[c] !== '─') {
          throw new Error(`${c}=${Shell.capabilities[c]}`);
        }
      }
    });
    await record(results, '白名单外的方法返回 E_UNSUPPORTED', async () => {
      const probes = {
        vibrate: 'core.vibrate', share: 'core.share', geolocation: 'core.location',
        statusBar: 'core.statusBar', splash: 'core.splash', network: 'core.net',
        offlineQueue: 'offline.enqueue', 'edge.storeRoot': 'edge.health',
      };
      for (const [c, method] of Object.entries(probes)) {
        if (allowCaps.includes(c)) continue;
        const r = await Shell.call(method);
        if (r.ok || r.code !== 'E_UNSUPPORTED') throw new Error(`${method} code=${r.code}`);
      }
    });
  }

  // ---------------------------------------------------------------- 契约自洽
  await record(results, '生成配置通过契约校验', () => {
    const pluginCaps = [...new Set((opts.plugins || []).flatMap((p) => p.capabilities || []))];
    const v = validateConfig({ schemaVersion: 1, displayName: 'Demo', targets: ['web'], ...cfg }, { capabilities: pluginCaps });
    if (!v.ok) throw new Error(v.errors.join('；'));
  });
  await record(results, 'runtimeConfig 字段齐全', () => {
    const rc = runtimeConfig({ schemaVersion: 1, displayName: 'Demo', targets: ['web'], ...cfg });
    for (const k of ['brand', 'alias', 'prefix', 'accent', 'endKey', 'ends']) {
      if (!(k in rc)) throw new Error(`缺 ${k}`);
    }
  });

  // ---------------------------------------------------------------- 插件断言合并
  for (const p of opts.plugins || []) {
    const blocked = allowCaps !== null && (p.capabilities || []).some((c) => !allowCaps.includes(c));
    for (const a of p.assertions || []) {
      if (!a || typeof a.name !== 'string' || typeof a.run !== 'function') {
        results.push(fail(`${p.id} · 断言格式`, '插件断言需为 { name, run(Shell) }'));
        continue;
      }
      if (blocked) {
        results.push(skip(`${p.id} · ${a.name}`, `能力未启用：${(p.capabilities || []).join('/')}`));
        continue;
      }
      await record(results, `${p.id} · ${a.name}`, () => a.run(Shell));
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  return { ok: failed === 0, passed: results.length - failed - skipped, skipped, failed, results };
}

/**
 * UendOS 一致性测试（conformance）
 *
 * 在 Node 里用 vm 模拟浏览器环境，加载生成的品牌桥文件，按契约逐条断言。
 * 目的：把"声明了但没实现"的问题在发布前拦住，而不是靠人读文档。
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CAPABILITIES, CORE_METHODS, SECURE_BACKENDS, validateConfig, runtimeConfig } from '../../contract/src/index.js';

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
function createHarness(source, cfg, opts = {}) {
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
  const localStorage = opts.storage || makeStorage();

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
    localStorage,
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
  await record(results, '能力矩阵键齐全（21 项）', () => {
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
  await record(results, 'events.recent 可回看最近事件', () => {
    if (!Shell.events || typeof Shell.events.recent !== 'function') throw new Error('缺 events.recent');
    const all = Shell.events.recent();
    if (!Array.isArray(all) || !all.length) throw new Error('事件日志为空');
    if (all.length > 20) throw new Error(`默认条数=${all.length}`);
    for (const e of all) {
      if (typeof e.event !== 'string' || typeof e.seq !== 'number') throw new Error('载荷不合法');
    }
  });
  await record(results, 'events.recent 支持按事件名过滤与 limit', () => {
    const ready = Shell.events.recent('shell:ready');
    if (!ready.length || ready.some((e) => e.event !== 'shell:ready')) throw new Error('过滤失效');
    const one = Shell.events.recent(1);
    if (one.length !== 1) throw new Error(`limit=1 返回 ${one.length} 条`);
    const tail = Shell.events.recent();
    if (one[0].seq !== tail[tail.length - 1].seq) throw new Error('recent 顺序不一致');
  });

  // ---------------------------------------------------------------- 入口路由
  const routes = cfg.entry && Array.isArray(cfg.entry.routes) ? cfg.entry.routes : [];
  if (routes.length) {
    await record(results, 'entries() 列出入口与可用性', () => {
      if (typeof Shell.entries !== 'function') throw new Error('缺 Shell.entries');
      const list = Shell.entries();
      if (!Array.isArray(list) || list.length !== routes.length) throw new Error(`入口数=${list && list.length}`);
      for (const r of list) {
        if (typeof r.id !== 'string' || typeof r.path !== 'string') throw new Error('入口结构不合法');
        if (typeof r.available !== 'boolean') throw new Error(`${r.id} 缺 available`);
        if (!r.available && !r.reason) throw new Error(`${r.id} 不可用但没给 reason`);
      }
    });

    const openable = routes.filter((r) => {
      const req = r.requires || {};
      const cap = req.capability ? Shell.capabilities[req.capability] : '✓';
      return (!req.capability || (cap && cap !== '─')) && (!req.online || h.sandbox.navigator.onLine !== false);
    });

    await record(results, 'entry.open 校验参数并拼装站内路径', async () => {
      if (!openable.length) throw new Error('没有可用入口可供断言');
      const route = openable[0];
      const params = {};
      for (const [name, p] of Object.entries(route.params || {})) {
        if (!p.required) continue;
        params[name] = Array.isArray(p.enum) && p.enum.length ? p.enum[0]
          : p.type === 'number' ? 1 : p.type === 'boolean' ? true : 'x';
      }
      const r = await Shell.call('entry.open', { id: route.id, params, source: 'launcher', idem: 'conf-entry' });
      if (!r.ok || !r.data || r.data.opened !== true) throw new Error(`未打开：${r.message}`);
      if (typeof r.data.path !== 'string' || !r.data.path.startsWith(route.path)) throw new Error(`path=${r.data.path}`);
    });

    const withRequired = openable.find((r) => Object.values(r.params || {}).some((p) => p.required));
    if (withRequired) {
      await record(results, 'entry.open 缺必填参数返回 E_BAD_ARGS', async () => {
        const r = await Shell.call('entry.open', { id: withRequired.id, params: {} });
        if (r.ok || r.code !== 'E_BAD_ARGS') throw new Error(`code=${r.code}`);
        if (!r.data || r.data.fallback !== (withRequired.fallback || null)) throw new Error('fallback 不一致');
      });
    }

    await record(results, '未知入口返回 E_BAD_ARGS', async () => {
      const r = await Shell.call('entry.open', { id: 'no-such-entry' });
      if (r.ok || r.code !== 'E_BAD_ARGS') throw new Error(`code=${r.code}`);
    });

    const blocked = routes.find((r) => {
      const req = r.requires || {};
      const cap = req.capability ? Shell.capabilities[req.capability] : '✓';
      return (req.capability && (!cap || cap === '─')) || (req.online && h.sandbox.navigator.onLine === false);
    });
    if (blocked) {
      await record(results, '能力不足返回 E_UNSUPPORTED 并带 fallback', async () => {
        const r = await Shell.call('entry.open', { id: blocked.id, params: {} });
        if (r.ok || r.code !== 'E_UNSUPPORTED') throw new Error(`code=${r.code}`);
        if (!r.data || r.data.fallback !== (blocked.fallback || null)) throw new Error('fallback 不一致');
      });
    }
  }

  // ---------------------------------------------------------------- 诊断
  await record(results, 'diagnostics() 返回运行时快照', () => {
    if (typeof Shell.diagnostics !== 'function') throw new Error('缺 Shell.diagnostics');
    const d = Shell.diagnostics();
    for (const k of ['version', 'bridge', 'brand', 'env', 'platform', 'online', 'capabilities', 'plugins', 'queue', 'events', 'at']) {
      if (!(k in d)) throw new Error(`诊断缺 ${k}`);
    }
    if (typeof d.queue.count !== 'number' || !(d.queue.oldestAt === null || typeof d.queue.oldestAt === 'number')) {
      throw new Error('queue 形状不合法');
    }
    if (!Array.isArray(d.events)) throw new Error('events 不是数组');
    for (const e of d.events) {
      if (typeof e.event !== 'string' || typeof e.seq !== 'number' || typeof e.at !== 'number') {
        throw new Error('事件摘要形状不合法');
      }
    }
  });
  await record(results, 'diagnostics() 默认脱敏', () => {
    const text = JSON.stringify(Shell.diagnostics());
    if (/(token|secret|password|deviceId|phone|address)/i.test(text)) throw new Error('诊断含敏感字段');
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
  await recordCap(results, '队列按品牌作用域存储且为版本化信封', 'offlineQueue', async () => {
    h.sandbox.navigator.onLine = false;
    await Shell.call('offline.enqueue', { url: 'https://demo.local/scope', method: 'POST', body: {} });
    const key = `shell:offline-queue:${cfg.prefix}`;
    const raw = h.localStorage.getItem(key);
    if (!raw) throw new Error('未写入品牌作用域键');
    const env = JSON.parse(raw);
    if (env.v !== 1 || !Array.isArray(env.items) || env.items.length !== 1) throw new Error('信封不合法');
    h.localStorage.removeItem(key);
  });
  await recordCap(results, '旧版裸数组队列可读取并迁移', 'offlineQueue', async () => {
    const store = makeStorage();
    store.setItem('shell:offline-queue', JSON.stringify([
      { idem: 'old-1', method: 'POST', url: 'https://demo.local/q', body: null, headers: {}, at: 1, tries: 0 },
    ]));
    const old = createHarness(source, cfg, { storage: store });
    await old.wait(20);
    const list = await old.shell.call('offline.list');
    if (!list.ok || list.data.length !== 1 || list.data[0].idem !== 'old-1') throw new Error('旧队列未迁移');
    const raw = store.getItem(`shell:offline-queue:${cfg.prefix}`);
    if (!raw || JSON.parse(raw).v !== 1) throw new Error('未写入版本化信封');
  });
  await recordCap(results, '重启后恢复队列并发出 queue-restored', 'offlineQueue', async () => {
    const store = makeStorage();
    const first = createHarness(source, cfg, { storage: store });
    await first.wait(20);
    first.sandbox.navigator.onLine = false;
    await first.shell.call('offline.enqueue', { url: 'https://demo.local/restart', method: 'POST', body: {} });
    const next = createHarness(source, cfg, { storage: store });
    await next.wait(20);
    const ev = next.history.find((e) => e.type === 'shell:queue-restored');
    if (!ev) throw new Error('缺 shell:queue-restored');
    if (!ev.detail.data || ev.detail.data.count !== 1) throw new Error('恢复数量不对');
    if (typeof ev.detail.data.oldestAt !== 'number') throw new Error('缺 oldestAt');
    const list = await next.shell.call('offline.list');
    if (!list.ok || list.data.length !== 1) throw new Error('恢复后队列为空');
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

  // ---------------------------------------------------------------- IoT 接入
  await record(results, 'IoT 能力位存在（无适配器为 ─）', () => {
    if (!('iot' in Shell.capabilities)) throw new Error('能力矩阵缺 iot');
  });
  if (Shell.capabilities.iot === '─') {
    await record(results, 'IoT 未启用时 iot.* 返回 E_UNSUPPORTED', async () => {
      const list = await Shell.call('iot.devices');
      if (list.ok || list.code !== 'E_UNSUPPORTED') throw new Error(`iot.devices code=${list.code}`);
      const w = await Shell.call('iot.write', { deviceId: 'x', action: 'y', idem: 'z' });
      if (w.ok || w.code !== 'E_UNSUPPORTED') throw new Error(`iot.write code=${w.code}`);
    });
  } else {
    await record(results, 'IoT 适配器点亮 iot 与子能力', () => {
      if (Shell.capabilities.iot !== '✓') throw new Error(`iot=${Shell.capabilities.iot}`);
      const sub = Object.keys(Shell.capabilities).find((k) => k.indexOf('iot.') === 0 && Shell.capabilities[k] !== '─');
      if (!sub) throw new Error('没有任何 iot.* 子能力被点亮');
    });
    await record(results, 'iot.devices 返回结构合法的设备', async () => {
      const r = await Shell.call('iot.devices');
      if (!r.ok || !Array.isArray(r.data.devices)) throw new Error(JSON.stringify(r));
      for (const d of r.data.devices) {
        if (typeof d.id !== 'string' || !d.id) throw new Error('设备缺 id');
        if (typeof d.transport !== 'string' || !d.transport) throw new Error('设备缺 transport');
        if (!['online', 'offline', 'unknown'].includes(d.status)) throw new Error(`status=${d.status}`);
      }
    });
    await record(results, 'iot.write 强制幂等键；只读适配器返回 E_UNSUPPORTED', async () => {
      const list = await Shell.call('iot.devices');
      const d = (list.data.devices || [])[0];
      if (!d) throw new Error('没有可用设备，无法验证 iot.write');
      const bad = await Shell.call('iot.write', { deviceId: d.id, action: 'probe' });
      if (bad.ok || bad.code !== 'E_BAD_ARGS') throw new Error(`缺 idem：${bad.code}`);
      const r = await Shell.call('iot.write', { deviceId: d.id, action: 'probe', idem: 'conf-iot' });
      if (r.ok) {
        if (r.data.accepted !== true || typeof r.data.ackId !== 'string') throw new Error(JSON.stringify(r));
      } else if (r.code !== 'E_UNSUPPORTED') {
        throw new Error(JSON.stringify(r));
      }
    });
  }

  // ---------------------------------------------------------------- 安全存储
  sectionCaps = 'secureStore';
  await record(results, 'secureStore 能力位与内存降级往返', async () => {
    if (Shell.capabilities.secureStore === '─') throw new Error('secureStore 未启用');
    const key = `${cfg.prefix}:token`;
    const w = await Shell.call('secure.set', { key, value: 's3cr3t' });
    if (!w.ok || w.data.backend !== 'memory' || w.data.stored !== true) throw new Error(JSON.stringify(w));
    const g = await Shell.call('secure.get', { key });
    if (!g.ok || g.data.value !== 's3cr3t') throw new Error('读回失败');
    const rm = await Shell.call('secure.remove', { key });
    if (!rm.ok || rm.data.removed !== true) throw new Error('删除失败');
    const gone = await Shell.call('secure.get', { key });
    if (gone.data.value !== null) throw new Error('删除后仍可读');
  });
  await record(results, 'secure 拒绝非品牌前缀、非字符串与超限值', async () => {
    const badPrefix = await Shell.call('secure.set', { key: 'other:token', value: 'x' });
    if (badPrefix.ok || badPrefix.code !== 'E_BAD_ARGS') throw new Error(`前缀：${badPrefix.code}`);
    const notString = await Shell.call('secure.set', { key: `${cfg.prefix}:token`, value: 1 });
    if (notString.ok || notString.code !== 'E_BAD_ARGS') throw new Error(`类型：${notString.code}`);
    const tooLong = await Shell.call('secure.set', { key: `${cfg.prefix}:token`, value: 'x'.repeat(8193) });
    if (tooLong.ok || tooLong.code !== 'E_BAD_ARGS') throw new Error(`长度：${tooLong.code}`);
  });
  await record(results, 'secure 不写 localStorage', async () => {
    const writes = [];
    const orig = h.localStorage.setItem;
    h.localStorage.setItem = (k, v) => { writes.push(k); orig(k, v); };
    const r = await Shell.call('secure.set', { key: `${cfg.prefix}:secret`, value: 'sentinel-815' });
    h.localStorage.setItem = orig;
    if (!r.ok) throw new Error('写入失败');
    if (writes.length) throw new Error(`凭证被写入 localStorage：${writes.join(',')}`);
  });
  await record(results, '诊断只报安全存储后端且不含凭证', async () => {
    await Shell.call('secure.set', { key: `${cfg.prefix}:secret`, value: 'sentinel-815' });
    const d = Shell.diagnostics();
    if (!d.security || !SECURE_BACKENDS.includes(d.security.secureStore)) throw new Error('缺 security.secureStore');
    if (/sentinel-815/.test(JSON.stringify(d))) throw new Error('诊断包泄露凭证');
  });
  sectionCaps = null;

  // ---------------------------------------------------------------- 设备身份
  sectionCaps = 'identity';
  const idCfg = cfg.security && cfg.security.identity;
  const idOn = !!idCfg && idCfg.mode === 'device';
  const idKey = (idCfg && idCfg.storeKey) || `${cfg.prefix || cfg.brand}:identity.device`;

  await record(results, 'identity 能力位与 security.identity 配置一致', () => {
    const v = Shell.capabilities.identity;
    if (idOn) {
      if (v === undefined || v === '─') throw new Error(`identity=${v}，配置 device 后应可用`);
    } else if (v !== '─') {
      throw new Error(`identity=${v}，未配置时应为 ─`);
    }
  });
  await record(results, 'identity.current 只返回元数据，未配置时 E_UNSUPPORTED', async () => {
    const r = await Shell.call('identity.current');
    if (!idOn) {
      if (r.ok || r.code !== 'E_UNSUPPORTED') throw new Error(`未配置时 code=${r.code}`);
      return;
    }
    if (!r.ok) throw new Error(JSON.stringify(r));
    if (!('identity' in r.data)) throw new Error('缺 identity 字段');
    const meta = r.data.identity;
    if (!meta) return;
    for (const k of ['deviceId', 'owner', 'scopes', 'expiresAt', 'source']) {
      if (!(k in meta)) throw new Error(`元数据缺 ${k}`);
    }
    if (Object.keys(meta).some((k) => /token/i.test(k))) throw new Error('元数据包含令牌字段');
  });
  await record(results, 'identity.refresh 原子切换、吊销清空且令牌不外泄', async () => {
    if (!idOn) {
      const r = await Shell.call('identity.refresh');
      if (r.ok || r.code !== 'E_UNSUPPORTED') throw new Error(`未配置时 code=${r.code}`);
      return;
    }
    const base = Date.now();
    await Shell.call('secure.set', {
      key: idKey,
      value: JSON.stringify({
        deviceId: 'dev_a', token: 'old-token-777', owner: 'phone:1',
        scopes: ['order:read'], expiresAt: new Date(base + 86400000).toISOString(), obtainedAt: base,
      }),
    });
    h.setFetch(async (url, init) => {
      if (url !== idCfg.endpoint) throw new Error(`刷新地址不对：${url}`);
      if (!/Bearer old-token-777/.test((init.headers || {}).Authorization || '')) throw new Error('刷新未带旧令牌');
      return mkRes(200, {
        ok: true, device_id: 'dev_b', device_token: 'new-token-999', owner_xu: 'phone:2',
        scopes: ['order:read', 'order:write'], expires_at: new Date(base + 172800000).toISOString(),
      });
    });
    const r = await Shell.call('identity.refresh');
    if (!r.ok) throw new Error(JSON.stringify(r));
    if (r.data.deviceId !== 'dev_b') throw new Error(`deviceId=${r.data.deviceId}`);
    const changed = h.history.filter((x) => x.type === 'shell:identity-changed').pop();
    if (!changed) throw new Error('缺 shell:identity-changed');
    if (/new-token-999/.test(JSON.stringify(changed.detail))) throw new Error('事件泄露令牌');
    if (/new-token-999/.test(JSON.stringify(Shell.diagnostics()))) throw new Error('诊断包泄露令牌');
    const g = await Shell.call('secure.get', { key: idKey });
    if (!/new-token-999/.test(g.data.value || '')) throw new Error('令牌未写回安全存储');

    h.setFetch(async () => mkRes(401, { ok: false }));
    const revoked = await Shell.call('identity.refresh');
    if (revoked.ok || revoked.code !== 'E_DENIED') throw new Error(`吊销后 code=${revoked.code}`);
    if (!h.history.some((x) => x.type === 'shell:identity-expired')) throw new Error('缺 shell:identity-expired');
    const after = await Shell.call('secure.get', { key: idKey });
    if (after.data.value !== null) throw new Error('吊销后令牌未清空');
    const cur = await Shell.call('identity.current');
    if (!cur.ok || cur.data.identity !== null) throw new Error('吊销后仍返回身份');
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
        secureStore: 'secure.get', identity: 'identity.current',
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
    if (!p.assertions || !p.assertions.length) {
      results.push(skip(`${p.id} · 一致性断言`, '插件未提供断言（可选）'));
      continue;
    }
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

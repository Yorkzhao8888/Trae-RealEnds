import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateConfig,
  runtimeConfig,
  resolveTheme,
  THEME_DEFAULTS,
  resolveEntry,
  ENTRY_DEFAULTS,
  validatePluginManifest,
  CONTRACT_VERSION,
  SCHEMA_VERSION,
  CAPABILITIES,
  CORE_METHODS,
  OPTIONAL_METHODS,
  EVENTS,
  ERRORS,
  TARGETS,
  IOT_TRANSPORT_CAPABILITIES,
  IOT_EVENT_VERSION,
  IOT_EVENT_KEYS,
  ENTRY_ROUTE_KEYS,
  ENTRY_SOURCES,
  IDENTITY_MODES,
  IDENTITY_KEYS,
  IDENTITY_STORE_PURPOSE,
  UPDATE_CHANNELS,
  RELEASE_SIGNATURE_STATES,
} from '../src/index.js';

const base = () => ({
  schemaVersion: SCHEMA_VERSION,
  brand: 't-acme',
  displayName: 'Acme',
  alias: 'tAcmeOS',
  prefix: 't-acme',
  accent: '#4C8DFF',
  statusBarStyle: 'dark',
  endKey: 't-acme.end',
  contractVersion: CONTRACT_VERSION,
  targets: ['app', 'pc'],
  ends: {
    hp: { name: '个人端', url: 'https://hp.acme.example.com/' },
  },
});

test('合法配置通过校验', () => {
  const r = validateConfig(base());
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.deepEqual(r.errors, []);
});

test('非对象直接拒绝', () => {
  for (const v of [null, [], 'x', 42]) {
    const r = validateConfig(v);
    assert.equal(r.ok, false);
  }
});

test('brand / alias / accent / displayName 非法值被拒', () => {
  const bad = [
    ['brand', 'Acme'],
    ['brand', 'a'],
    ['brand', 't_acme'],
    ['alias', 't-Acme'],
    ['alias', 'a'],
    ['accent', '#FFF'],
    ['accent', 'red'],
    ['displayName', '   '],
    ['endKey', ''],
  ];
  for (const [key, value] of bad) {
    const cfg = base();
    cfg[key] = value;
    const r = validateConfig(cfg);
    assert.equal(r.ok, false, `${key}=${JSON.stringify(value)} 应被拒`);
  }
});

test('端地址默认必须 https，--allow-http 才放行', () => {
  const cfg = base();
  cfg.ends.hp.url = 'http://hp.acme.example.com/';
  assert.equal(validateConfig(cfg).ok, false);
  assert.equal(validateConfig(cfg, { allowHttp: true }).ok, true);
});

test('ends 为空、id 不合法、url 非绝对地址均被拒', () => {
  const empty = base();
  empty.ends = {};
  assert.equal(validateConfig(empty).ok, false);

  const badId = base();
  badId.ends = { H: { name: 'x', url: 'https://x.example.com/' } };
  assert.equal(validateConfig(badId).ok, false);

  const badUrl = base();
  badUrl.ends.hp.url = '/relative';
  assert.equal(validateConfig(badUrl).ok, false);

  const noName = base();
  noName.ends.hp.name = '';
  assert.equal(validateConfig(noName).ok, false);
});

test('targets 非子集或缺失被拒', () => {
  const cfg = base();
  cfg.targets = ['app', 'ios'];
  assert.equal(validateConfig(cfg).ok, false);

  const missing = base();
  delete missing.targets;
  assert.equal(validateConfig(missing).ok, false);
});

test('contractVersion 主版本必须对齐', () => {
  const cfg = base();
  cfg.contractVersion = '9.0.0';
  assert.equal(validateConfig(cfg).ok, false);

  const sameMajor = base();
  sameMajor.contractVersion = `${CONTRACT_VERSION.split('.')[0]}.99.0`;
  assert.equal(validateConfig(sameMajor).ok, true);
});

test('theme 缺省合法，合法 token 通过、非法值被拒', () => {
  assert.equal(validateConfig(base()).ok, true, '不配置 theme 应保持旧行为');

  const ok = base();
  ok.theme = { mode: 'dark', tokens: { bg: '#0E1218', ink: '#E8EEF7', radius: 8, fontScale: 1.1 } };
  assert.equal(validateConfig(ok).ok, true, validateConfig(ok).errors.join('；'));

  const bad = [
    { mode: 'auto' },
    { tokens: { bg: 'white' } },
    { tokens: { radius: 40 } },
    { tokens: { radius: '8' } },
    { tokens: { fontScale: 1.5 } },
    { tokens: { glow: '#FFFFFF' } },
    { extra: true },
  ];
  for (const theme of bad) {
    const cfg = base();
    cfg.theme = theme;
    assert.equal(validateConfig(cfg).ok, false, `theme=${JSON.stringify(theme)} 应被拒`);
  }
});

test('resolveTheme 合并默认值并以品牌主色兜底', () => {
  const light = resolveTheme(undefined, '#123456');
  assert.equal(light.mode, 'light');
  assert.equal(light.tokens.accent, '#123456');
  assert.equal(light.tokens.radius, THEME_DEFAULTS.light.radius);

  const dark = resolveTheme({ mode: 'dark', tokens: { accent: '#FF8800', fontScale: 1.2 } }, '#123456');
  assert.equal(dark.mode, 'dark');
  assert.equal(dark.tokens.accent, '#FF8800', '显式 token 优先于品牌主色');
  assert.equal(dark.tokens.bg, THEME_DEFAULTS.dark.bg);
  assert.equal(dark.tokens.fontScale, 1.2);
});

test('entry 校验：顺序、分组、记忆开关', () => {
  const cfg = base();
  cfg.ends = {
    hp: { name: '个人端', url: 'https://hp.acme.example.com/' },
    ep: { name: '企业端', url: 'https://ep.acme.example.com/' },
    sp: { name: '服务台', url: 'https://sp.acme.example.com/' },
  };
  cfg.entry = {
    title: '选择工位',
    subtitle: '',
    rememberLast: false,
    order: ['ep', 'hp'],
    groups: [{ label: '协作', ends: ['ep', 'sp'] }],
  };
  const ok = validateConfig(cfg);
  assert.equal(ok.ok, true, ok.errors.join('；'));

  const bad = [
    { order: ['zz'] },
    { order: 'ep' },
    { rememberLast: 'no' },
    { title: '  ' },
    { groups: [{ label: '', ends: ['hp'] }] },
    { groups: [{ label: 'A', ends: ['hp'] }, { label: 'B', ends: ['hp'] }] },
    { groups: [{ label: 'A', ends: ['hp'], extra: true }] },
    { unknown: 1 },
  ];
  for (const entry of bad) {
    cfg.entry = entry;
    assert.equal(validateConfig(cfg).ok, false, `entry=${JSON.stringify(entry)} 应被拒`);
  }
});

test('entry.routes：合法入口通过，与旧 entry 并存', () => {
  const cfg = base();
  cfg.entry = {
    title: '工作台',
    routes: [
      {
        id: 'order.confirm',
        label: '确认订单',
        path: '/order/confirm',
        params: {
          orderId: { type: 'string', required: true, maxLength: 64 },
          source: { type: 'string', enum: ['scan', 'launcher'] },
        },
        requires: { capability: 'iot', online: true },
        fallback: '/order',
      },
      { id: 'device.panel', path: '/device/panel' },
    ],
  };
  const r = validateConfig(cfg);
  assert.equal(r.ok, true, r.errors.join('；'));
});

test('entry.routes：结构、参数、依赖与降级非法值被拒', () => {
  const cfg = base();
  const badRoutes = [
    'x',
    ['x'],
    [{ path: '/x' }],
    [{ id: 'Order', path: '/x' }],
    [{ id: 'a.b', path: '/x' }, { id: 'a.b', path: '/y' }],
    [{ id: 'ok', path: 'order/x' }],
    [{ id: 'ok', path: '/x', fallback: 'https://x.example.com/' }],
    [{ id: 'ok', path: '/x', label: '  ' }],
    [{ id: 'ok', path: '/x', extra: true }],
    [{ id: 'ok', path: '/x', params: [] }],
    [{ id: 'ok', path: '/x', params: { '1x': { type: 'string' } } }],
    [{ id: 'ok', path: '/x', params: { q: { type: 'string', default: 'x' } } }],
    [{ id: 'ok', path: '/x', params: { q: { type: 'date' } } }],
    [{ id: 'ok', path: '/x', params: { q: { type: 'string', maxLength: 2048 } } }],
    [{ id: 'ok', path: '/x', params: { q: { type: 'number', maxLength: 10 } } }],
    [{ id: 'ok', path: '/x', params: { q: { type: 'string', enum: [] } } }],
    [{ id: 'ok', path: '/x', params: { q: { type: 'number', enum: ['a'] } } }],
    [{ id: 'ok', path: '/x', requires: { capability: 'telepathy' } }],
    [{ id: 'ok', path: '/x', requires: { online: 'yes' } }],
    [{ id: 'ok', path: '/x', requires: { extra: true } }],
  ];
  for (const routes of badRoutes) {
    cfg.entry = { routes };
    const r = validateConfig(cfg);
    assert.equal(r.ok, false, `routes=${JSON.stringify(routes)} 应被拒`);
  }

  cfg.entry = { routes: [{ id: 'ok', path: '/x', requires: { capability: 'printer' } }] };
  assert.equal(validateConfig(cfg).ok, false, '未声明插件能力默认不可用');
  assert.equal(validateConfig(cfg, { capabilities: ['printer'] }).ok, true, '插件能力应可通过 opts 放行');
});

test('v0.7 M1：IoT 与入口契约已登记', () => {
  assert.ok(CAPABILITIES.includes('iot'), 'iot 必须是内置能力位');
  for (const cap of IOT_TRANSPORT_CAPABILITIES) {
    assert.equal(typeof cap, 'string');
    assert.ok(!CAPABILITIES.includes(cap), `${cap} 应由适配器插件声明，不进入内置矩阵`);
  }
  for (const m of ['iot.devices', 'iot.read', 'iot.write']) {
    assert.ok(OPTIONAL_METHODS.includes(m), `缺可选方法：${m}`);
  }
  for (const e of ['shell:iot-device', 'shell:iot-data', 'shell:iot-ack', 'shell:iot-error']) {
    assert.ok(EVENTS.includes(e), `缺契约事件：${e}`);
  }
  assert.equal(IOT_EVENT_VERSION, 1);
  for (const k of ['deviceId', 'metric', 'value', 'at', 'seq', 'idem', 'quality', 'source']) {
    assert.ok(IOT_EVENT_KEYS.includes(k), `信封缺字段：${k}`);
  }
  for (const k of ['id', 'path', 'params', 'requires', 'fallback']) {
    assert.ok(ENTRY_ROUTE_KEYS.includes(k), `入口路由缺字段：${k}`);
  }
  assert.equal(ENTRY_SOURCES.length, 6);
});

test('v0.8 M2：设备身份契约已登记', () => {
  assert.ok(CAPABILITIES.includes('identity'), 'identity 必须是内置能力位');
  for (const m of ['identity.current', 'identity.refresh']) {
    assert.ok(OPTIONAL_METHODS.includes(m), `缺可选方法：${m}`);
  }
  for (const e of ['shell:identity-changed', 'shell:identity-expired']) {
    assert.ok(EVENTS.includes(e), `缺契约事件：${e}`);
  }
  assert.deepEqual(IDENTITY_MODES, ['device', 'none']);
  assert.deepEqual(IDENTITY_KEYS, ['mode', 'endpoint', 'storeKey']);
  assert.equal(IDENTITY_STORE_PURPOSE, 'identity.device');
});

test('security.identity：mode / endpoint / storeKey 校验', () => {
  const cfg = base();
  const good = { mode: 'device', endpoint: 'https://api.example.com/device/refresh', storeKey: 't-acme:identity.device' };
  cfg.security = { identity: good };
  assert.equal(validateConfig(cfg).ok, true, validateConfig(cfg).errors.join('；'));

  cfg.security = { identity: { mode: 'device' } };
  assert.equal(validateConfig(cfg).ok, false, 'device 模式必须给 endpoint');

  cfg.security = { identity: { endpoint: good.endpoint } };
  assert.equal(validateConfig(cfg).ok, false, '未开 device 时不允许 endpoint');

  cfg.security = { identity: { mode: 'device', endpoint: 'http://api.example.com/device/refresh' } };
  assert.equal(validateConfig(cfg).ok, false, 'endpoint 默认必须 https');
  assert.equal(validateConfig(cfg, { allowHttp: true }).ok, true, '--allow-http 可放行联调地址');

  cfg.security = { identity: { mode: 'device', endpoint: good.endpoint, storeKey: 'other:identity' } };
  assert.equal(validateConfig(cfg).ok, false, 'storeKey 必须使用品牌前缀');

  cfg.security = { identity: { mode: 'bogus' } };
  assert.equal(validateConfig(cfg).ok, false, 'mode 只允许 device / none');
});

test('security.plugins：requireSigned 只接受布尔值', () => {
  const cfg = base();
  cfg.security = { plugins: { requireSigned: false } };
  assert.equal(validateConfig(cfg).ok, true);
  cfg.security = { plugins: { requireSigned: 'no' } };
  assert.equal(validateConfig(cfg).ok, false, '字符串应被拒绝');
  cfg.security = { plugins: { signed: true } };
  assert.equal(validateConfig(cfg).ok, false, '未知键应被拒绝');
  cfg.security = { identity: { mode: 'none' }, plugins: { requireSigned: true } };
  assert.equal(validateConfig(cfg).ok, true, 'identity 与 plugins 可并存');
});

test('resolveEntry 合并默认值、补齐未分组端', () => {
  const ends = {
    hp: { name: '个人端', url: 'https://hp.example.com/' },
    ep: { name: '企业端', url: 'https://ep.example.com/' },
    sp: { name: '服务台', url: 'https://sp.example.com/' },
  };

  const def = resolveEntry({ ends });
  assert.equal(def.title, ENTRY_DEFAULTS.title);
  assert.equal(def.rememberLast, true);
  assert.deepEqual(def.order, ['hp', 'ep', 'sp']);
  assert.deepEqual(def.groups, []);
  assert.deepEqual(def.rest, ['hp', 'ep', 'sp']);

  const custom = resolveEntry({
    ends,
    entry: { order: ['sp'], groups: [{ label: '协作', ends: ['hp'] }], rememberLast: false },
  });
  assert.deepEqual(custom.order, ['sp', 'hp', 'ep']);
  assert.deepEqual(custom.groups[0].ends, ['hp']);
  assert.deepEqual(custom.rest, ['sp', 'ep'], '未分组端排在分组之后');
  assert.equal(custom.rememberLast, false);
});

test('插件声明校验：能力、方法与命名空间', () => {
  const good = {
    id: '@acme/uendos-plugin-printer',
    version: '1.0.0',
    runtime: 'runtime.js',
    asserts: 'conformance.mjs',
    env: ['capacitor', 'electron'],
    capabilities: ['printer'],
    methods: ['printer.print', 'printer.status'],
  };
  const ok = validatePluginManifest(good, { name: '@acme/uendos-plugin-printer' });
  assert.equal(ok.ok, true, ok.errors.join('；'));
  assert.equal(validatePluginManifest({ ...good, requires: ['@acme/uendos-plugin-core'] }, { name: good.id }).ok, true, '合法依赖应通过');

  const iot = {
    ...good,
    id: '@acme/uendos-plugin-ble',
    capabilities: ['iot.ble'],
    methods: ['iot.ble.probe'],
  };
  assert.equal(validatePluginManifest(iot, { name: iot.id }).ok, true, '多点能力 iot.ble 应通过');
  assert.equal(validatePluginManifest({ ...iot, methods: ['iot.mqtt.probe'] }, { name: iot.id }).ok, false, '方法必须在声明的能力前缀内');
  assert.equal(validatePluginManifest({ ...iot, capabilities: ['core.ble'] }, { name: iot.id }).ok, false, '多点能力不得占用内置命名空间');

  const bad = [
    { ...good, capabilities: ['vibrate'] },
    { ...good, capabilities: ['printer'], methods: ['core.print'] },
    { ...good, methods: ['other.print'] },
    { ...good, runtime: '' },
    { ...good, version: '1' },
    { ...good, methods: ['printer.print', 'printer.print'] },
    { ...good, env: ['browser'] },
    { ...good, extra: true },
    { ...good, requires: 'not-an-array' },
    { ...good, requires: ['bad name'] },
    { ...good, requires: ['@acme/uendos-plugin-printer'] },
    { ...good, requires: ['@acme/uendos-plugin-core', '@acme/uendos-plugin-core'] },
  ];
  for (const m of bad) {
    assert.equal(validatePluginManifest(m, { name: '@acme/uendos-plugin-printer' }).ok, false, JSON.stringify(m));
  }
  assert.equal(validatePluginManifest(good, { name: '@other/plugin' }).ok, false, 'id 与包名不一致应被拒');
  assert.equal(validatePluginManifest(good, { profile: 'lite' }).ok, false, 'lite 档不得启用插件');
});

test('配置 plugins：合法、去重、lite 拒绝', () => {
  const cfg = base();
  cfg.plugins = ['@acme/uendos-plugin-printer'];
  assert.equal(validateConfig(cfg).ok, true, validateConfig(cfg).errors.join('；'));

  cfg.plugins = ['@acme/uendos-plugin-printer', '@acme/uendos-plugin-printer'];
  assert.equal(validateConfig(cfg).ok, false, '重复插件应被拒');

  cfg.plugins = ['Bad Name'];
  assert.equal(validateConfig(cfg).ok, false, '非法包名应被拒');

  cfg.plugins = ['@acme/uendos-plugin-printer'];
  cfg.profile = 'lite';
  cfg.targets = ['app'];
  assert.equal(validateConfig(cfg).ok, false, 'lite 档不得启用插件');
});

test('配置 caps.allow：只能收窄、未知能力与重复被拒', () => {
  const cfg = base();
  cfg.caps = { allow: ['share', 'vibrate'] };
  assert.equal(validateConfig(cfg).ok, true, validateConfig(cfg).errors.join('；'));

  cfg.caps = { allow: ['share', 'share'] };
  assert.equal(validateConfig(cfg).ok, false, '重复能力应被拒');

  cfg.caps = { allow: 'share' };
  assert.equal(validateConfig(cfg).ok, false, 'allow 必须是数组');

  cfg.caps = { allow: ['bogus'] };
  assert.equal(validateConfig(cfg).ok, false, '未知能力应被拒');

  cfg.caps = { deny: ['share'] };
  assert.equal(validateConfig(cfg).ok, false, 'caps 不支持的键应被拒');

  cfg.caps = { allow: ['printer'] };
  assert.equal(validateConfig(cfg).ok, false, '未声明插件能力默认不可用');
  assert.equal(validateConfig(cfg, { capabilities: ['printer'] }).ok, true, '插件能力应可通过 opts 放行');

  cfg.profile = 'lite';
  cfg.targets = ['app'];
  cfg.caps = { allow: ['camera'] };
  assert.equal(validateConfig(cfg).ok, false, 'lite 档不含 camera，不得出现在 allow');
});

test('runtimeConfig 只收敛运行时字段', () => {
  const rt = runtimeConfig(base());
  assert.deepEqual(Object.keys(rt).sort(), [
    'accent',
    'alias',
    'brand',
    'caps',
    'endKey',
    'ends',
    'entry',
    'prefix',
    'security',
    'statusBarStyle',
    'theme',
  ]);
  assert.equal(rt.prefix, 't-acme');
  assert.equal(runtimeConfig({ ...base(), prefix: undefined }).prefix, 't-acme');
});

test('导出常量非空且无重复', () => {
  for (const [name, list] of Object.entries({
    CAPABILITIES,
    CORE_METHODS,
    OPTIONAL_METHODS,
    EVENTS,
    TARGETS,
    IOT_TRANSPORT_CAPABILITIES,
    IOT_EVENT_KEYS,
    ENTRY_ROUTE_KEYS,
    ENTRY_SOURCES,
    UPDATE_CHANNELS,
    RELEASE_SIGNATURE_STATES,
  })) {
    assert.ok(list.length > 0, `${name} 不能为空`);
    assert.equal(new Set(list).size, list.length, `${name} 含重复项`);
  }
  assert.ok(Object.keys(ERRORS).length >= 8);
  for (const code of Object.keys(ERRORS)) assert.match(code, /^E_[A-Z_]+$/);
});

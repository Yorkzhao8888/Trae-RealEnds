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

  const bad = [
    { ...good, capabilities: ['vibrate'] },
    { ...good, capabilities: ['printer'], methods: ['core.print'] },
    { ...good, methods: ['other.print'] },
    { ...good, runtime: '' },
    { ...good, version: '1' },
    { ...good, methods: ['printer.print', 'printer.print'] },
    { ...good, env: ['browser'] },
    { ...good, extra: true },
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

test('runtimeConfig 只收敛运行时字段', () => {
  const rt = runtimeConfig(base());
  assert.deepEqual(Object.keys(rt).sort(), [
    'accent',
    'alias',
    'brand',
    'endKey',
    'ends',
    'prefix',
    'statusBarStyle',
    'theme',
  ]);
  assert.equal(rt.prefix, 't-acme');
  assert.equal(runtimeConfig({ ...base(), prefix: undefined }).prefix, 't-acme');
});

test('导出常量非空且无重复', () => {
  for (const [name, list] of Object.entries({ CAPABILITIES, CORE_METHODS, OPTIONAL_METHODS, EVENTS, TARGETS })) {
    assert.ok(list.length > 0, `${name} 不能为空`);
    assert.equal(new Set(list).size, list.length, `${name} 含重复项`);
  }
  assert.ok(Object.keys(ERRORS).length >= 8);
  for (const code of Object.keys(ERRORS)) assert.match(code, /^E_[A-Z_]+$/);
});

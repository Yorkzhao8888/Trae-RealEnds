import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateConfig,
  runtimeConfig,
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

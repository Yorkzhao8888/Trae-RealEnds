// profile 加载与校验：profile 是设备型号的「归一化契约」，不是业务规则。
// 新增型号只加一个 profile + fixture，不改网关代码。
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const TRANSPORTS = ['serial', 'ble', 'mqtt', 'nfc', 'http'];
const METRIC_TYPES = ['number', 'string', 'boolean'];
const PROFILE_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/;
const METRIC_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const PROFILE_KEYS = new Set(['profile', 'kind', 'description', 'staleAfterMs', 'match', 'metrics', 'actions']);
const MATCH_KEYS = new Set(['transport', 'vid', 'pid', 'model', 'manufacturer']);
const METRIC_KEYS = new Set(['type', 'unit', 'enum', 'scale', 'staleAfterMs', 'description']);

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isStale(v) {
  return Number.isInteger(v) && v >= 1000 && v <= 24 * 60 * 60 * 1000;
}

/** 手写校验：不引第三方依赖，和 schema/profile.schema.json 保持同一口径。 */
export function validateProfile(p) {
  const errors = [];
  if (!isObj(p)) return { ok: false, errors: ['profile 必须是对象'] };

  for (const k of Object.keys(p)) if (!PROFILE_KEYS.has(k)) errors.push(`未知字段 ${k}`);
  if (typeof p.profile !== 'string' || !PROFILE_RE.test(p.profile) || p.profile.length > 64) {
    errors.push('profile 必须是小写点分标识（如 retail.scanner.v1）');
  }
  if (p.kind !== undefined && (typeof p.kind !== 'string' || !p.kind || p.kind.length > 32)) errors.push('kind 非法');
  if (p.description !== undefined && (typeof p.description !== 'string' || p.description.length > 200)) errors.push('description 非法');
  if (p.staleAfterMs !== undefined && !isStale(p.staleAfterMs)) errors.push('staleAfterMs 必须是 1000..86400000 的整数');

  if (!isObj(p.match)) {
    errors.push('match 必填且必须是对象');
  } else {
    for (const k of Object.keys(p.match)) if (!MATCH_KEYS.has(k)) errors.push(`match.${k} 未知`);
    if (!TRANSPORTS.includes(p.match.transport)) errors.push(`match.transport 必须是 ${TRANSPORTS.join('/')}`);
    for (const k of ['vid', 'pid', 'model', 'manufacturer']) {
      const v = p.match[k];
      if (v !== undefined && (typeof v !== 'string' || !v || v.length > 64)) errors.push(`match.${k} 非法`);
    }
  }

  if (!isObj(p.metrics) || Object.keys(p.metrics).length === 0) {
    errors.push('metrics 必填且至少一个指标');
  } else {
    for (const [name, spec] of Object.entries(p.metrics)) {
      if (!METRIC_RE.test(name)) { errors.push(`metrics.${name} 名称非法`); continue; }
      if (!isObj(spec)) { errors.push(`metrics.${name} 必须是对象`); continue; }
      for (const k of Object.keys(spec)) if (!METRIC_KEYS.has(k)) errors.push(`metrics.${name}.${k} 未知`);
      if (!METRIC_TYPES.includes(spec.type)) errors.push(`metrics.${name}.type 必须是 ${METRIC_TYPES.join('/')}`);
      if (spec.unit !== undefined && spec.unit !== null && (typeof spec.unit !== 'string' || spec.unit.length > 16)) {
        errors.push(`metrics.${name}.unit 非法`);
      }
      if (spec.scale !== undefined && !Number.isFinite(spec.scale)) errors.push(`metrics.${name}.scale 非法`);
      if (spec.staleAfterMs !== undefined && !isStale(spec.staleAfterMs)) errors.push(`metrics.${name}.staleAfterMs 非法`);
      if (spec.enum !== undefined) {
        if (!Array.isArray(spec.enum) || !spec.enum.length || spec.enum.length > 32) errors.push(`metrics.${name}.enum 非法`);
        else if (!spec.enum.every((x) => typeof x === 'string' || typeof x === 'number')) errors.push(`metrics.${name}.enum 只能含字符串/数字`);
      }
    }
  }

  if (p.actions !== undefined) {
    if (!isObj(p.actions)) errors.push('actions 必须是对象');
    else {
      for (const [name, action] of Object.entries(p.actions)) {
        if (!isObj(action)) { errors.push(`actions.${name} 必须是对象`); continue; }
        if (typeof action.id !== 'string' || !action.id || action.id.length > 64) errors.push(`actions.${name}.id 必填`);
        if (action.label !== undefined && (typeof action.label !== 'string' || action.label.length > 64)) errors.push(`actions.${name}.label 非法`);
        if (action.params !== undefined && !isObj(action.params)) errors.push(`actions.${name}.params 必须是对象`);
        for (const k of Object.keys(action)) {
          if (!['id', 'label', 'params'].includes(k)) errors.push(`actions.${name}.${k} 未知`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export async function loadProfiles(dir) {
  const names = (await readdir(dir)).filter((n) => extname(n) === '.json').sort();
  const out = new Map();
  for (const name of names) {
    let p;
    try {
      p = JSON.parse(await readFile(join(dir, name), 'utf8'));
    } catch (e) {
      throw new Error(`profile ${name} 解析失败：${e.message}`);
    }
    const v = validateProfile(p);
    if (!v.ok) throw new Error(`profile ${name} 校验失败：${v.errors.join('; ')}`);
    if (out.has(p.profile)) throw new Error(`profile 重复：${p.profile}`);
    out.set(p.profile, p);
  }
  return out;
}

/** 优先用设备显式 profile；否则按 transport + vid/pid/model 做最具体匹配。 */
export function resolveProfile(profiles, device) {
  if (device.profile && profiles.has(device.profile)) return profiles.get(device.profile);

  const meta = isObj(device.meta) ? device.meta : {};
  let best = null;
  let bestScore = -1;
  for (const p of profiles.values()) {
    if (p.match.transport !== device.transport) continue;
    let score = 1;
    let ok = true;
    for (const f of ['vid', 'pid', 'model', 'manufacturer']) {
      if (p.match[f] === undefined) continue;
      const got = meta[f] !== undefined ? meta[f] : device[f];
      if (String(got ?? '') !== p.match[f]) { ok = false; break; }
      score++;
    }
    if (ok && score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

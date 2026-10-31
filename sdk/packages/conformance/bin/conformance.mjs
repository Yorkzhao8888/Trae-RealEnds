#!/usr/bin/env node
// 独立运行一致性测试：uendos-conformance <品牌桥文件>
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runConformance } from '../src/index.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const explicit = args.find((a) => !a.startsWith('--'));
const file = explicit || (() => {
  try {
    const dir = join(process.cwd(), 'shell');
    const f = readdirSync(dir).find((n) => n.endsWith('-shell.js'));
    return f ? join(dir, f) : null;
  } catch (e) { return null; }
})();

if (!file) {
  console.error('用法：uendos-conformance <品牌桥文件>（或在含 shell/ 的工程目录直接运行）');
  process.exit(2);
}

const r = await runConformance(file);
if (json) {
  console.log(JSON.stringify(r, null, 2));
} else {
  for (const item of r.results) console.log(`${item.ok ? '✓' : '✗'} ${item.name}${item.ok ? '' : ` — ${item.detail}`}`);
  console.log(`\n${r.ok ? '通过' : '失败'}：${r.passed} 通过 / ${r.failed} 失败`);
}
process.exit(r.ok ? 0 : 1);

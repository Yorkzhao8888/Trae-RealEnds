#!/usr/bin/env node
// 校验 SDK 内置运行时与 shell-core 源一致（供 CI / uendos doctor 使用）。
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const src = readFileSync(join(repoRoot, 'shell-core/src/core.js'), 'utf8');
const dst = readFileSync(join(here, '../src/core.js'), 'utf8');

if (!dst.endsWith(src)) {
  console.error('✗ SDK 运行时与 shell-core/src/core.js 不一致，请运行 node sdk/packages/shell/scripts/sync-core.mjs');
  process.exit(1);
}
console.log('✓ SDK 运行时与 shell-core 源一致');

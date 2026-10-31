#!/usr/bin/env node
// 把 shell-core/src/core.js 同步进 SDK 运行时包。
// 唯一真相仍是 shell-core；本文件只做机械复制，避免两份手改漂移。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const src = join(repoRoot, 'shell-core/src/core.js');
const dst = join(here, '../src/core.js');

const body = readFileSync(src, 'utf8');
const banner = `/* 同步自 shell-core/src/core.js（勿手改；运行 npm run sync:core 覆盖） */\n`;
writeFileSync(dst, banner + body);
console.log(`→ ${dst} (${(body.length / 1024).toFixed(1)} KB)`);

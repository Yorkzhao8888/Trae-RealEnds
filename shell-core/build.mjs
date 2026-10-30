#!/usr/bin/env node
// 由 core.js + 品牌配置生成自包含的品牌桥（无构建依赖）。
//
// 产物：<project>/shell/<file>  （Capacitor prepare-web.sh 原样拷贝到 dist/）
//       dist/<file>            （供 H5 直接部署与自检页使用）
//
// 用法：node build.mjs [--check]
//   --check 只校验生成结果与磁盘一致，不写文件（用于 CI）。

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');            // Trae-RealEnds/
const src = readFileSync(join(here, 'src/core.js'), 'utf8');
const checkOnly = process.argv.includes('--check');

const brandsDir = join(here, 'src/brands');
const brands = readdirSync(brandsDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(brandsDir, f), 'utf8')));

const banner = (b) => `/*! ${b.name} · 品牌桥 v${b.version || '0.2.0'} — 由 shell-core 生成，勿手改。

  源：shell-core/src/core.js + shell-core/src/brands/${b.brand}.json
  契约：docs/shell-contract.md
  重新生成：node shell-core/build.mjs
*/
`;

let failed = 0;
for (const b of brands) {
  const body = `${banner(b)}\n${src}\nShellCore.create(${JSON.stringify(b, null, 2)});\n`;
  const targets = [join(root, b.project, 'shell', b.file), join(here, 'dist', b.file)];
  for (const t of targets) {
    mkdirSync(dirname(t), { recursive: true });
    if (checkOnly) {
      const cur = existsSync(t) ? readFileSync(t, 'utf8') : '';
      if (cur !== body) {
        console.error(`✗ 与源不一致：${t}`);
        failed++;
      }
    } else {
      writeFileSync(t, body);
    }
  }
  console.log(`${checkOnly ? '✓' : '→'} ${b.brand}: ${b.file} (${(body.length / 1024).toFixed(1)} KB)`);
}

// 桌面壳：preload 由模板生成（只换品牌别名与版本号）
const DESKTOP = [
  { brand: 'ziway', project: 'ziway-pc-shell', alias: 'ziwayOS' },
  { brand: 'jechan', project: 'jechan-pc-shell', alias: 'jechanOS' },
  { brand: 'xso', project: 'xso-pc-shell', alias: 'xsoOS' },
];

const preloadTpl = readFileSync(join(here, 'src/preload-template.js'), 'utf8');
for (const d of DESKTOP) {
  const pkgPath = join(root, d.project, 'package.json');
  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  const body = preloadTpl.replace('__ALIAS__', d.alias).replace('__VERSION__', version);
  const target = join(root, d.project, 'preload.js');
  if (checkOnly) {
    const cur = existsSync(target) ? readFileSync(target, 'utf8') : '';
    if (cur !== body) { console.error(`✗ preload 与模板不一致：${d.project}`); failed++; }
  } else {
    writeFileSync(target, body);
  }
  console.log(`${checkOnly ? '✓' : '→'} ${d.project}/preload.js (v${version})`);
}

// 自检页随后端发布，供真机验收用
const selftest = join(here, 'src/selftest.html');
if (existsSync(selftest)) {
  const out = join(here, 'dist/selftest.html');
  if (checkOnly) {
    const cur = existsSync(out) ? readFileSync(out, 'utf8') : '';
    if (cur !== readFileSync(selftest, 'utf8')) { console.error('✗ 自检页与源不一致'); failed++; }
  } else {
    writeFileSync(out, readFileSync(selftest, 'utf8'));
    console.log('→ dist/selftest.html');
  }
}

if (checkOnly && failed) process.exit(1);

/**
 * @uendos/shell — 把运行时源码 + 品牌配置合成为自包含的品牌桥文件。
 *
 * 产物形态与 shell-core/build.mjs 完全一致，便于团队平滑迁移：
 *   banner + core.js + ShellCore.create(config)
 *
 * 运行时源码唯一真相仍是 shell-core/src/core.js；本包只做复制与合成。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHELL_VERSION = '0.3.2';
export const BRIDGE_VERSION = '2';

const here = dirname(fileURLToPath(import.meta.url));

/** 读取本包内置的运行时源码（由 scripts/sync-core.mjs 从 shell-core 同步） */
export function coreSource() {
  return readFileSync(join(here, 'core.js'), 'utf8');
}

/** 输出文件名：<brand>-shell.js，品牌前缀沿用历史命名 */
export function shellFileName(cfg) {
  const prefix = cfg.prefix || cfg.brand;
  return prefix === 'ziway' ? 'ziwayos-shell.js' : `${prefix}-shell.js`;
}

/**
 * 合成可直接部署的品牌桥文件。
 * @param {object} cfg uendos.config.json
 * @param {{core?: string, header?: string}} [opts]
 */
export function composeShellFile(cfg, opts = {}) {
  const core = opts.core || coreSource();
  const prefix = cfg.prefix || cfg.brand;
  const header = opts.header || `/*! ${cfg.displayName} · UendOS 品牌桥 v${SHELL_VERSION} — 由 \`uendos sync\` 生成，勿手改。

  配置：uendos.config.json（brand=${cfg.brand}）
  契约：@uendos/contract ${cfg.contractVersion || ''} · docs/shell-contract.md
  重新生成：npx uendos sync
*/
`;
  const runtimeCfg = {
    brand: cfg.brand,
    alias: cfg.alias,
    prefix,
    accent: cfg.accent,
    statusBarStyle: cfg.statusBarStyle || 'dark',
    endKey: cfg.endKey,
    ends: cfg.ends,
  };
  return `${header}${core}\nShellCore.create(${JSON.stringify(runtimeCfg, null, 2)});\n`;
}

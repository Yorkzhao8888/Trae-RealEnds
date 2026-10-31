/**
 * fixture 插件自带断言：uendos conformance 会把它合并到 39 项之后。
 * 每项形如 { name, run(Shell) }；run 抛异常即失败。
 */
export default [
  {
    name: '插件已注册且版本正确',
    run: (Shell) => {
      const p = (Shell.plugins || []).find((x) => x.id === '@uendos/plugin-fixture');
      if (!p) throw new Error('Shell.plugins 里没有 fixture');
      if (p.version !== '0.1.0') throw new Error(`version=${p.version}`);
      if (p.active !== true) throw new Error('插件未激活');
    },
  },
  {
    name: '能力 printer 已声明',
    run: (Shell) => {
      if (Shell.capabilities.printer !== '✓') throw new Error(`printer=${Shell.capabilities.printer}`);
    },
  },
  {
    name: 'printer.status 正常返回',
    run: async (Shell) => {
      const r = await Shell.call('printer.status');
      if (!r.ok || r.data.online !== true) throw new Error(JSON.stringify(r));
    },
  },
  {
    name: 'printer.print 缺参返回 E_BAD_ARGS',
    run: async (Shell) => {
      const r = await Shell.call('printer.print', {});
      if (r.ok || r.code !== 'E_BAD_ARGS') throw new Error(`code=${r.code}`);
    },
  },
  {
    name: '未声明方法返回 E_UNSUPPORTED',
    run: async (Shell) => {
      const r = await Shell.call('printer.receipt');
      if (r.ok || r.code !== 'E_UNSUPPORTED') throw new Error(`code=${r.code}`);
    },
  },
];

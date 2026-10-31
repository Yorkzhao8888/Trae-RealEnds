// fixture 插件运行时：由 CLI 包进函数作用域后注入品牌桥（顶层 return 合法）。
// 方法返回完整结果对象；抛异常由运行时统一映射 E_NATIVE。
var jobSeq = 0;

return {
  version: '0.1.0',
  capabilities: { printer: '✓' },
  methods: {
    'printer.print': function (a) {
      if (!a || typeof a.text !== 'string' || !a.text.trim()) {
        return { ok: false, code: 'E_BAD_ARGS', method: 'printer.print', message: 'text 必填' };
      }
      jobSeq += 1;
      return { ok: true, data: { jobId: 'fixture-' + jobSeq, text: a.text } };
    },
    'printer.status': function () {
      return { ok: true, data: { jobs: jobSeq, online: true } };
    },
  },
};

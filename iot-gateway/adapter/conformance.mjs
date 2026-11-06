/**
 * @uendos/plugin-iot-gateway · 断言：不依赖店根在线，只校验注册与只读语义。
 */
export default [
  {
    name: '网关适配器点亮 iot.gateway',
    run: (Shell) => {
      if (Shell.capabilities['iot.gateway'] !== '✓') throw new Error(`iot.gateway=${Shell.capabilities['iot.gateway']}`);
    },
  },
  {
    name: 'iot.gateway.status 不泄露令牌',
    run: async (Shell) => {
      const r = await Shell.call('iot.gateway.status');
      if (!r.ok || !r.data || r.data.readOnly !== true) throw new Error(JSON.stringify(r));
      if (Object.prototype.hasOwnProperty.call(r.data, 'token')) throw new Error('状态里出现了 token');
    },
  },
  {
    name: 'iot.read 缺参返回 E_BAD_ARGS',
    run: async (Shell) => {
      const r = await Shell.call('iot.read', {});
      if (r.ok || r.code !== 'E_BAD_ARGS') throw new Error(`code=${r.code}`);
    },
  },
];

// 假设备源：用 fixture JSON 驱动，不引入串口/BLE/MQTT 原生依赖。
// 真实适配器应实现同一套 worker 契约：detect / devices / subscribe。
import { readFile } from 'node:fs/promises';

async function readJson(file) {
  if (!file) return [];
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function createFixtureWorker({ devicesFile, eventsFile, intervalMs = 0 } = {}) {
  const devices = await readJson(devicesFile);
  const events = await readJson(eventsFile);

  return {
    id: 'fixture',
    transport: 'fixture',
    detect: () => true,
    devices: () => devices.slice(),
    subscribe(publish) {
      let stopped = false;
      let timer = null;

      function emit() {
        if (stopped) return;
        for (const e of events) publish({ ...e });
        if (intervalMs > 0) {
          timer = setTimeout(emit, intervalMs);
          timer.unref?.();
        }
      }

      emit();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
  };
}

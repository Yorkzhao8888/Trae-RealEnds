// 本地 spool：断网/店根不可达时事件先落盘，恢复后按 idem 重投。
// 与管理面上行同一条红线：先落盘成功再算「已采集」，不把内存里的数据当已送达。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function wire(event) {
  return JSON.stringify(event);
}

export function createMemorySpool() {
  let items = [];
  return {
    async append(events) { items.push(...events); },
    async peek(n) { return items.slice(0, n); },
    async ack(ids) {
      const drop = new Set(ids);
      items = items.filter((e) => !drop.has(e.spoolId));
    },
    async size() { return items.length; },
    async close() {},
  };
}

export async function createFileSpool(file) {
  await mkdir(dirname(file), { recursive: true }).catch(() => {});

  let items = [];
  try {
    const text = await readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e === 'object' && e.spoolId) items.push(e);
      } catch (err) {
        // 单行损坏不应拖垮整个网关；丢弃该行，后续重投由 idem 保证不重复
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  let chain = Promise.resolve();
  function run(fn) {
    const p = chain.then(fn, fn);
    chain = p.then(() => {}, () => {});
    return p;
  }

  async function persist() {
    const tmp = file + '.tmp';
    await writeFile(tmp, items.length ? items.map(wire).join('\n') + '\n' : '', 'utf8');
    await rename(tmp, file);
  }

  return {
    append(events) { return run(async () => { items.push(...events); await persist(); }); },
    peek(n) { return run(async () => items.slice(0, n)); },
    ack(ids) {
      return run(async () => {
        const drop = new Set(ids);
        items = items.filter((e) => !drop.has(e.spoolId));
        await persist();
      });
    },
    size() { return run(async () => items.length); },
    close() { return run(async () => {}); },
  };
}

export async function openSpool(file) {
  return file ? createFileSpool(file) : createMemorySpool();
}

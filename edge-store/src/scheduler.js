// 定时回传：指数退避 + 冲突暂停 + 云根连通性自标记。
//
// 为什么需要后台循环：手动 POST /edge/sync 在市场里没人会点。
// 但"自动重试"必须克制：门店 Wi-Fi 抖动时不能把上行带宽打满，
// 所以失败按 2^n 退避封顶，冲突则完全暂停（等人处理，避免刷 409）。
import { syncOnce, openConflicts } from './sync.js';
import { metaGet, metaSet } from './db.js';

const DEFAULTS = {
  baseMs: 30 * 1000,
  maxMs: 15 * 60 * 1000,
  failThreshold: 3,
};

export function startSync({ db, send, baseMs = DEFAULTS.baseMs, maxMs = DEFAULTS.maxMs, failThreshold = DEFAULTS.failThreshold, onTick } = {}) {
  let stopped = false;
  let timer = null;
  let backoff = baseMs;
  let fails = 0;
  let paused = false;
  let last = { at: Date.now(), ok: null, sent: 0, cursor: Number(metaGet(db, 'syncedSeq') || 0) };

  async function tick() {
    if (stopped) return;
    // 有未处理冲突时不传：宁可停，也不刷一屏 409
    const openCnt = openConflicts(db).length;
    if (openCnt > 0) {
      paused = true;
      last = { at: Date.now(), ok: false, sent: 0, paused: true, conflicts: openCnt, cursor: Number(metaGet(db, 'syncedSeq') || 0) };
      schedule(baseMs);
      if (onTick) onTick(last);
      return last;
    }
    paused = false;

    const r = await syncOnce(db, send);
    last = { at: Date.now(), ...r };

    if (r.ok) {
      if (r.sent > 0) {
        fails = 0;
        backoff = baseMs;
        if (metaGet(db, 'cloudOffline') === '1') metaSet(db, 'cloudOffline', '0');
      }
    } else if (r.conflict) {
      // 冲突：暂停，等人裁决；不累计失败次数
      paused = true;
      backoff = baseMs;
    } else if (r.retryable) {
      fails++;
      if (fails >= failThreshold && metaGet(db, 'cloudOffline') !== '1') metaSet(db, 'cloudOffline', '1');
      backoff = Math.min(backoff * 2, maxMs);
    } else {
      // 4xx 非冲突：参数/凭据问题，重试无意义，退到最慢档
      backoff = maxMs;
    }

    if (onTick) onTick(last);
    schedule(backoff);
    return last;
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
    timer.unref?.();
  }

  async function now() {
    clearTimeout(timer);
    await tick();
    return last;
  }

  function status() {
    return { running: !stopped, paused, backoffMs: backoff, fails, last };
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
  }

  schedule(baseMs); // 启动不立刻抢跑，给店内打印/开台留出带宽
  return { status, stop, now, tick };
}

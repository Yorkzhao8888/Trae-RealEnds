// 下行读模型（云根 → 店根）：商品/价格的增量拉取。
//
// 上行（sync.js）保证店内的成交被云根看见；下行（本文件）保证店内的
// 商品与价格跟得上云根。两条链路各自独立：下行失败不该影响上行，
// 更不能把云根"离线"标记从下行侧错误地打上或清掉。
import { metaGet, metaSet, applyCatalog } from './db.js';

/**
 * 拉一批。fetchCatalog(since) 返回 { status, body } 或抛错。
 * 云根契约：GET /cloud/catalog?since=<cursor>
 *   → { cursor, items: [{ sku, name, price, status, updatedAt }] }
 * 游标只在本批真正落库后才前进——失败绝不跳批。
 */
export async function pullOnce(db, fetchCatalog) {
  const since = Number(metaGet(db, 'catalogSeq') || 0);

  let res;
  try {
    res = await fetchCatalog(since);
  } catch (e) {
    return { ok: false, retryable: true, since, error: e.message };
  }

  if (res.status !== 200) {
    // 5xx / 网络类可重试；4xx 是契约或凭据问题，重试无意义
    return { ok: false, retryable: res.status >= 500, status: res.status, since };
  }

  const body = res.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  const r = applyCatalog(db, items);

  // 云根给游标就用它；没给就取本批最大 updatedAt，且永不回退
  let cursor = Number(body.cursor);
  if (!Number.isFinite(cursor)) {
    cursor = items.reduce((m, it) => Math.max(m, Number(it && it.updatedAt) || 0), since);
  }
  cursor = Math.max(cursor, since);
  metaSet(db, 'catalogSeq', cursor);

  return { ok: true, ...r, cursor };
}

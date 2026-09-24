// 後台 · 訂單系統
//   篩選 / 搜尋 / 排序 / 匯出 CSV / 批次改狀態 / 編輯 + 版本回溯 / 垃圾桶
//
// ★ 這個檔要特別小心的地方：
//   改訂單數量、作廢訂單、回到舊版本 —— 這三件事都會讓「已賣出的數量」對不上，
//   所以每一個都要同步調整 product_stock.qty_sold 與 addons.stock。
//   調整不成功（庫存不夠）就整筆拒絕，不留半套。

import { json, str, int, nowTW } from "./lib.js";

const MAX_REVISIONS = 20;

// 可以拿來排序的欄位（白名單：不在名單上的一律當作預設，避免有人塞奇怪的字串進 SQL）
const SORTABLE = new Set([
  "created_at", "ship_date", "order_no", "ship_method", "buyer_name", "rcpt_name",
  "buyer_phone", "amount", "pay_status", "order_status", "last5", "id",
]);

// ═══════════ 快照與版本 ═══════════

export async function snapshotOrder(env, orderId) {
  const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
  const items = await env.DB.prepare(
    "SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC"
  ).bind(orderId).all();
  return { order, items: items.results || [] };
}

export async function pushRevision(env, orderId, summary, who) {
  const snap = await snapshotOrder(env, orderId);
  await env.DB.prepare(
    "INSERT INTO order_revisions (order_id, snapshot, summary, changed_by, changed_at) VALUES (?,?,?,?,?)"
  ).bind(orderId, JSON.stringify(snap), summary, who, nowTW()).run();

  // 只留最近 N 版，不然快照會把資料庫養肥
  await env.DB.prepare(
    `DELETE FROM order_revisions
      WHERE order_id = ?1 AND id NOT IN (
        SELECT id FROM order_revisions WHERE order_id = ?1 ORDER BY id DESC LIMIT ${MAX_REVISIONS})`
  ).bind(orderId).run();
}

// ═══════════ 庫存調整（這個檔的核心）═══════════
//
// 傳入「原本的明細」與「新的明細」，算出每個品項的差值後一次調整。
// 任何一項扣不動就整批退回，回傳失敗原因。
async function adjustStock(env, shipDate, oldItems, newItems) {
  const delta = new Map();          // key = 'product:3' / 'addon:1'
  const nameOf = new Map();

  const add = (it, sign) => {
    const key = `${it.kind}:${it.ref_id}`;
    delta.set(key, (delta.get(key) || 0) + sign * int(it.qty));
    nameOf.set(key, it.name || key);
  };
  for (const it of oldItems) add(it, -1);
  for (const it of newItems) add(it, +1);

  const applied = [];
  const undo = async () => {
    for (const [key, n] of applied) {
      const [kind, refId] = key.split(":");
      if (kind === "product") {
        await env.DB.prepare(
          "UPDATE product_stock SET qty_sold = MAX(0, qty_sold - ?1) WHERE product_id = ?2 AND ship_date = ?3"
        ).bind(n, int(refId), shipDate).run();
      } else {
        await env.DB.prepare("UPDATE addons SET stock = stock + ?1 WHERE id = ?2").bind(n, int(refId)).run();
      }
    }
  };

  for (const [key, n] of delta) {
    if (n === 0) continue;
    const [kind, refId] = key.split(":");

    if (kind === "product") {
      if (n > 0) {
        const r = await env.DB.prepare(
          `UPDATE product_stock SET qty_sold = qty_sold + ?1
            WHERE product_id = ?2 AND ship_date = ?3 AND qty_sold + ?1 <= qty_total`
        ).bind(n, int(refId), shipDate).run();
        if (!r.meta.changes) {
          await undo();
          return { ok: false, message: `${nameOf.get(key)} 在 ${shipDate} 的數量不夠，沒辦法加到這麼多` };
        }
        applied.push([key, n]);
      } else {
        await env.DB.prepare(
          "UPDATE product_stock SET qty_sold = MAX(0, qty_sold + ?1) WHERE product_id = ?2 AND ship_date = ?3"
        ).bind(n, int(refId), shipDate).run();
        applied.push([key, n]);
      }
    } else {
      if (n > 0) {
        const r = await env.DB.prepare(
          "UPDATE addons SET stock = stock - ?1 WHERE id = ?2 AND stock >= ?1"
        ).bind(n, int(refId)).run();
        if (!r.meta.changes) {
          await undo();
          return { ok: false, message: `${nameOf.get(key)} 的庫存不夠` };
        }
        applied.push([key, n]);
      } else {
        await env.DB.prepare("UPDATE addons SET stock = stock - ?1 WHERE id = ?2").bind(n, int(refId)).run();
        applied.push([key, n]);
      }
    }
  }
  return { ok: true };
}

// 作廢 / 復原：整筆訂單的量還回去或再扣回來
async function releaseOrder(env, orderId, give) {
  const snap = await snapshotOrder(env, orderId);
  const items = snap.items;
  const date = snap.order.ship_date;
  return give
    ? adjustStock(env, date, items, [])      // 還回去
    : adjustStock(env, date, [], items);     // 再扣回來
}

// ═══════════ 列表（篩選 / 搜尋 / 排序）═══════════

function buildWhere(url) {
  const w = ["deleted_at = ''"], b = [];
  const p = (k) => str(url.searchParams.get(k));

  const dateCol = p("date_type") === "ship" ? "ship_date" : "created_at";
  if (p("from")) { w.push(`${dateCol} >= ?`); b.push(p("from")); }
  if (p("to"))   { w.push(`${dateCol} <= ?`); b.push(p("to") + (dateCol === "created_at" ? " 23:59" : "")); }
  if (p("pay_status"))   { w.push("pay_status = ?");   b.push(p("pay_status")); }
  if (p("order_status")) { w.push("order_status = ?"); b.push(p("order_status")); }
  if (p("ship_method"))  { w.push("ship_method = ?");  b.push(p("ship_method")); }

  const q = p("q");
  if (q) {
    w.push("(buyer_name LIKE ?1 OR rcpt_name LIKE ?1 OR buyer_phone LIKE ?1 OR rcpt_phone LIKE ?1 OR order_no LIKE ?1 OR last5 LIKE ?1)");
    b.push(`%${q}%`);
  }
  return { where: w.join(" AND "), binds: b };
}

function buildOrderBy(url) {
  const sort = SORTABLE.has(str(url.searchParams.get("sort"))) ? str(url.searchParams.get("sort")) : "created_at";
  const dir = str(url.searchParams.get("dir")).toLowerCase() === "asc" ? "ASC" : "DESC";
  return `ORDER BY ${sort} ${dir}, id ${dir}`;
}

async function listOrders(url, env) {
  const { where, binds } = buildWhere(url);
  const limit = Math.min(int(url.searchParams.get("limit"), 200), 500);
  const r = await env.DB.prepare(
    `SELECT * FROM orders WHERE ${where} ${buildOrderBy(url)} LIMIT ${limit}`
  ).bind(...binds).all();
  const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE ${where}`).bind(...binds).first();
  return json({ ok: true, orders: r.results || [], total: int(c && c.n, 0) });
}

// ═══════════ 匯出 CSV（匯出目前篩選的結果）═══════════

const CSV_COLS = [
  ["訂購日期", "created_at"], ["出貨日期", "ship_date"], ["訂單編號", "order_no"],
  ["配送方式", "ship_method_label"], ["訂購人", "buyer_name"], ["訂購人電話", "buyer_phone"],
  ["訂購人Email", "buyer_email"], ["收件人", "rcpt_name"], ["收件人電話", "rcpt_phone"],
  ["收件地址", "rcpt_full_address"], ["商品明細", "items_text"],
  ["商品小計", "subtotal"], ["運費", "ship_fee"], ["金額", "amount"],
  ["付款狀態", "pay_status"], ["訂單狀態", "order_status"], ["匯款末五碼", "last5"], ["備註", "note"],
];

async function exportCsv(url, env) {
  const { where, binds } = buildWhere(url);
  const r = await env.DB.prepare(`SELECT * FROM orders WHERE ${where} ${buildOrderBy(url)} LIMIT 5000`).bind(...binds).all();
  const rows = r.results || [];

  const shipRows = await env.DB.prepare("SELECT method, label FROM shipping").all();
  const label = {};
  for (const s of shipRows.results || []) label[s.method] = s.label;

  // 一次撈出所有明細，不要一筆一筆查
  let itemsByOrder = {};
  if (rows.length) {
    const ids = rows.map((o) => o.id);
    const ph = ids.map(() => "?").join(",");
    const ir = await env.DB.prepare(
      `SELECT order_id, kind, name, qty FROM order_items WHERE order_id IN (${ph}) ORDER BY id ASC`
    ).bind(...ids).all();
    for (const it of ir.results || []) {
      (itemsByOrder[it.order_id] = itemsByOrder[it.order_id] || [])
        .push(`${it.kind === "addon" ? "＋" : ""}${it.name}×${it.qty}`);
    }
  }

  const cell = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const lines = [CSV_COLS.map((c) => cell(c[0])).join(",")];
  for (const o of rows) {
    const extra = {
      ship_method_label: label[o.ship_method] || o.ship_method,
      rcpt_full_address: `${o.rcpt_zip} ${o.rcpt_county}${o.rcpt_district}${o.rcpt_address}`.trim(),
      items_text: (itemsByOrder[o.id] || []).join(" / "),
    };
    lines.push(CSV_COLS.map((c) => cell(c[1] in extra ? extra[c[1]] : o[c[1]])).join(","));
  }
  const csv = "﻿" + lines.join("\r\n");   // BOM：Excel 開才不會中文亂碼

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="orders-${nowTW().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

// ═══════════ 單筆：看 / 改 / 版本 ═══════════

async function getOrder(url, env) {
  const id = int(url.searchParams.get("id"));
  const snap = await snapshotOrder(env, id);
  if (!snap.order) return json({ ok: false, error: "not_found" }, 404);
  const rev = await env.DB.prepare(
    "SELECT id, summary, changed_by, changed_at FROM order_revisions WHERE order_id = ? ORDER BY id DESC"
  ).bind(id).all();
  return json({ ok: true, order: snap.order, items: snap.items, revisions: rev.results || [] });
}

// 可以在後台改的欄位
const EDITABLE = {
  ship_date: "text", ship_method: "text",
  buyer_name: "text", buyer_phone: "text", buyer_email: "text",
  buyer_county: "text", buyer_district: "text", buyer_zip: "text", buyer_address: "text",
  rcpt_name: "text", rcpt_phone: "text", rcpt_email: "text",
  rcpt_county: "text", rcpt_district: "text", rcpt_zip: "text", rcpt_address: "text",
  subtotal: "int", ship_fee: "int", amount: "int",
  last5: "text", note: "text", pay_status: "text", order_status: "text",
};

const LABEL = {
  ship_date: "出貨日", ship_method: "配送方式", amount: "總金額", subtotal: "商品小計", ship_fee: "運費",
  pay_status: "付款狀態", order_status: "訂單狀態", last5: "末五碼", note: "備註",
  buyer_name: "訂購人", rcpt_name: "收件人",
};

async function saveOrder(request, env, me) {
  const b = await request.json().catch(() => ({}));
  const id = int(b.id);
  if (!id) return json({ ok: false, error: "bad_params" }, 400);

  const before = await snapshotOrder(env, id);
  if (!before.order) return json({ ok: false, error: "not_found" }, 404);

  const changes = [];

  // ── 1. 明細數量（會動到庫存，先處理）──
  if (Array.isArray(b.items)) {
    const newItems = before.items.map((old) => {
      const hit = b.items.find((x) => int(x.id) === old.id);
      return hit ? { ...old, qty: int(hit.qty, old.qty) } : old;
    }).filter((it) => it.qty > 0);

    const dateNow = str(b.ship_date) || before.order.ship_date;
    const r = await adjustStock(env, dateNow, before.items, newItems);
    if (!r.ok) return json({ ok: false, error: "no_stock", message: r.message }, 409);

    for (const it of newItems) {
      const old = before.items.find((x) => x.id === it.id);
      if (old && old.qty !== it.qty) {
        changes.push(`${it.name} ${old.qty}→${it.qty}`);
        await env.DB.prepare("UPDATE order_items SET qty = ? WHERE id = ?").bind(it.qty, it.id).run();
      }
    }
    for (const old of before.items) {
      if (!newItems.find((x) => x.id === old.id)) {
        changes.push(`移除 ${old.name}`);
        await env.DB.prepare("DELETE FROM order_items WHERE id = ?").bind(old.id).run();
      }
    }
  }

  // ── 2. 作廢 / 復原（整筆的量要還回去或扣回來）──
  const newStatus = str(b.order_status);
  const wasVoid = before.order.order_status === "已作廢";
  const willVoid = newStatus === "已作廢";
  if (newStatus && wasVoid !== willVoid) {
    const r = await releaseOrder(env, id, willVoid);
    if (!r.ok) return json({ ok: false, error: "no_stock", message: r.message }, 409);
  }

  // ── 3. 一般欄位 ──
  const cols = [], vals = [];
  for (const k in EDITABLE) {
    if (b[k] === undefined) continue;
    const v = EDITABLE[k] === "int" ? int(b[k]) : str(b[k]);
    if (String(before.order[k]) === String(v)) continue;
    cols.push(k); vals.push(v);
    changes.push(`${LABEL[k] || k} ${before.order[k] || "（空）"}→${v || "（空）"}`);
  }
  if (cols.length) {
    cols.push("updated_at"); vals.push(nowTW());
    await env.DB.prepare(`UPDATE orders SET ${cols.map((c) => c + " = ?").join(", ")} WHERE id = ?`)
      .bind(...vals, id).run();
  }

  if (!changes.length) return json({ ok: true, unchanged: true });

  await pushRevision(env, id, changes.join("、"), me.username);
  const after = await snapshotOrder(env, id);
  return json({ ok: true, order: after.order, items: after.items, summary: changes.join("、") });
}

// 回到某一版
async function revertOrder(request, env, me) {
  const b = await request.json().catch(() => ({}));
  const id = int(b.id), revId = int(b.revision_id);
  if (!id || !revId) return json({ ok: false, error: "bad_params" }, 400);

  const rev = await env.DB.prepare(
    "SELECT * FROM order_revisions WHERE id = ? AND order_id = ?"
  ).bind(revId, id).first();
  if (!rev) return json({ ok: false, error: "not_found", message: "找不到這一版" }, 404);

  let snap;
  try { snap = JSON.parse(rev.snapshot); } catch (e) { snap = null; }
  if (!snap || !snap.order) return json({ ok: false, error: "bad_snapshot", message: "這一版的內容壞掉了，沒辦法還原" }, 500);

  const before = await snapshotOrder(env, id);

  // 庫存先調整成那一版的樣子，調不動就不還原
  const r = await adjustStock(env, snap.order.ship_date || before.order.ship_date, before.items, snap.items || []);
  if (!r.ok) return json({ ok: false, error: "no_stock", message: r.message }, 409);

  const cols = [], vals = [];
  for (const k in EDITABLE) {
    if (snap.order[k] === undefined) continue;
    cols.push(k); vals.push(snap.order[k]);
  }
  cols.push("updated_at"); vals.push(nowTW());
  await env.DB.prepare(`UPDATE orders SET ${cols.map((c) => c + " = ?").join(", ")} WHERE id = ?`)
    .bind(...vals, id).run();

  await env.DB.prepare("DELETE FROM order_items WHERE order_id = ?").bind(id).run();
  for (const it of snap.items || []) {
    await env.DB.prepare(
      `INSERT INTO order_items (order_id, kind, ref_id, name, unit_price, qty, parent_item_id)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(id, it.kind, it.ref_id, it.name, it.unit_price, it.qty, it.parent_item_id || 0).run();
  }

  await pushRevision(env, id, `回到 ${rev.changed_at} 那一版`, me.username);
  const after = await snapshotOrder(env, id);
  return json({ ok: true, order: after.order, items: after.items });
}

// ═══════════ 批次改狀態 ═══════════

async function batchUpdate(request, env, me) {
  const b = await request.json().catch(() => ({}));
  const ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => int(x)).filter(Boolean);
  const field = str(b.field), value = str(b.value);
  if (!ids.length || !["pay_status", "order_status"].includes(field) || !value)
    return json({ ok: false, error: "bad_params" }, 400);

  let done = 0; const failed = [];
  for (const id of ids) {
    if (field === "order_status") {
      const cur = await env.DB.prepare("SELECT order_status FROM orders WHERE id = ?").bind(id).first();
      if (!cur) { failed.push({ id, why: "找不到" }); continue; }
      const wasVoid = cur.order_status === "已作廢", willVoid = value === "已作廢";
      if (wasVoid !== willVoid) {
        const r = await releaseOrder(env, id, willVoid);
        if (!r.ok) { failed.push({ id, why: r.message }); continue; }
      }
    }
    await env.DB.prepare(`UPDATE orders SET ${field} = ?, updated_at = ? WHERE id = ?`)
      .bind(value, nowTW(), id).run();
    await pushRevision(env, id, `批次修改：${LABEL[field]} → ${value}`, me.username);
    done++;
  }
  return json({ ok: failed.length === 0, done, failed });
}

// ═══════════ 垃圾桶 ═══════════

async function trashOrder(request, env, me, action) {
  const b = await request.json().catch(() => ({}));
  const id = int(b.id);
  if (!id) return json({ ok: false, error: "bad_params" }, 400);

  if (action === "delete") {
    const o = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND deleted_at = ''").bind(id).first();
    if (!o) return json({ ok: false, error: "not_found", message: "找不到這筆訂單（可能已經刪除了）" }, 404);
    if (o.order_status !== "已作廢") {
      const r = await releaseOrder(env, id, true);       // 還庫存
      if (!r.ok) return json({ ok: false, error: "stock_error", message: r.message }, 409);
    }
    await env.DB.prepare("UPDATE orders SET deleted_at = ? WHERE id = ?").bind(nowTW(), id).run();
    return json({ ok: true });
  }

  if (action === "restore") {
    const o = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND deleted_at != ''").bind(id).first();
    if (!o) return json({ ok: false, error: "not_found", message: "垃圾桶裡找不到這筆訂單" }, 404);
    if (o.order_status !== "已作廢") {
      const r = await releaseOrder(env, id, false);      // 扣回來
      if (!r.ok) return json({ ok: false, error: "no_stock", message: r.message }, 409);
    }
    await env.DB.prepare("UPDATE orders SET deleted_at = '' WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }

  // 永久刪除：只能刪垃圾桶裡的
  const r = await env.DB.prepare("DELETE FROM orders WHERE id = ? AND deleted_at != ''").bind(id).run();
  if (!r.meta.changes) return json({ ok: false, error: "not_found", message: "垃圾桶裡找不到這筆訂單" }, 404);
  await env.DB.prepare("DELETE FROM order_items WHERE order_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM order_revisions WHERE order_id = ?").bind(id).run();
  return json({ ok: true });
}

// ═══════════ 路由 ═══════════

export async function handleOrders(path, request, env, me) {
  const url = new URL(request.url);
  const M = request.method;

  if (path === "/api/admin/orders" && M === "GET") return listOrders(url, env);
  if (path === "/api/admin/export" && M === "GET") return exportCsv(url, env);
  if (path === "/api/admin/order" && M === "GET") return getOrder(url, env);
  if (path === "/api/admin/order-save" && M === "POST") return saveOrder(request, env, me);
  if (path === "/api/admin/order-revert" && M === "POST") return revertOrder(request, env, me);
  if (path === "/api/admin/orders-batch" && M === "POST") return batchUpdate(request, env, me);

  if (path === "/api/admin/trash" && M === "GET") {
    const r = await env.DB.prepare(
      "SELECT * FROM orders WHERE deleted_at != '' ORDER BY deleted_at DESC, id DESC LIMIT 500"
    ).all();
    return json({ ok: true, orders: r.results || [] });
  }
  if (path === "/api/admin/order-delete" && M === "POST") return trashOrder(request, env, me, "delete");
  if (path === "/api/admin/order-restore" && M === "POST") return trashOrder(request, env, me, "restore");
  if (path === "/api/admin/order-purge" && M === "POST") return trashOrder(request, env, me, "purge");

  return null;
}

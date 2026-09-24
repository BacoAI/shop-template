// 前台 API —— 客人會打到的那些
//
// ★ 這個檔裡最重要的兩件事：
//   1. calcAmount()      全站唯一算錢的地方。前台顯示的都只是預估。
//   2. takeStock()       擋超賣。多商品之後要「全部都扣得到才算數」，有一項失敗就全部退回。

import { json, str, int, jsonParse, nowTW, todayTW, addDays, isDate, getSettings } from "./lib.js";
import { sendOrderMail } from "./mail.js";
import { pushRevision } from "./orders.js";

// ═══════════ 共用查詢 ═══════════

async function liveProducts(env) {
  const r = await env.DB.prepare(
    "SELECT * FROM products WHERE status = 'on' ORDER BY sort_order ASC, id ASC"
  ).all();
  return r.results || [];
}

async function shippingMap(env) {
  const r = await env.DB.prepare("SELECT * FROM shipping WHERE enabled = 1").all();
  const m = {};
  for (const row of r.results || []) m[row.method] = row;
  return m;
}

// 把商品送出去給前台時，不要帶內部欄位
function publicProduct(p) {
  return {
    id: p.id,
    name: p.name,
    subtitle: p.subtitle,
    thumb: p.thumb,
    photos: jsonParse(p.photos, []),
    intro: p.intro,
    description: p.description,
    price: p.price,
    ship_methods: jsonParse(p.ship_methods, ["normal"]),
    ship_primary: p.ship_primary,
    addon_ids: jsonParse(p.addon_ids, []),
    max_per_order: p.max_per_order,
  };
}

// ═══════════ 配送方式：整單用哪一種寄 ═══════════
//
// 規則（2026-09-24 定案）：
//   1. 取購物車內所有商品「可用配送」的交集
//   2. 交集是空的 → 衝突，不給下單
//   3. 交集不只一個 → 挑「保存要求最高」的那個（冷凍 > 冷藏 > 常溫）
//      先看交集裡有沒有商品把它設為 primary，有就從那些裡面挑最高的
//
// 為什麼要最高：冷凍品用常溫寄會壞掉。寧可運費貴一點，不要東西出事。
export function resolveShipMethod(products, shipCfg) {
  if (!products.length) return { ok: false, empty: true };

  let inter = null;
  for (const p of products) {
    const ms = jsonParse(p.ship_methods, ["normal"]).filter((m) => shipCfg[m]);
    inter = inter === null ? ms.slice() : inter.filter((m) => ms.includes(m));
  }

  if (!inter || !inter.length) {
    return {
      ok: false,
      conflict: true,
      detail: products.map((p) => ({
        name: p.name,
        methods: jsonParse(p.ship_methods, []).map((m) => (shipCfg[m] ? shipCfg[m].label : m)),
      })),
    };
  }

  const prims = products.map((p) => p.ship_primary).filter((m) => inter.includes(m));
  const pool = prims.length ? prims : inter;
  const method = pool.sort((a, b) => (shipCfg[b].rank || 0) - (shipCfg[a].rank || 0))[0];
  return { ok: true, method, options: inter };
}

// ═══════════ 金額：全站唯一算錢的地方 ═══════════
//
// 免運門檻只看「商品小計」，不含運費 ——
// 不然會變成「運費影響總額、總額又決定運費」的死結。
export function calcAmount(subtotal, cfg) {
  const base = int(cfg && cfg.fee, 0);
  const threshold = int(cfg && cfg.free_threshold, 0);
  const freeShipped = threshold > 0 && subtotal >= threshold;
  const shipFee = freeShipped ? 0 : base;
  return { subtotal, shipFee, amount: subtotal + shipFee, freeShipped, threshold, baseFee: base };
}

// ═══════════ 把購物車內容換成「真實的商品與價格」 ═══════════
// 前台傳來的只有 id 與數量，價格一律以資料庫為準。
async function resolveCart(env, rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  if (!items.length) return { ok: false, error: "empty_cart", message: "購物車是空的" };

  const prodIds = [...new Set(items.map((i) => int(i.id)).filter(Boolean))];
  if (!prodIds.length) return { ok: false, error: "empty_cart", message: "購物車是空的" };

  const ph = prodIds.map(() => "?").join(",");
  const pr = await env.DB.prepare(
    `SELECT * FROM products WHERE id IN (${ph}) AND status = 'on'`
  ).bind(...prodIds).all();
  const prodMap = {};
  for (const p of pr.results || []) prodMap[p.id] = p;

  const gone = prodIds.filter((id) => !prodMap[id]);
  if (gone.length) {
    return { ok: false, error: "product_gone", gone, message: "購物車裡有商品已經停售了" };
  }

  // 加購品
  const addonIds = [...new Set(items.flatMap((i) => (i.addons || []).map((a) => int(a.id))).filter(Boolean))];
  const addonMap = {};
  if (addonIds.length) {
    const ah = addonIds.map(() => "?").join(",");
    const ar = await env.DB.prepare(
      `SELECT * FROM addons WHERE id IN (${ah}) AND status = 'on'`
    ).bind(...addonIds).all();
    for (const a of ar.results || []) addonMap[a.id] = a;
  }

  const lines = [];
  let subtotal = 0;

  for (const raw of items) {
    const p = prodMap[int(raw.id)];
    const qty = int(raw.qty, 0);
    if (qty < 1) return { ok: false, error: "bad_qty", message: "數量不對" };
    if (p.max_per_order > 0 && qty > p.max_per_order)
      return { ok: false, error: "over_max", message: `${p.name} 每張訂單最多 ${p.max_per_order} 個` };

    subtotal += p.price * qty;
    const addons = [];
    for (const rawAd of raw.addons || []) {
      const a = addonMap[int(rawAd.id)];
      if (!a) return { ok: false, error: "addon_gone", message: "有加購品已經停售了" };
      if (!jsonParse(p.addon_ids, []).includes(a.id))
        return { ok: false, error: "addon_not_allowed", message: `${p.name} 不能加購${a.name}` };
      const aq = int(rawAd.qty, 0);
      if (aq < 1) continue;
      if (a.stock < aq)
        return { ok: false, error: "addon_no_stock", message: a.stock > 0 ? `${a.name}只剩 ${a.stock} 個` : `${a.name}已售完` };
      subtotal += a.price * aq;
      addons.push({ id: a.id, name: a.name, price: a.price, qty: aq });
    }
    lines.push({ product: p, qty, addons });
  }

  return { ok: true, lines, subtotal, products: lines.map((l) => l.product) };
}

// ═══════════ 那一天，全車的東西都夠嗎 ═══════════
async function stockOn(env, prodIds, from, to) {
  const ph = prodIds.map(() => "?").join(",");
  const r = await env.DB.prepare(
    `SELECT product_id, ship_date, qty_total - qty_sold AS remain
       FROM product_stock
      WHERE product_id IN (${ph}) AND ship_date >= ? AND ship_date <= ?`
  ).bind(...prodIds, from, to).all();
  const m = {};
  for (const row of r.results || []) {
    if (!m[row.ship_date]) m[row.ship_date] = {};
    m[row.ship_date][row.product_id] = row.remain;
  }
  return m;
}

// ═══════════ 公開 API ═══════════

// 首頁：網站設定 + 商品清單
export async function apiHome(env) {
  const s = await getSettings(env);
  const products = await liveProducts(env);
  return json({
    ok: true,
    open: str(s.biz_open) !== "0",
    site: {
      title: s.site_title || "",
      subtitle: s.site_subtitle || "",
      section_title: s.home_section_title || "",
      footer: s.footer_text || "",
      hero_photos: jsonParse(s.hero_photos, []),
      closed_notice: s.closed_notice || "",
    },
    products: products.map((p) => ({
      id: p.id, name: p.name, subtitle: p.subtitle, thumb: p.thumb, price: p.price,
      ship_methods: jsonParse(p.ship_methods, []),
    })),
  });
}

// 產品頁：一個商品 + 它可以加購什麼
export async function apiProduct(url, env) {
  const id = int(url.searchParams.get("id"));
  const p = await env.DB.prepare("SELECT * FROM products WHERE id = ? AND status = 'on'").bind(id).first();
  if (!p) return json({ ok: false, error: "not_found", message: "找不到這個商品" }, 404);

  const ids = jsonParse(p.addon_ids, []);
  let addons = [];
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT id, name, description, price, photo, stock FROM addons
        WHERE id IN (${ph}) AND status = 'on' ORDER BY sort_order ASC, id ASC`
    ).bind(...ids).all();
    addons = r.results || [];
  }

  const shipCfg = await shippingMap(env);
  return json({
    ok: true,
    product: publicProduct(p),
    addons,
    shipping: Object.values(shipCfg).map((c) => ({ method: c.method, label: c.label, fee: c.fee, free_threshold: c.free_threshold })),
  });
}

// 購物車：這些東西可以選哪幾天出貨
export async function apiDates(request, env) {
  const body = await request.json().catch(() => ({}));
  const cart = await resolveCart(env, body.items);
  if (!cart.ok) return json(cart, 400);

  const settings = await getSettings(env);
  const leadDays = int(settings.lead_days, 3);
  const from = addDays(todayTW(), leadDays);
  const to = addDays(todayTW(), leadDays + 90);

  const prodIds = cart.lines.map((l) => l.product.id);
  const stock = await stockOn(env, prodIds, from, to);

  const days = [];
  for (const date of Object.keys(stock).sort()) {
    const row = stock[date];
    let ok = true, left = Infinity, why = "";
    for (const l of cart.lines) {
      const remain = int(row[l.product.id], 0);
      if (remain < l.qty) {
        ok = false;
        why = remain > 0 ? `${l.product.name} 這天只剩 ${remain} 個` : `${l.product.name} 這天不出貨`;
        break;
      }
      left = Math.min(left, remain - l.qty);
    }
    if (ok) days.push({ date, left });
  }

  return json({ ok: true, lead_days: leadDays, from, to, days });
}

// 購物車：試算（配送方式、運費、總額、衝突）
export async function apiQuote(request, env) {
  const body = await request.json().catch(() => ({}));
  const cart = await resolveCart(env, body.items);
  if (!cart.ok) return json(cart, 400);

  const shipCfg = await shippingMap(env);
  const ship = resolveShipMethod(cart.products, shipCfg);
  if (!ship.ok) {
    // 試算出「不能一起寄」是正常結果之一，不是錯誤 ——
    // 回 200，瀏覽器 console 才不會留一條紅字讓人以為壞了。
    // （真正要拒絕的是下單那支 API，那裡才回 409）
    return json({
      ok: false, error: "ship_conflict", conflict: true, detail: ship.detail,
      subtotal: cart.subtotal,
      message: "這些商品沒辦法一起寄，請分成兩張訂單",
    });
  }

  const cfg = shipCfg[ship.method];
  const m = calcAmount(cart.subtotal, cfg);
  return json({
    ok: true,
    ship_method: ship.method,
    ship_label: cfg.label,
    ship_options: ship.options,
    ...m,
    gap: m.freeShipped ? 0 : Math.max(0, m.threshold - m.subtotal),
  });
}

// ═══════════ 下單 ═══════════

// ★ 擋超賣：全部扣得到才算數，有一項失敗就把前面扣的全部退回去
//   （D1 的 batch() 不是交易、沒有 rollback，所以要自己補償）
async function takeStock(env, lines, shipDate) {
  const takenProducts = [];
  const takenAddons = [];

  const rollback = async () => {
    for (const t of takenProducts) {
      await env.DB.prepare(
        "UPDATE product_stock SET qty_sold = MAX(0, qty_sold - ?1) WHERE product_id = ?2 AND ship_date = ?3"
      ).bind(t.qty, t.id, shipDate).run();
    }
    for (const t of takenAddons) {
      await env.DB.prepare("UPDATE addons SET stock = stock + ?1 WHERE id = ?2").bind(t.qty, t.id).run();
    }
  };

  for (const l of lines) {
    const upd = await env.DB.prepare(
      `UPDATE product_stock SET qty_sold = qty_sold + ?1
        WHERE product_id = ?2 AND ship_date = ?3 AND qty_sold + ?1 <= qty_total`
    ).bind(l.qty, l.product.id, shipDate).run();

    if (!upd.meta.changes) {
      await rollback();
      const row = await env.DB.prepare(
        "SELECT qty_total - qty_sold AS remain FROM product_stock WHERE product_id = ? AND ship_date = ?"
      ).bind(l.product.id, shipDate).first();
      const remain = row ? int(row.remain, 0) : 0;
      return {
        ok: false,
        message: remain > 0
          ? `${l.product.name} 在 ${shipDate} 只剩 ${remain} 個了`
          : `${l.product.name} 在 ${shipDate} 已經額滿了`,
      };
    }
    takenProducts.push({ id: l.product.id, qty: l.qty });

    for (const a of l.addons) {
      const au = await env.DB.prepare(
        "UPDATE addons SET stock = stock - ?1 WHERE id = ?2 AND stock >= ?1"
      ).bind(a.qty, a.id).run();
      if (!au.meta.changes) {
        await rollback();
        return { ok: false, message: `${a.name} 已售完` };
      }
      takenAddons.push({ id: a.id, qty: a.qty });
    }
  }
  return { ok: true, rollback };
}

// 訂單編號 YYYYMMDD-NNN（order_no 有 UNIQUE，撞號就重試）
async function makeOrderNo(env) {
  const day = todayTW().replace(/-/g, "");
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE order_no LIKE ?"
  ).bind(day + "-%").first();
  return { day, seq: int(row && row.n, 0) + 1 };
}

export async function apiOrder(request, env, ctx) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);

  const s = await getSettings(env);
  if (str(s.biz_open) === "0")
    return json({ ok: false, error: "closed", message: s.closed_notice || "目前暫停接單" }, 409);

  // --- 欄位 ---
  const f = (k) => str(body[k]);
  const need = ["buyer_name", "buyer_phone", "buyer_email", "buyer_county", "buyer_district", "buyer_address",
                "rcpt_name", "rcpt_phone", "rcpt_county", "rcpt_district", "rcpt_address", "last5"];
  for (const k of need) if (!f(k)) return json({ ok: false, error: "missing_fields", field: k }, 400);

  const shipDate = f("ship_date");
  if (!isDate(shipDate)) return json({ ok: false, error: "bad_date", message: "請選擇出貨日期" }, 400);
  const leadDays = int(s.lead_days, 3);
  if (shipDate < addDays(todayTW(), leadDays))
    return json({ ok: false, error: "too_soon", message: `出貨日最快要 ${leadDays} 天後` }, 400);

  // --- 購物車 ---
  const cart = await resolveCart(env, body.items);
  if (!cart.ok) return json(cart, 400);

  const shipCfg = await shippingMap(env);
  const ship = resolveShipMethod(cart.products, shipCfg);
  if (!ship.ok)
    return json({ ok: false, error: "ship_conflict", detail: ship.detail, message: "這些商品沒辦法一起寄" }, 409);

  const money = calcAmount(cart.subtotal, shipCfg[ship.method]);

  // --- 扣庫存（全成功才往下走）---
  const took = await takeStock(env, cart.lines, shipDate);
  if (!took.ok) return json({ ok: false, error: "no_stock", message: took.message }, 409);

  // --- 寫訂單（撞到編號就重試）---
  let orderId = null, orderNo = "";
  try {
    const { day, seq } = await makeOrderNo(env);
    for (let i = 0; i < 8; i++) {
      orderNo = `${day}-${String(seq + i).padStart(3, "0")}`;
      try {
        const ins = await env.DB.prepare(
          `INSERT INTO orders (order_no, ship_date, ship_method,
             buyer_name, buyer_phone, buyer_email, buyer_county, buyer_district, buyer_zip, buyer_address,
             rcpt_name, rcpt_phone, rcpt_email, rcpt_county, rcpt_district, rcpt_zip, rcpt_address,
             subtotal, ship_fee, amount, last5, note, pay_status, order_status, created_at, updated_at)
           VALUES (?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?, '未付款','待處理', ?,?)`
        ).bind(
          orderNo, shipDate, ship.method,
          f("buyer_name"), f("buyer_phone"), f("buyer_email"), f("buyer_county"), f("buyer_district"), f("buyer_zip"), f("buyer_address"),
          f("rcpt_name"), f("rcpt_phone"), f("rcpt_email"), f("rcpt_county"), f("rcpt_district"), f("rcpt_zip"), f("rcpt_address"),
          money.subtotal, money.shipFee, money.amount, f("last5"), f("note"),
          nowTW(), nowTW()
        ).run();
        orderId = ins.meta.last_row_id;
        break;
      } catch (e) {
        if (!String(e.message || e).includes("UNIQUE")) throw e;   // 不是撞號就往外丟
      }
    }
    if (!orderId) throw new Error("order_no 一直撞號");

    // --- 明細（名稱與單價都存當時的快照）---
    for (const l of cart.lines) {
      const it = await env.DB.prepare(
        `INSERT INTO order_items (order_id, kind, ref_id, name, unit_price, qty, parent_item_id)
         VALUES (?, 'product', ?, ?, ?, ?, 0)`
      ).bind(orderId, l.product.id, l.product.name, l.product.price, l.qty).run();
      const parentId = it.meta.last_row_id;
      for (const a of l.addons) {
        await env.DB.prepare(
          `INSERT INTO order_items (order_id, kind, ref_id, name, unit_price, qty, parent_item_id)
           VALUES (?, 'addon', ?, ?, ?, ?, ?)`
        ).bind(orderId, a.id, a.name, a.price, a.qty, parentId).run();
      }
    }

    // --- 第一版快照（客人下單時的原始內容）---
    //     存完整內容，之後才回得到「最初那一版」
    await pushRevision(env, orderId, "客人下單時的原始內容", "客人");

  } catch (e) {
    console.error("下單失敗：", (e && e.stack) || e);
    await took.rollback();        // 寫單失敗 → 庫存要還回去，不然會憑空少掉
    // 訂單如果已經插進去了也要清掉，不然會留下一筆沒有明細的孤兒訂單
    if (orderId) {
      await env.DB.prepare("DELETE FROM order_items WHERE order_id = ?").bind(orderId).run().catch(() => {});
      await env.DB.prepare("DELETE FROM orders WHERE id = ?").bind(orderId).run().catch(() => {});
    }
    return json({ ok: false, error: "server_error", message: "訂單沒有成立，請再試一次" }, 500);
  }

  // --- 通知信（沒設金鑰就跳過，失敗也不影響訂單）---
  if (env.RESEND_API_KEY) {
    const mail = sendOrderMail(env, s, {
      order_no: orderNo, ship_date: shipDate, ship_label: shipCfg[ship.method].label,
      to: f("buyer_email"), name: f("buyer_name"),
      lines: cart.lines, ...money,
    });
    if (ctx && ctx.waitUntil) ctx.waitUntil(mail.catch(() => {}));
    else await mail.catch(() => {});
  }

  return json({
    ok: true,
    order_no: orderNo,
    ship_date: shipDate,
    ship_label: shipCfg[ship.method].label,
    ...money,
    bank_name: s.bank_name || "",
    bank_account: s.bank_account || "",
    items: cart.lines.map((l) => ({
      name: l.product.name, qty: l.qty,
      addons: l.addons.map((a) => ({ name: a.name, qty: a.qty })),
    })),
  });
}

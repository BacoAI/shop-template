// 後台 API —— 登入、商品、可出貨日曆、加購品、網站設定、運費、帳號、照片
// （訂單相關的在 orders.js）

import {
  json, str, int, jsonParse, nowTW, todayTW, isDate,
  getSettings, putSetting, randomHex, hashPassword, safeEqual,
} from "./lib.js";

const SESSION_DAYS = 7;
const COOKIE = "shop_admin";

// ═══════════ 登入與權限 ═══════════

function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}

// 回傳目前登入的人；沒登入回 null
export async function currentAdmin(request, env) {
  const token = readCookie(request, COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT a.id, a.username, a.role, a.must_change_pw, s.expires_at
       FROM sessions s JOIN admins a ON a.id = s.admin_id
      WHERE s.token = ?`
  ).bind(token).first();
  if (!row) return null;
  if (row.expires_at && row.expires_at < nowTW()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    return null;
  }
  return row;
}

async function login(request, env) {
  const b = await request.json().catch(() => ({}));
  const username = str(b.username), password = str(b.password);
  if (!username || !password) return json({ ok: false, error: "missing_fields" }, 400);

  const a = await env.DB.prepare("SELECT * FROM admins WHERE username = ?").bind(username).first();
  if (!a) return json({ ok: false, error: "bad_login", message: "帳號或密碼不對" }, 401);

  let pass = false;
  if (!a.pw_hash) {
    // 還沒設過密碼（剛裝好的 admin）→ 只認得出廠密碼
    pass = password === "admin";
  } else {
    pass = safeEqual(await hashPassword(password, a.pw_salt), a.pw_hash);
  }
  if (!pass) return json({ ok: false, error: "bad_login", message: "帳號或密碼不對" }, 401);

  const token = randomHex(24);
  const expires = (() => {
    const d = new Date(Date.now() + 8 * 3600 * 1000 + SESSION_DAYS * 86400 * 1000);
    return d.toISOString().replace("T", " ").slice(0, 16);
  })();
  await env.DB.prepare(
    "INSERT INTO sessions (token, admin_id, created_at, expires_at) VALUES (?,?,?,?)"
  ).bind(token, a.id, nowTW(), expires).run();
  await env.DB.prepare("UPDATE admins SET last_login = ? WHERE id = ?").bind(nowTW(), a.id).run();
  // 順手清掉過期的 session
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowTW()).run();

  return json(
    { ok: true, username: a.username, role: a.role, must_change_pw: !!a.must_change_pw },
    200,
    { "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` }
  );
}

async function logout(request, env) {
  const token = readCookie(request, COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
}

async function changePassword(request, env, me) {
  const b = await request.json().catch(() => ({}));
  const oldPw = str(b.old_password), newPw = str(b.new_password);
  if (newPw.length < 6) return json({ ok: false, error: "too_short", message: "新密碼至少 6 個字" }, 400);

  const a = await env.DB.prepare("SELECT * FROM admins WHERE id = ?").bind(me.id).first();
  const okOld = a.pw_hash ? safeEqual(await hashPassword(oldPw, a.pw_salt), a.pw_hash) : oldPw === "admin";
  if (!okOld) return json({ ok: false, error: "bad_password", message: "舊密碼不對" }, 401);

  const salt = randomHex(16);
  await env.DB.prepare(
    "UPDATE admins SET pw_hash = ?, pw_salt = ?, must_change_pw = 0 WHERE id = ?"
  ).bind(await hashPassword(newPw, salt), salt, me.id).run();
  return json({ ok: true });
}

// 第一次登入：把出廠的 admin 換成店主自己的帳號
//
// ★ 這裡是「改名」不是「新增再刪除」：同一列資料直接換掉 username 與密碼。
//   好處是沒有中間狀態 —— 不會出現「新帳號建好了、舊的 admin 還在」的空窗。
//   做完之後 admin 這個帳號就不存在了，出廠密碼自然失效。
//
//   不需要再問一次舊密碼：他是用出廠密碼登入進來的，session 已經證明過身分。
async function setupAccount(request, env, me) {
  const b = await request.json().catch(() => ({}));
  const username = str(b.username), password = str(b.password);

  if (!username) return json({ ok: false, error: "no_username", message: "請填一個帳號" }, 400);
  if (username.length > 40) return json({ ok: false, error: "too_long", message: "帳號太長了" }, 400);
  if (password.length < 6) return json({ ok: false, error: "too_short", message: "密碼至少 6 個字" }, 400);

  const dup = await env.DB.prepare(
    "SELECT id FROM admins WHERE username = ? AND id != ?"
  ).bind(username, me.id).first();
  if (dup) return json({ ok: false, error: "duplicate", message: "這個帳號已經有人用了，換一個" }, 409);

  const salt = randomHex(16);
  await env.DB.prepare(
    "UPDATE admins SET username = ?, pw_hash = ?, pw_salt = ?, must_change_pw = 0 WHERE id = ?"
  ).bind(username, await hashPassword(password, salt), salt, me.id).run();

  return json({ ok: true, username });
}

// ═══════════ 商品 ═══════════

const PRODUCT_FIELDS = {
  name: "text", subtitle: "text", thumb: "text", photos: "json", intro: "text",
  description: "text", price: "int", ship_methods: "json", ship_primary: "text",
  addon_ids: "json", max_per_order: "int", sort_order: "int", status: "text",
};

async function saveProduct(request, env) {
  const b = await request.json().catch(() => ({}));
  const id = int(b.id, 0);

  const cols = [], vals = [];
  for (const k in PRODUCT_FIELDS) {
    if (b[k] === undefined) continue;
    const t = PRODUCT_FIELDS[k];
    cols.push(k);
    vals.push(t === "int" ? int(b[k]) : t === "json" ? JSON.stringify(b[k]) : str(b[k]));
  }
  if (!cols.length) return json({ ok: false, error: "nothing_to_update" }, 400);

  // 配送方式至少要留一種，而且「優先」一定要在可用清單裡
  if (b.ship_methods !== undefined) {
    const ms = Array.isArray(b.ship_methods) ? b.ship_methods : [];
    if (!ms.length) return json({ ok: false, error: "no_ship", message: "至少要留一種配送方式" }, 400);
    const prim = str(b.ship_primary) || ms[0];
    if (!ms.includes(prim))
      return json({ ok: false, error: "bad_primary", message: "「優先」必須是有勾選的配送方式" }, 400);
  }

  if (id) {
    cols.push("updated_at"); vals.push(nowTW());
    await env.DB.prepare(
      `UPDATE products SET ${cols.map((c) => c + " = ?").join(", ")} WHERE id = ?`
    ).bind(...vals, id).run();
    const p = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first();
    return json({ ok: true, product: p });
  }

  cols.push("created_at", "updated_at"); vals.push(nowTW(), nowTW());
  const ins = await env.DB.prepare(
    `INSERT INTO products (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`
  ).bind(...vals).run();
  const p = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(ins.meta.last_row_id).first();
  return json({ ok: true, product: p });
}

// ═══════════ 可出貨日期 & 數量（日曆）═══════════

async function saveStock(request, env) {
  const b = await request.json().catch(() => ({}));
  const pid = int(b.product_id);
  const days = Array.isArray(b.days) ? b.days : [];
  if (!pid || !days.length) return json({ ok: false, error: "bad_params" }, 400);

  const done = [], refused = [];
  for (const d of days) {
    const date = str(d.date), qty = int(d.qty, 0);
    if (!isDate(date)) { refused.push({ date, why: "日期格式不對" }); continue; }

    const cur = await env.DB.prepare(
      "SELECT qty_sold FROM product_stock WHERE product_id = ? AND ship_date = ?"
    ).bind(pid, date).first();
    const sold = cur ? int(cur.qty_sold, 0) : 0;

    // 已經賣掉的不能被砍掉 —— 不然那些訂單就沒貨可出了
    if (qty < sold) { refused.push({ date, why: `這天已經賣出 ${sold} 個，不能設得比它少` }); continue; }

    if (qty === 0 && sold === 0) {
      await env.DB.prepare("DELETE FROM product_stock WHERE product_id = ? AND ship_date = ?").bind(pid, date).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO product_stock (product_id, ship_date, qty_total, qty_sold) VALUES (?,?,?,0)
         ON CONFLICT(product_id, ship_date) DO UPDATE SET qty_total = excluded.qty_total`
      ).bind(pid, date, qty).run();
    }
    done.push(date);
  }
  return json({ ok: refused.length === 0, saved: done, refused });
}

async function listStock(url, env) {
  const pid = int(url.searchParams.get("product_id"));
  const from = str(url.searchParams.get("from")) || todayTW();
  const to = str(url.searchParams.get("to")) || "9999-12-31";
  if (!pid) return json({ ok: false, error: "bad_params" }, 400);
  const r = await env.DB.prepare(
    `SELECT ship_date, qty_total, qty_sold, qty_total - qty_sold AS remain
       FROM product_stock WHERE product_id = ? AND ship_date >= ? AND ship_date <= ?
      ORDER BY ship_date ASC`
  ).bind(pid, from, to).all();
  return json({ ok: true, days: r.results || [] });
}

// ═══════════ 加購品 ═══════════

async function saveAddon(request, env) {
  const b = await request.json().catch(() => ({}));
  const id = int(b.id, 0);
  const fields = { name: "text", description: "text", price: "int", photo: "text", stock: "int", sort_order: "int", status: "text" };
  const cols = [], vals = [];
  for (const k in fields) {
    if (b[k] === undefined) continue;
    cols.push(k); vals.push(fields[k] === "int" ? int(b[k]) : str(b[k]));
  }
  if (!cols.length) return json({ ok: false, error: "nothing_to_update" }, 400);

  if (id) {
    await env.DB.prepare(`UPDATE addons SET ${cols.map((c) => c + " = ?").join(", ")} WHERE id = ?`)
      .bind(...vals, id).run();
  } else {
    cols.push("created_at"); vals.push(nowTW());
    await env.DB.prepare(`INSERT INTO addons (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .bind(...vals).run();
  }
  const r = await env.DB.prepare("SELECT * FROM addons ORDER BY sort_order ASC, id ASC").all();
  return json({ ok: true, addons: r.results || [] });
}

// ═══════════ 運費 ═══════════

async function saveShipping(request, env) {
  const b = await request.json().catch(() => ({}));
  const rows = Array.isArray(b.shipping) ? b.shipping : [];
  if (!rows.length) return json({ ok: false, error: "bad_params" }, 400);
  for (const s of rows) {
    await env.DB.prepare(
      "UPDATE shipping SET fee = ?, free_threshold = ?, enabled = ? WHERE method = ?"
    ).bind(int(s.fee), int(s.free_threshold), s.enabled ? 1 : 0, str(s.method)).run();
  }
  const r = await env.DB.prepare("SELECT * FROM shipping ORDER BY rank ASC").all();
  return json({ ok: true, shipping: r.results || [] });
}

// ═══════════ 後台帳號（只有「完整」權限能碰）═══════════

async function createAdmin(request, env) {
  const b = await request.json().catch(() => ({}));
  const username = str(b.username), password = str(b.password), role = str(b.role) === "full" ? "full" : "normal";
  if (!username || password.length < 6)
    return json({ ok: false, error: "bad_params", message: "帳號必填，密碼至少 6 個字" }, 400);
  const dup = await env.DB.prepare("SELECT id FROM admins WHERE username = ?").bind(username).first();
  if (dup) return json({ ok: false, error: "duplicate", message: "這個帳號已經有人用了" }, 409);

  const salt = randomHex(16);
  await env.DB.prepare(
    "INSERT INTO admins (username, pw_hash, pw_salt, role, must_change_pw, created_at) VALUES (?,?,?,?,0,?)"
  ).bind(username, await hashPassword(password, salt), salt, role, nowTW()).run();
  return json({ ok: true });
}

async function deleteAdmin(request, env, me) {
  const b = await request.json().catch(() => ({}));
  const id = int(b.id);
  if (!id) return json({ ok: false, error: "bad_params" }, 400);
  if (id === me.id) return json({ ok: false, error: "self", message: "不能刪掉自己" }, 400);

  // 一定要留一個完整權限的帳號，不然沒人能進系統管理了
  const target = await env.DB.prepare("SELECT role FROM admins WHERE id = ?").bind(id).first();
  if (!target) return json({ ok: false, error: "not_found" }, 404);
  if (target.role === "full") {
    const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM admins WHERE role = 'full'").first();
    if (int(c.n) <= 1)
      return json({ ok: false, error: "last_full", message: "至少要留一個完整權限的帳號" }, 409);
  }
  await env.DB.prepare("DELETE FROM sessions WHERE admin_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM admins WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function updateAdminRole(request, env, me) {
  const b = await request.json().catch(() => ({}));
  const id = int(b.id), role = str(b.role) === "full" ? "full" : "normal";
  if (!id) return json({ ok: false, error: "bad_params" }, 400);
  if (id === me.id && role !== "full")
    return json({ ok: false, error: "self", message: "不能把自己降權，會鎖住自己" }, 400);
  if (role === "normal") {
    const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM admins WHERE role = 'full'").first();
    const t = await env.DB.prepare("SELECT role FROM admins WHERE id = ?").bind(id).first();
    if (t && t.role === "full" && int(c.n) <= 1)
      return json({ ok: false, error: "last_full", message: "至少要留一個完整權限的帳號" }, 409);
  }
  await env.DB.prepare("UPDATE admins SET role = ? WHERE id = ?").bind(role, id).run();
  return json({ ok: true });
}

// ═══════════ 照片（存 Cloudflare KV，沿用 v1 的做法）═══════════

async function photoUpload(request, env) {
  if (!env.IMG) return json({ ok: false, error: "no_kv", message: "還沒設定照片倉庫，見 wrangler.toml 的 kv_namespaces" }, 500);
  const b = await request.json().catch(() => ({}));
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(str(b.data));
  if (!m) return json({ ok: false, error: "bad_image", message: "只收 jpg / png / webp" }, 400);
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  if (bytes.byteLength > 2 * 1024 * 1024)
    return json({ ok: false, error: "too_big", message: "這張圖超過 2MB，請再壓小一點" }, 400);
  const ext = m[1] === "image/png" ? "png" : m[1] === "image/webp" ? "webp" : "jpg";
  const key = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await env.IMG.put(key, bytes, { metadata: { ct: m[1] } });
  return json({ ok: true, key });
}

async function photoDelete(request, env) {
  const b = await request.json().catch(() => ({}));
  const key = str(b.key);
  if (!key) return json({ ok: false, error: "bad_params" }, 400);
  if (env.IMG) await env.IMG.delete(key);
  return json({ ok: true });
}

// ═══════════ 路由 ═══════════

// me 由 worker.js 查好傳進來（同一次請求只查一次 session）
export async function handleAdmin(path, request, env, me) {
  const url = new URL(request.url);
  const M = request.method;

  // 這兩個本來就不需要先登入
  if (path === "/api/admin/login" && M === "POST") return login(request, env);
  if (path === "/api/admin/logout" && M === "POST") return logout(request, env);

  // 「我是誰」：沒登入也回 200 —— 還沒登入不是錯誤，只是還沒登入。
  // 回 401 會在瀏覽器 console 留一條紅字，讓打開開發者工具的人以為壞了。
  if (path === "/api/admin/me")
    return json(me
      ? { ok: true, username: me.username, role: me.role, must_change_pw: !!me.must_change_pw }
      : { ok: false, logged_in: false });

  if (!me) return json({ ok: false, error: "unauthorized", message: "請先登入" }, 401);

  // 還沒設定自己的帳號之前，除了「設定帳號」以外什麼都不能做
  if (me.must_change_pw && !["/api/admin/setup", "/api/admin/change-password"].includes(path))
    return json({ ok: false, error: "must_change_pw", message: "請先設定你自己的管理員帳號" }, 403);

  if (path === "/api/admin/setup" && M === "POST") return setupAccount(request, env, me);
  if (path === "/api/admin/change-password" && M === "POST") return changePassword(request, env, me);

  // ── 商品 ──
  if (path === "/api/admin/products" && M === "GET") {
    const r = await env.DB.prepare("SELECT * FROM products ORDER BY sort_order ASC, id ASC").all();
    return json({ ok: true, products: r.results || [] });
  }
  if (path === "/api/admin/product" && M === "GET") {
    const p = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(int(url.searchParams.get("id"))).first();
    return p ? json({ ok: true, product: p }) : json({ ok: false, error: "not_found" }, 404);
  }
  if (path === "/api/admin/product" && M === "POST") return saveProduct(request, env);

  // ── 可出貨日期 ──
  if (path === "/api/admin/stock" && M === "GET") return listStock(url, env);
  if (path === "/api/admin/stock" && M === "POST") return saveStock(request, env);

  // ── 加購品 ──
  if (path === "/api/admin/addons" && M === "GET") {
    const r = await env.DB.prepare("SELECT * FROM addons ORDER BY sort_order ASC, id ASC").all();
    return json({ ok: true, addons: r.results || [] });
  }
  if (path === "/api/admin/addon" && M === "POST") return saveAddon(request, env);

  // ── 網站設定 ──
  if (path === "/api/admin/settings" && M === "GET") return json({ ok: true, settings: await getSettings(env) });
  if (path === "/api/admin/settings" && M === "POST") {
    const b = await request.json().catch(() => ({}));
    const pairs = Object.entries(b);
    if (!pairs.length) return json({ ok: false, error: "nothing_to_update" }, 400);
    const stmt = env.DB.prepare("INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
    await env.DB.batch(pairs.map(([k, v]) => stmt.bind(String(k), v == null ? "" : String(v))));
    return json({ ok: true, saved: pairs.length });
  }

  // ── 運費 ──
  if (path === "/api/admin/shipping" && M === "GET") {
    const r = await env.DB.prepare("SELECT * FROM shipping ORDER BY rank ASC").all();
    return json({ ok: true, shipping: r.results || [] });
  }
  if (path === "/api/admin/shipping" && M === "POST") return saveShipping(request, env);

  // ── 照片 ──
  if (path === "/api/admin/photo-upload" && M === "POST") return photoUpload(request, env);
  if (path === "/api/admin/photo-delete" && M === "POST") return photoDelete(request, env);

  // ── 系統管理（只有完整權限）──
  if (path.startsWith("/api/admin/admins") || path.startsWith("/api/admin/admin-")) {
    if (me.role !== "full")
      return json({ ok: false, error: "forbidden", message: "系統管理只有完整權限的帳號能用" }, 403);
    if (path === "/api/admin/admins" && M === "GET") {
      const r = await env.DB.prepare("SELECT id, username, role, created_at, last_login FROM admins ORDER BY id ASC").all();
      return json({ ok: true, admins: r.results || [] });
    }
    if (path === "/api/admin/admin-create" && M === "POST") return createAdmin(request, env);
    if (path === "/api/admin/admin-role" && M === "POST") return updateAdminRole(request, env, me);
    if (path === "/api/admin/admin-delete" && M === "POST") return deleteAdmin(request, env, me);
  }

  return null;   // 這個檔不認得 → 交給 orders.js
}

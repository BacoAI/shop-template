// 共用小工具 —— 其他檔案都從這裡拿
// 這個檔不碰資料表結構，只做「每個地方都會用到」的事。

// ---------- 回應 ----------

export function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

// ---------- 型別整理 ----------

export function str(v) { return (v === undefined || v === null) ? "" : String(v).trim(); }

export function int(v, dflt = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

export function jsonParse(v, dflt) {
  try { const x = JSON.parse(v); return x === null || x === undefined ? dflt : x; }
  catch (e) { return dflt; }
}

// ---------- HTML 轉義（文案填進頁面時用）----------

export function esc(v) {
  return String(v === undefined || v === null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function nl2br(v) { return esc(v).replace(/\r?\n/g, "<br>"); }

// ---------- 時間（一律台北時間）----------

// 'YYYY-MM-DD HH:mm'
export function nowTW() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 16);
}

// 'YYYY-MM-DD'
export function todayTW() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' 往後推 n 天
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export function isDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(str(v)); }

// ---------- 設定表讀寫 ----------

export async function getSettings(env) {
  const r = await env.DB.prepare("SELECT k, v FROM settings").all();
  const out = {};
  for (const row of r.results || []) out[row.k] = row.v;
  return out;
}

export async function getSetting(env, k, dflt = "") {
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k = ?").bind(k).first();
  return row ? row.v : dflt;
}

export async function putSetting(env, k, v) {
  await env.DB.prepare(
    "INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
  ).bind(String(k), v == null ? "" : String(v)).run();
}

// ---------- 密碼（PBKDF2，絕不存明碼）----------

export function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
  return a;
}

export async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: 100000, hash: "SHA-256" },
    key, 256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 比對時間固定，避免用回應時間猜密碼
export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- 文案小語法（沿用 v1）----------
//   *星號之間的字* → 粗體
//   {匯款期限}     → 換成 pay_deadline
export function rich(text, settings) {
  return nl2br(text)
    .replace(/\{匯款期限\}/g, esc((settings && settings.pay_deadline) || ""))
    .replace(/\*([^*<>\n]+)\*/g, "<b>$1</b>");
}

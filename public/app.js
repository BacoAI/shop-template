// 前台共用 —— 購物車、呼叫後端、小提示
//
// 購物車存在「這台瀏覽器」裡（localStorage），不存伺服器 —— 因為我們不做會員。
// 換一台裝置或清掉瀏覽器資料，購物車就會空掉，這是預期行為。

const CART_KEY = "shop_cart_v2";

// ── 購物車 ────────────────────────────────────────

function cartRead() {
  try {
    const a = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}

function cartWrite(items) {
  localStorage.setItem(CART_KEY, JSON.stringify(items));
  updateFab();
}

function cartClear() { localStorage.removeItem(CART_KEY); updateFab(); }

function cartCount() { return cartRead().reduce((n, c) => n + (c.qty || 0), 0); }

// 同一個商品再加入時，數量與加購品合併起來
function cartAdd(pid, qty, addons) {
  const items = cartRead();
  const hit = items.find((c) => c.id === pid);
  if (hit) {
    hit.qty += qty;
    for (const a of addons) {
      const e = (hit.addons = hit.addons || []).find((x) => x.id === a.id);
      if (e) e.qty += a.qty; else hit.addons.push({ ...a });
    }
  } else {
    items.push({ id: pid, qty, addons: addons.map((a) => ({ ...a })) });
  }
  cartWrite(items);
}

// ── 呼叫後端 ──────────────────────────────────────

async function api(path, body) {
  const opt = body === undefined
    ? {}
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, opt);
  let data = {};
  try { data = await res.json(); } catch (e) { data = { ok: false, error: "bad_response" }; }
  data._status = res.status;
  return data;
}

// ── 小提示 ────────────────────────────────────────

let _toastTimer;
function toast(msg) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("on");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("on"), 2400);
}

// ── 浮動購物車的數字 ──────────────────────────────

function updateFab() {
  const b = document.getElementById("fabN");
  if (b) b.textContent = cartCount();
}

// ── 小工具 ────────────────────────────────────────

function money(n) { return "$" + Number(n || 0).toLocaleString(); }

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const w = ["日", "一", "二", "三", "四", "五", "六"][new Date(y, m - 1, d).getDay()];
  return `${y} / ${m} / ${d}（${w}）`;
}

function imgSrc(key) {
  return key ? "/img/" + encodeURIComponent(key) : "dorayaki.jpg";
}

document.addEventListener("DOMContentLoaded", updateFab);

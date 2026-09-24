// 後台 —— 所有操作邏輯
//
// 登入狀態靠 cookie，這支檔案不碰密碼本身。
// 每一區進去才載入資料（不是一開始全抓），這樣開啟比較快。

// ═══════ 共用 ═══════

async function api(path, body, method) {
  const opt = { method: method || (body === undefined ? "GET" : "POST"), credentials: "same-origin" };
  if (body !== undefined) {
    opt.headers = { "Content-Type": "application/json" };
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(path, opt);
  let data = {};
  try { data = await res.json(); } catch (e) { data = { ok: false, error: "bad_response" }; }
  data._status = res.status;
  // 登入過期 → 回到登入畫面
  if (res.status === 401) { showLogin(); throw new Error("unauthorized"); }
  return data;
}

let _tt;
function toast(msg) {
  const e = document.getElementById("toast");
  e.textContent = msg;
  e.classList.add("on");
  clearTimeout(_tt);
  _tt = setTimeout(() => e.classList.remove("on"), 2400);
}

function closeMask(id) { document.getElementById(id).classList.remove("on"); }
function openMask(id) { document.getElementById(id).classList.add("on"); }
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function money(n) { return "$" + Number(n || 0).toLocaleString(); }

function busy(btnId, on, textWhenBusy) {
  const b = document.getElementById(btnId);
  if (!b) return;
  if (on) { b.dataset.old = b.textContent; b.textContent = textWhenBusy || "處理中…"; b.classList.add("busy"); }
  else { b.textContent = b.dataset.old || b.textContent; b.classList.remove("busy"); }
}

// ═══════ 登入 ═══════

let ME = null;

function showLogin() {
  document.getElementById("loginPage").style.display = "flex";
  document.getElementById("pwPage").style.display = "none";
  document.getElementById("app").style.display = "none";
}

async function boot() {
  const r = await fetch("/api/admin/me", { credentials: "same-origin" }).then((x) => x.json()).catch(() => ({ ok: false }));
  if (!r.ok) return showLogin();
  ME = r;
  if (r.must_change_pw) {
    document.getElementById("loginPage").style.display = "none";
    document.getElementById("pwPage").style.display = "flex";
    document.getElementById("app").style.display = "none";
    return;
  }
  enterApp();
}

function enterApp() {
  document.getElementById("loginPage").style.display = "none";
  document.getElementById("pwPage").style.display = "none";
  const app = document.getElementById("app");
  app.style.display = "flex";
  document.getElementById("meName").textContent = ME.username;
  document.getElementById("meRole").textContent = ME.role === "full" ? "完整權限" : "一般權限";
  // 一般權限看不到系統管理
  if (ME.role !== "full") document.getElementById("navSys").style.display = "none";
  loadProducts();
  loadSiteTitle();
}

async function doLogin() {
  const u = document.getElementById("lgUser").value.trim();
  const p = document.getElementById("lgPass").value;
  const err = document.getElementById("lgErr");
  err.textContent = "";
  if (!u || !p) { err.textContent = "請填帳號與密碼"; return; }
  busy("lgBtn", true, "登 入 中 …");
  const res = await fetch("/api/admin/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    credentials: "same-origin", body: JSON.stringify({ username: u, password: p }),
  });
  const r = await res.json().catch(() => ({ ok: false }));
  busy("lgBtn", false);
  if (!r.ok) { err.textContent = r.message || "帳號或密碼不對"; return; }
  ME = r;
  document.getElementById("lgPass").value = "";
  if (r.must_change_pw) {
    document.getElementById("loginPage").style.display = "none";
    document.getElementById("pwPage").style.display = "flex";
    return;
  }
  enterApp();
}

// 第一次登入：設定自己的帳號名與密碼（出廠的 admin 會直接被換掉）
async function doSetup() {
  const u = document.getElementById("suUser").value.trim();
  const p1 = document.getElementById("suPass").value;
  const p2 = document.getElementById("suPass2").value;
  const err = document.getElementById("suErr");
  err.textContent = "";

  if (!u) { err.textContent = "請填一個帳號"; return; }
  if (u.toLowerCase() === "admin") { err.textContent = "不能還是叫 admin，換一個只有你知道的"; return; }
  if (p1.length < 6) { err.textContent = "密碼至少 6 個字"; return; }
  if (p1 !== p2) { err.textContent = "兩次輸入的密碼不一樣"; return; }
  if (p1 === "admin" || p1 === "123456") { err.textContent = "這個密碼太好猜了，換一個"; return; }

  busy("suBtn", true, "建 立 中 …");
  const r = await api("/api/admin/setup", { username: u, password: p1 });
  busy("suBtn", false);
  if (!r.ok) { err.textContent = r.message || "建立失敗"; return; }

  ME.username = r.username;
  ME.must_change_pw = false;
  toast(`帳號建好了，以後用「${r.username}」登入`);
  enterApp();
}

async function doLogout() {
  await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" });
  location.reload();
}

// ═══════ 分區切換 ═══════

function nav(p, el) {
  // 還停在商品編輯畫面的話，先收起來再切 ——
  // 這樣點左側「商品設定」會回到商品列表，切去別區再切回來也不會還卡在編輯畫面。
  // 有沒存的日期設定時 backToList() 會先問，使用者選擇留下就什麼都不做。
  if (document.getElementById("prodEdit").style.display === "block") {
    if (!backToList()) return;
  }
  document.querySelectorAll(".pane").forEach((e) => e.classList.remove("on"));
  document.getElementById("p-" + p).classList.add("on");
  document.querySelectorAll(".side a").forEach((a) => a.classList.remove("on"));
  el.classList.add("on");
  window.scrollTo(0, 0);
  if (p === "prod") loadProducts();
  if (p === "order") loadOrders();
  if (p === "site") loadSite();
  if (p === "ship") loadShipping();
  if (p === "sys") loadAdmins();
}

// ═══════ 商品設定 ═══════

let PRODUCTS = [], ADDONS = [], SHIPCFG = [];

async function loadProducts() {
  const [p, a, s] = await Promise.all([
    api("/api/admin/products"),
    api("/api/admin/addons"),
    api("/api/admin/shipping"),
  ]);
  PRODUCTS = p.products || []; ADDONS = a.addons || []; SHIPCFG = s.shipping || [];

  const grid = document.getElementById("pgrid");
  grid.innerHTML = PRODUCTS.map((x) => {
    const ms = jsonOr(x.ship_methods, []);
    return `<div class="pcard" onclick="openProduct(${x.id})">
      <img src="${x.thumb ? "/img/" + encodeURIComponent(x.thumb) : "dorayaki.jpg"}" alt="">
      <div class="pb">
        <div class="nm">${esc(x.name)}</div>
        <div class="sb">${esc(x.subtitle || "")}</div>
        <div class="bt">
          <span class="pr">${money(x.price)}</span>
          <span>${ms.map((m) => `<span class="tag ${m}" style="margin-left:3px">${shipLabel(m)}</span>`).join("")}</span>
        </div>
        <div style="margin-top:8px"><span class="tag ${x.status === "on" ? "on" : "off"}">${x.status === "on" ? "上架中" : "已下架"}</span></div>
      </div>
    </div>`;
  }).join("") + `<div class="pnew" onclick="openProduct(0)"><i>＋</i>新增商品</div>`;

  document.getElementById("addonRows").innerHTML = ADDONS.length ? ADDONS.map((a) => `
    <tr><td>${esc(a.name)}</td><td style="color:var(--soft)">${esc(a.description || "")}</td><td>${money(a.price)}</td>
      <td>${a.stock > 0 ? `<b style="font-family:'Noto Serif TC',serif;font-weight:500">${a.stock}</b>` : '<span class="tag void">已售完</span>'}</td>
      <td><span class="tag ${a.status === "on" ? "on" : "off"}">${a.status === "on" ? "啟用" : "停用"}</span></td>
      <td><button class="b gh sm" onclick="openAddon(${a.id})">編輯</button></td></tr>`).join("")
    : '<tr><td colspan="6" class="blank">還沒有加購商品</td></tr>';
}

function jsonOr(v, d) { try { const x = JSON.parse(v); return x == null ? d : x; } catch (e) { return d; } }
function shipLabel(m) { const c = SHIPCFG.find((x) => x.method === m); return c ? c.label : m; }

let CURP = null;

function openProduct(id) {
  CURP = id ? JSON.parse(JSON.stringify(PRODUCTS.find((p) => p.id === id))) : {
    id: 0, name: "", subtitle: "", thumb: "", photos: "[]", intro: "", description: "",
    price: 0, ship_methods: '["normal"]', ship_primary: "normal", addon_ids: "[]",
    max_per_order: 0, sort_order: (PRODUCTS.length + 1), status: "on",
  };
  document.getElementById("peTitle").textContent = id ? "編輯商品" : "新增商品";
  document.getElementById("peName").value = CURP.name;
  document.getElementById("peSub").value = CURP.subtitle || "";
  document.getElementById("peIntro").value = CURP.intro || "";
  document.getElementById("peDesc").value = CURP.description || "";
  document.getElementById("pePrice").value = CURP.price || "";
  document.getElementById("peMax").value = CURP.max_per_order || "";
  document.getElementById("peSort").value = CURP.sort_order || 0;
  document.getElementById("peOffBtn").textContent = CURP.status === "on" ? "下架" : "重新上架";
  document.getElementById("peOffBtn").style.display = id ? "" : "none";

  renderShipSel(); renderPeAddons(); renderPePhotos();

  // 沒存過的商品還沒有 id，沒辦法設可出貨日期
  document.getElementById("cal").style.display = id ? "" : "none";
  document.querySelector("#peStockCard .calhead").style.display = id ? "" : "none";
  document.getElementById("stockHint").style.display = id ? "none" : "block";
  EDITED = {};
  if (id) { CALM = new Date(); loadStock(); }

  document.getElementById("prodList").style.display = "none";
  document.getElementById("prodEdit").style.display = "block";
  window.scrollTo(0, 0);
}

// 回傳 true = 真的離開了；false = 使用者選擇留下
function backToList() {
  if (Object.keys(EDITED).length && !confirm("可出貨日期還有沒儲存的變更，確定要離開嗎？")) return false;
  document.getElementById("prodEdit").style.display = "none";
  document.getElementById("prodList").style.display = "block";
  EDITED = {};
  window.scrollTo(0, 0);
  return true;
}

function renderShipSel() {
  const ms = jsonOr(CURP.ship_methods, []);
  document.getElementById("peShip").innerHTML = SHIPCFG.filter((c) => c.enabled).map((c) => {
    const on = ms.includes(c.method);
    return `<div class="shipopt ${on ? "on" : ""}" onclick="toggleShip('${c.method}')">
      <div class="t">${c.label}</div>
      <div class="p">運費 <b>${money(c.fee)}</b></div>
      <span class="prim ${CURP.ship_primary === c.method ? "is" : ""}"
            onclick="event.stopPropagation();setPrimary('${c.method}')">${CURP.ship_primary === c.method ? "優先" : "設為優先"}</span>
    </div>`;
  }).join("");
}

function toggleShip(m) {
  const ms = jsonOr(CURP.ship_methods, []);
  const i = ms.indexOf(m);
  if (i >= 0) {
    if (ms.length <= 1) { toast("至少要留一種配送方式"); return; }
    ms.splice(i, 1);
    if (CURP.ship_primary === m) CURP.ship_primary = ms[0];
  } else ms.push(m);
  CURP.ship_methods = JSON.stringify(ms);
  renderShipSel();
}

function setPrimary(m) {
  if (!jsonOr(CURP.ship_methods, []).includes(m)) { toast("要先勾選這種配送方式"); return; }
  CURP.ship_primary = m;
  renderShipSel();
}

function renderPeAddons() {
  const sel = jsonOr(CURP.addon_ids, []);
  const box = document.getElementById("peAddons");
  box.innerHTML = ADDONS.length ? ADDONS.map((a) => `
    <div class="shipopt ${sel.includes(a.id) ? "on" : ""}" style="flex:0 0 auto;min-width:130px" onclick="toggleAddonPick(${a.id})">
      <div class="t">${esc(a.name)}</div><div class="p">+${money(a.price)}</div>
    </div>`).join("") : '<p class="hint">還沒有加購商品。先到商品列表下面新增。</p>';
}

function toggleAddonPick(id) {
  const sel = jsonOr(CURP.addon_ids, []);
  const i = sel.indexOf(id);
  if (i >= 0) sel.splice(i, 1); else sel.push(id);
  CURP.addon_ids = JSON.stringify(sel);
  renderPeAddons();
}

async function saveProduct() {
  const body = {
    id: CURP.id,
    name: document.getElementById("peName").value.trim(),
    subtitle: document.getElementById("peSub").value.trim(),
    thumb: CURP.thumb || "",
    photos: jsonOr(CURP.photos, []),
    intro: document.getElementById("peIntro").value,
    description: document.getElementById("peDesc").value,
    price: parseInt(document.getElementById("pePrice").value, 10) || 0,
    max_per_order: parseInt(document.getElementById("peMax").value, 10) || 0,
    sort_order: parseInt(document.getElementById("peSort").value, 10) || 0,
    ship_methods: jsonOr(CURP.ship_methods, ["normal"]),
    ship_primary: CURP.ship_primary,
    addon_ids: jsonOr(CURP.addon_ids, []),
    status: CURP.status,
  };
  if (!body.name) { toast("請填產品名稱"); return; }
  if (body.price <= 0) { toast("請填產品價格"); return; }

  busy("peSaveBtn", true, "儲 存 中 …");
  const r = await api("/api/admin/product", body);
  busy("peSaveBtn", false);
  if (!r.ok) { toast(r.message || "儲存失敗"); return; }

  const wasNew = !CURP.id;
  CURP = r.product;
  await loadProducts();
  toast(wasNew ? "商品已建立，可以設定可出貨日期了" : "商品已儲存");
  if (wasNew) openProduct(r.product.id);   // 新建完直接進編輯，才能設日期
}

async function toggleProductStatus() {
  if (!CURP.id) return;
  const next = CURP.status === "on" ? "off" : "on";
  if (next === "off" && !confirm("下架之後客人就看不到這個商品了（已成立的訂單不受影響）。確定嗎？")) return;
  const r = await api("/api/admin/product", { id: CURP.id, status: next });
  if (!r.ok) { toast("失敗"); return; }
  CURP.status = next;
  document.getElementById("peOffBtn").textContent = next === "on" ? "下架" : "重新上架";
  await loadProducts();
  toast(next === "on" ? "已重新上架" : "已下架");
}

// ═══════ 可出貨日曆 ═══════

let CALM = new Date(), STOCK = {}, EDITED = {}, DAYKEY = null;

async function loadStock() {
  if (!CURP.id) return;
  const r = await api("/api/admin/stock?product_id=" + CURP.id);
  STOCK = {};
  for (const d of r.days || []) STOCK[d.ship_date] = { total: d.qty_total, sold: d.qty_sold };
  renderCal();
}

function renderCal() {
  const y = CALM.getFullYear(), mo = CALM.getMonth();
  document.getElementById("calMM").textContent = `${y} 年 ${mo + 1} 月`;
  const blanks = new Date(y, mo, 1).getDay(), days = new Date(y, mo + 1, 0).getDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);

  let h = "";
  ["日", "一", "二", "三", "四", "五", "六"].forEach((w) => h += `<div class="wd">${w}</div>`);
  for (let i = 0; i < blanks; i++) h += '<div class="d blank"></div>';
  for (let i = 1; i <= days; i++) {
    const key = `${y}-${String(mo + 1).padStart(2, "0")}-${String(i).padStart(2, "0")}`;
    const past = new Date(y, mo, i) < today;
    const s = EDITED[key] !== undefined ? { total: EDITED[key], sold: (STOCK[key] || {}).sold || 0 } : STOCK[key];
    const has = s && s.total > 0;
    h += `<div class="d ${has ? "has" : ""} ${EDITED[key] !== undefined ? "edited" : ""} ${past && !has ? "past" : ""}"
           ${past && !has ? "" : `onclick="openDay('${key}')"`}>
      <div class="n">${i}</div>
      ${has ? `<div class="q"><span class="lb">設定 </span><b>${s.total}</b><br><span class="lb">剩餘 </span><i>${s.total - s.sold}</i></div>` : ""}
    </div>`;
  }
  document.getElementById("cal").innerHTML = h;
  const n = Object.keys(EDITED).length;
  document.getElementById("unsaved").style.display = n ? "flex" : "none";
  document.getElementById("edCount").textContent = n;
}

function calMv(d) { CALM = new Date(CALM.getFullYear(), CALM.getMonth() + d, 1); renderCal(); }

function openDay(key) {
  DAYKEY = key;
  const s = EDITED[key] !== undefined ? { total: EDITED[key], sold: (STOCK[key] || {}).sold || 0 } : (STOCK[key] || { total: 0, sold: 0 });
  document.getElementById("mdTitle").textContent = key.replace(/-/g, " / ");
  document.getElementById("mdQty").value = s.total;
  document.getElementById("mdHint").innerHTML = s.sold
    ? `這天已經賣出 <b>${s.sold}</b> 個，設定量不能低於這個數字。`
    : "填 0 = 這天不出貨。";
  openMask("mDay");
  setTimeout(() => document.getElementById("mdQty").select(), 50);
}

function dayOk() {
  const v = parseInt(document.getElementById("mdQty").value, 10) || 0;
  const sold = (STOCK[DAYKEY] || {}).sold || 0;
  if (v < sold) { toast(`這天已賣出 ${sold} 個，不能設得比它少`); return; }
  EDITED[DAYKEY] = v;
  closeMask("mDay");
  renderCal();
}

async function calSave() {
  const days = Object.entries(EDITED).map(([date, qty]) => ({ date, qty }));
  if (!days.length) return;
  const r = await api("/api/admin/stock", { product_id: CURP.id, days });
  if (!r.ok && (r.refused || []).length) {
    toast(r.refused[0].why || "有日期存不進去");
  } else {
    toast("日期設定已儲存");
  }
  EDITED = {};
  await loadStock();
}

function calReset() { EDITED = {}; renderCal(); toast("已放棄未儲存的變更"); }

// ═══════ 照片 ═══════

let PHOTO_TARGET = null;   // 'thumb' | 'photos' | 'hero'

function renderPePhotos() {
  // 縮圖只有一張 —— 已經有圖就不再顯示「＋」，免得看起來像能放很多張
  // （要換圖就按圖片右上角的 ×，＋ 會再出現）
  const thumb = CURP.thumb;
  document.getElementById("peThumb").innerHTML = thumb
    ? `<div class="photo-item"><img src="/img/${encodeURIComponent(thumb)}">
         <button class="x" onclick="removePhoto('thumb','${thumb}')">×</button></div>`
    : `<div class="pnew photo-add" onclick="pickPhoto('thumb')"><i>＋</i></div>`;

  const photos = jsonOr(CURP.photos, []);
  document.getElementById("pePhotos").innerHTML =
    photos.map((k) => `<div class="photo-item"><img src="/img/${encodeURIComponent(k)}">
      <button class="x" onclick="removePhoto('photos','${k}')">×</button></div>`).join("")
    + `<div class="pnew photo-add" onclick="pickPhoto('photos')"><i>＋</i></div>`;
}

function pickPhoto(target) {
  PHOTO_TARGET = target;
  const input = document.getElementById("fileInput");
  input.value = "";
  input.click();
}

document.getElementById("fileInput").addEventListener("change", async function () {
  const file = this.files && this.files[0];
  if (!file) return;
  toast("處理照片中…");
  try {
    const dataUrl = await shrinkImage(file, 1200);
    const r = await api("/api/admin/photo-upload", { data: dataUrl });
    if (!r.ok) { toast(r.message || "上傳失敗"); return; }
    if (PHOTO_TARGET === "thumb") { CURP.thumb = r.key; renderPePhotos(); }
    else if (PHOTO_TARGET === "photos") {
      const a = jsonOr(CURP.photos, []); a.push(r.key); CURP.photos = JSON.stringify(a); renderPePhotos();
    } else if (PHOTO_TARGET === "hero") {
      HERO.push(r.key); renderHero();
    }
    toast("照片已上傳，記得按儲存");
  } catch (e) { toast("這張照片讀不進來，換一張試試"); }
});

function removePhoto(target, key) {
  if (target === "thumb") CURP.thumb = "";
  else if (target === "photos") CURP.photos = JSON.stringify(jsonOr(CURP.photos, []).filter((k) => k !== key));
  else if (target === "hero") { HERO = HERO.filter((k) => k !== key); renderHero(); return; }
  renderPePhotos();
}

// 上傳前先在瀏覽器縮小，省流量也避開 2MB 上限
function shrinkImage(file, maxW) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ═══════ 加購商品 ═══════

let CURA = null;

function openAddon(id) {
  CURA = id ? ADDONS.find((a) => a.id === id) : { id: 0, name: "", description: "", price: 0, stock: 0, status: "on" };
  document.getElementById("maTitle").textContent = id ? "編輯加購商品" : "新增加購商品";
  document.getElementById("maName").value = CURA.name;
  document.getElementById("maDesc").value = CURA.description || "";
  document.getElementById("maPrice").value = CURA.price || "";
  document.getElementById("maStock").value = CURA.stock || 0;
  document.getElementById("maStatus").value = CURA.status || "on";
  openMask("mAddon");
}

async function saveAddon() {
  const body = {
    id: CURA.id,
    name: document.getElementById("maName").value.trim(),
    description: document.getElementById("maDesc").value.trim(),
    price: parseInt(document.getElementById("maPrice").value, 10) || 0,
    stock: parseInt(document.getElementById("maStock").value, 10) || 0,
    status: document.getElementById("maStatus").value,
  };
  if (!body.name) { toast("請填名稱"); return; }
  const r = await api("/api/admin/addon", body);
  if (!r.ok) { toast(r.message || "儲存失敗"); return; }
  closeMask("mAddon");
  await loadProducts();
  toast("加購商品已儲存");
}

// ═══════ 訂單系統 ═══════

const ALLCOLS = [
  { k: "created_at", t: "訂購日期" }, { k: "ship_date", t: "出貨日期" }, { k: "order_no", t: "訂單編號" },
  { k: "ship_method", t: "配送方式" }, { k: "buyer_name", t: "訂購人" }, { k: "rcpt_name", t: "收件人" },
  { k: "buyer_phone", t: "電話" }, { k: "rcpt_address", t: "收件地址" }, { k: "amount", t: "金額" },
  { k: "pay_status", t: "付款狀態" }, { k: "order_status", t: "訂單狀態" }, { k: "last5", t: "末五碼" },
  { k: "note", t: "備註" },
];
let COLS = [], ORDERS = [], SEL = new Set(), SORT = "created_at", DIR = "desc";
let _searchTimer;

function filterQuery() {
  const v = (id) => document.getElementById(id).value;
  const p = new URLSearchParams();
  p.set("date_type", v("fDateType"));
  if (v("fFrom")) p.set("from", v("fFrom"));
  if (v("fTo")) p.set("to", v("fTo"));
  if (v("fPay")) p.set("pay_status", v("fPay"));
  if (v("fSt")) p.set("order_status", v("fSt"));
  if (v("fShip")) p.set("ship_method", v("fShip"));
  if (v("fQ").trim()) p.set("q", v("fQ").trim());
  p.set("sort", SORT); p.set("dir", DIR);
  return p.toString();
}

async function loadOrders() {
  if (!COLS.length) {
    const s = await api("/api/admin/settings");
    const saved = jsonOr((s.settings || {}).order_columns, null);
    COLS = ALLCOLS.map((c) => ({ ...c, on: saved ? saved.includes(c.k) : c.k !== "rcpt_address" && c.k !== "note" }));
  }
  const r = await api("/api/admin/orders?" + filterQuery());
  ORDERS = r.orders || [];
  renderOrders(r.total || 0);
}

function renderOrders(total) {
  const vc = COLS.filter((c) => c.on);
  const allOn = ORDERS.length && ORDERS.every((o) => SEL.has(o.id));

  document.getElementById("othead").innerHTML =
    `<tr><th style="width:36px"><span class="ck ${allOn ? "on" : ""}" onclick="toggleAll(event)"></span></th>`
    + vc.map((c) => `<th class="${SORT === c.k ? "sorted" : ""}" onclick="doSort('${c.k}')">${c.t}
        <span class="ar">${SORT === c.k ? (DIR === "asc" ? "▲" : "▼") : "▼"}</span></th>`).join("") + "</tr>";

  document.getElementById("otbody").innerHTML = ORDERS.length ? ORDERS.map((o) => `
    <tr class="${SEL.has(o.id) ? "sel" : ""}" ondblclick="openOrder(${o.id})"
        onclick="if(window.innerWidth<=860)openOrder(${o.id})">
      <td><span class="ck ${SEL.has(o.id) ? "on" : ""}" onclick="event.stopPropagation();toggleSel(${o.id})"></span></td>
      ${vc.map((c) => `<td>${cellOf(o, c.k)}</td>`).join("")}
    </tr>`).join("")
    : `<tr><td colspan="${vc.length + 1}" class="blank">沒有符合條件的訂單</td></tr>`;

  document.getElementById("cntTxt").textContent =
    `共 ${total} 筆　·　${window.innerWidth <= 860 ? "點一列可編輯" : "雙擊任一列可編輯"}`;
  document.getElementById("batchbar").style.display = SEL.size ? "flex" : "none";
  document.getElementById("selN").textContent = SEL.size;
}

function cellOf(o, k) {
  if (k === "ship_method") return `<span class="tag ${o.ship_method}">${shipLabel(o.ship_method)}</span>`;
  if (k === "pay_status") return `<span class="tag ${o.pay_status === "已付款" ? "paid" : "unpaid"}">${o.pay_status}</span>`;
  if (k === "order_status") return `<span class="tag ${o.order_status === "已作廢" ? "void" : o.order_status === "已處理" ? "paid" : ""}">${o.order_status}</span>`;
  if (k === "amount") return `<b style="font-family:'Noto Serif TC',serif;font-weight:500">${Number(o.amount).toLocaleString()}</b>`;
  if (k === "rcpt_address") return `<span style="color:var(--soft)">${esc(`${o.rcpt_zip} ${o.rcpt_county}${o.rcpt_district}${o.rcpt_address}`.trim())}</span>`;
  if (k === "note") return o.note ? `<span style="color:var(--soft)">${esc(o.note)}</span>` : '<span style="color:#d8cdb6">—</span>';
  return esc(o[k]);
}

function doSort(k) { if (SORT === k) DIR = DIR === "asc" ? "desc" : "asc"; else { SORT = k; DIR = "asc"; } loadOrders(); }
function toggleSel(id) { SEL.has(id) ? SEL.delete(id) : SEL.add(id); renderOrders(ORDERS.length); }
function toggleAll(e) {
  e.stopPropagation();
  if (SEL.size) SEL.clear(); else ORDERS.forEach((o) => SEL.add(o.id));
  renderOrders(ORDERS.length);
}
function clearSel() { SEL.clear(); renderOrders(ORDERS.length); }

async function batchDo(field, el) {
  if (el.selectedIndex === 0) return;
  const value = el.value;
  el.selectedIndex = 0;
  if (!SEL.size) return;
  const r = await api("/api/admin/orders-batch", { ids: [...SEL], field, value });
  if (r.done) toast(`已把 ${r.done} 筆改成「${value}」` + ((r.failed || []).length ? `，${r.failed.length} 筆沒改成` : ""));
  if ((r.failed || []).length) toast(r.failed[0].why || "有訂單改不動");
  SEL.clear();
  await loadOrders();
}

function doExport() { window.location.href = "/api/admin/export?" + filterQuery(); }

function openCols() {
  document.getElementById("colList").innerHTML = COLS.map((c, i) => `
    <div class="colsel"><span class="gr">⋮⋮</span>
      <span class="ck ${c.on ? "on" : ""}" onclick="COLS[${i}].on=!COLS[${i}].on;this.classList.toggle('on')"></span>
      <span style="flex:1;font-size:13.5px">${c.t}</span></div>`).join("");
  openMask("mCols");
}

async function saveCols() {
  closeMask("mCols");
  await api("/api/admin/settings", { order_columns: JSON.stringify(COLS.filter((c) => c.on).map((c) => c.k)) });
  renderOrders(ORDERS.length);
  toast("顯示欄位已更新");
}

// ── 單筆訂單 ──

let CURO = null;

async function openOrder(id) {
  // 先把視窗開起來顯示「載入中」——
  // 原本是等資料回來才開窗，按下去到視窗出現之間畫面完全沒動靜，感覺像當掉。
  document.getElementById("moTitle").textContent = "訂單";
  document.getElementById("mo-edit").innerHTML = '<div class="loading">載入中…</div>';
  document.getElementById("mo-rev").innerHTML = "";
  moTab("edit", document.querySelector("#mOrder .tabs a"));
  openMask("mOrder");

  const r = await api("/api/admin/order?id=" + id);
  if (!r.ok) { closeMask("mOrder"); toast("找不到這筆訂單"); return; }
  CURO = r;
  document.getElementById("moTitle").textContent = "訂單 " + r.order.order_no;

  const o = r.order;
  const fld = (id2, label, val, type) =>
    `<div class="f"><label>${label}</label><input id="${id2}" ${type ? `type="${type}"` : ""} value="${esc(val == null ? "" : val)}"></div>`;

  document.getElementById("mo-edit").innerHTML = `
    <div class="row">
      <div class="f"><label>訂單編號</label><input value="${esc(o.order_no)}" readonly style="background:#f2ece1;color:var(--soft)"></div>
      ${fld("moShipDate", "出貨日期", o.ship_date, "date")}
      <div class="f"><label>配送方式</label><select id="moShipM">
        ${SHIPCFG.map((c) => `<option value="${c.method}" ${o.ship_method === c.method ? "selected" : ""}>${c.label}</option>`).join("")}
      </select></div>
    </div>
    <div class="row">
      <div class="f"><label>付款狀態</label><select id="moPay">
        ${["未付款", "已付款"].map((v) => `<option ${o.pay_status === v ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      <div class="f"><label>訂單狀態</label><select id="moSt">
        ${["待處理", "已處理", "已作廢"].map((v) => `<option ${o.order_status === v ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      ${fld("moL5", "匯款末五碼", o.last5)}
    </div>
    <div style="border-top:1px solid var(--line);margin:8px 0 16px"></div>
    <div class="row">
      ${fld("moBName", "訂購人姓名", o.buyer_name)}
      ${fld("moBPhone", "電話", o.buyer_phone)}
      ${fld("moBMail", "Email", o.buyer_email)}
    </div>
    <div class="row">
      ${fld("moBCounty", "縣市", o.buyer_county)}
      ${fld("moBDist", "區域", o.buyer_district)}
      ${fld("moBZip", "郵遞區號", o.buyer_zip)}
    </div>
    ${fld("moBAddr", "訂購人地址", o.buyer_address)}
    <div style="border-top:1px solid var(--line);margin:8px 0 16px"></div>
    <div class="row">
      ${fld("moRName", "收件人姓名", o.rcpt_name)}
      ${fld("moRPhone", "電話", o.rcpt_phone)}
      ${fld("moRMail", "Email", o.rcpt_email)}
    </div>
    <div class="row">
      ${fld("moRCounty", "縣市", o.rcpt_county)}
      ${fld("moRDist", "區域", o.rcpt_district)}
      ${fld("moRZip", "郵遞區號", o.rcpt_zip)}
    </div>
    ${fld("moRAddr", "收件人地址", o.rcpt_address)}
    <div style="border-top:1px solid var(--line);margin:8px 0 16px"></div>
    <div class="f"><label>訂購內容（改數量會同步調整庫存）</label>
      <div class="tbwrap mini-tb"><table>
        <thead><tr><th>品項</th><th style="width:90px">單價</th><th style="width:110px">數量</th><th style="width:100px">小計</th></tr></thead>
        <tbody>${r.items.map((it) => `
          <tr><td style="${it.kind === "addon" ? "padding-left:28px;color:var(--soft)" : ""}">${it.kind === "addon" ? "＋ " : ""}${esc(it.name)}</td>
            <td>${it.unit_price}</td>
            <td><input type="number" id="it${it.id}" value="${it.qty}" min="0"></td>
            <td>${(it.unit_price * it.qty).toLocaleString()}</td></tr>`).join("")}
        </tbody></table></div>
      <p class="hint" style="margin-top:8px">數量填 0 = 從這張訂單移除。</p>
    </div>
    <div class="row">
      ${fld("moSubtotal", "商品小計", o.subtotal, "number")}
      ${fld("moShipFee", "運費", o.ship_fee, "number")}
      ${fld("moAmount", "總金額", o.amount, "number")}
    </div>
    <div class="f"><label>備註</label><textarea id="moNote">${esc(o.note || "")}</textarea></div>`;

  document.getElementById("mo-rev").innerHTML = (r.revisions || []).map((v, i) => `
    <div class="rev ${i === 0 ? "cur" : ""}">
      <div class="dt"><b>${i === 0 ? "最新這版" : "第 " + (r.revisions.length - i) + " 版"}</b>${v.changed_at}</div>
      <div class="ch">${esc(v.summary)}<span style="color:var(--soft)"> · ${esc(v.changed_by)}</span>
        ${i === 0 ? "" : `<div style="margin-top:6px"><button class="b gh sm" onclick="revertTo(${v.id})">回到這一版</button></div>`}
      </div>
    </div>`).join("") || '<div class="blank">還沒有修改紀錄</div>';

}

function moTab(t, el) {
  document.querySelectorAll("#mOrder .tabs a").forEach((a) => a.classList.remove("on"));
  el.classList.add("on");
  document.getElementById("mo-edit").style.display = t === "edit" ? "block" : "none";
  document.getElementById("mo-rev").style.display = t === "rev" ? "block" : "none";
}

async function saveOrder() {
  const v = (id) => document.getElementById(id).value;
  const body = {
    id: CURO.order.id,
    ship_date: v("moShipDate"), ship_method: v("moShipM"),
    pay_status: v("moPay"), order_status: v("moSt"), last5: v("moL5"),
    buyer_name: v("moBName"), buyer_phone: v("moBPhone"), buyer_email: v("moBMail"),
    buyer_county: v("moBCounty"), buyer_district: v("moBDist"), buyer_zip: v("moBZip"), buyer_address: v("moBAddr"),
    rcpt_name: v("moRName"), rcpt_phone: v("moRPhone"), rcpt_email: v("moRMail"),
    rcpt_county: v("moRCounty"), rcpt_district: v("moRDist"), rcpt_zip: v("moRZip"), rcpt_address: v("moRAddr"),
    subtotal: parseInt(v("moSubtotal"), 10) || 0,
    ship_fee: parseInt(v("moShipFee"), 10) || 0,
    amount: parseInt(v("moAmount"), 10) || 0,
    note: v("moNote"),
    items: CURO.items.map((it) => ({ id: it.id, qty: parseInt(v("it" + it.id), 10) || 0 })),
  };
  busy("moSave", true, "儲存中…");
  const r = await api("/api/admin/order-save", body);
  busy("moSave", false);
  if (!r.ok) { toast(r.message || "儲存失敗"); return; }
  closeMask("mOrder");
  await loadOrders();
  toast(r.unchanged ? "沒有任何變更" : "已儲存，並記錄一個新版本");
}

async function revertTo(revId) {
  if (!confirm("確定要回到這一版嗎？現在的內容會被覆蓋（但會留成一個新版本，還是救得回來）。")) return;
  const r = await api("/api/admin/order-revert", { id: CURO.order.id, revision_id: revId });
  if (!r.ok) { toast(r.message || "還原失敗"); return; }
  closeMask("mOrder");
  await loadOrders();
  toast("已回到那一版");
}

async function deleteOrder() {
  if (!confirm("刪除會把這筆訂單移到垃圾桶，數量也會還回庫存。確定嗎？")) return;
  const r = await api("/api/admin/order-delete", { id: CURO.order.id });
  if (!r.ok) { toast(r.message || "刪除失敗"); return; }
  closeMask("mOrder");
  await loadOrders();
  toast("已移到垃圾桶");
}

async function openTrash() {
  openMask("mTrash");
  const r = await api("/api/admin/trash");
  const rows = r.orders || [];
  document.getElementById("trashBody").innerHTML = rows.length ? `
    <div class="tbwrap"><table>
      <thead><tr><th>訂單編號</th><th>訂購人</th><th>金額</th><th>刪除時間</th><th style="width:170px"></th></tr></thead>
      <tbody>${rows.map((o) => `<tr>
        <td>${esc(o.order_no)}</td><td>${esc(o.buyer_name)}</td><td>${Number(o.amount).toLocaleString()}</td>
        <td style="color:var(--soft)">${o.deleted_at}</td>
        <td><button class="b gh sm" onclick="restoreOrder(${o.id})">還原</button>
            <button class="b rd sm" onclick="purgeOrder(${o.id})">永久刪除</button></td></tr>`).join("")}
      </tbody></table></div>`
    : '<div class="blank">垃圾桶是空的</div>';
}

async function restoreOrder(id) {
  const r = await api("/api/admin/order-restore", { id });
  if (!r.ok) { toast(r.message || "還原失敗"); return; }
  await openTrash(); await loadOrders();
  toast("已還原");
}

async function purgeOrder(id) {
  if (!confirm("永久刪除之後就救不回來了。確定嗎？")) return;
  const r = await api("/api/admin/order-purge", { id });
  if (!r.ok) { toast(r.message || "刪除失敗"); return; }
  await openTrash();
  toast("已永久刪除");
}

// ═══════ 網站編輯 ═══════

let SETTINGS = {}, HERO = [], BIZ = true;

async function loadSiteTitle() {
  const r = await api("/api/admin/settings");
  SETTINGS = r.settings || {};
  const lg = document.getElementById("sideLg");
  lg.firstChild.nodeValue = SETTINGS.site_title || "後台";
}

async function loadSite() {
  const r = await api("/api/admin/settings");
  SETTINGS = r.settings || {};
  const set = (id, k) => { document.getElementById(id).value = SETTINGS[k] || ""; };
  set("stTitle", "site_title"); set("stSub", "site_subtitle");
  set("stSection", "home_section_title"); set("stFooter", "footer_text");
  set("stCartNote", "cart_note"); set("stClosedNotice", "closed_notice");
  set("stBankName", "bank_name"); set("stBankAcct", "bank_account");
  set("stPayDeadline", "pay_deadline"); set("stLeadDays", "lead_days");
  set("stSuccessTitle", "success_title"); set("stSuccessSub", "success_sub"); set("stSuccessNote", "success_note");

  BIZ = String(SETTINGS.biz_open) !== "0";
  applyBiz();
  HERO = jsonOr(SETTINGS.hero_photos, []);
  renderHero();
  syncPreview();
}

function applyBiz() {
  document.getElementById("bizSw").classList.toggle("on", BIZ);
  document.getElementById("bizLabel").textContent = BIZ ? "營業中 · 客人可以下單" : "暫停接單 · 前台顯示公告";
  document.getElementById("bizMsg").style.display = BIZ ? "none" : "block";
}

function toggleBiz() { BIZ = !BIZ; applyBiz(); }

function renderHero() {
  document.getElementById("heroPhotos").innerHTML =
    HERO.map((k) => `<div class="photo-item"><img src="/img/${encodeURIComponent(k)}">
      <button class="x" onclick="removePhoto('hero','${k}')">×</button></div>`).join("")
    + `<div class="pnew photo-add" onclick="pickPhoto('hero')"><i>＋</i></div>`;
}

function syncPreview() {
  document.getElementById("pvT").textContent = document.getElementById("stTitle").value;
  document.getElementById("pvS").textContent = document.getElementById("stSub").value;
  const lg = document.getElementById("sideLg");
  lg.firstChild.nodeValue = document.getElementById("stTitle").value || "後台";
}

async function saveSite() {
  const v = (id) => document.getElementById(id).value;
  busy("siteSaveBtn", true, "儲 存 中 …");
  const r = await api("/api/admin/settings", {
    site_title: v("stTitle"), site_subtitle: v("stSub"),
    home_section_title: v("stSection"), footer_text: v("stFooter"),
    cart_note: v("stCartNote"), closed_notice: v("stClosedNotice"),
    bank_name: v("stBankName"), bank_account: v("stBankAcct"),
    pay_deadline: v("stPayDeadline"), lead_days: v("stLeadDays"),
    success_title: v("stSuccessTitle"), success_sub: v("stSuccessSub"), success_note: v("stSuccessNote"),
    biz_open: BIZ ? "1" : "0",
    hero_photos: JSON.stringify(HERO),
  });
  busy("siteSaveBtn", false);
  toast(r.ok ? "網站設定已儲存" : (r.message || "儲存失敗"));
}

// ═══════ 運費 ═══════

async function loadShipping() {
  const r = await api("/api/admin/shipping");
  SHIPCFG = r.shipping || [];
  document.getElementById("shipRows").innerHTML = SHIPCFG.map((c) => `
    <tr>
      <td><span class="ck ${c.enabled ? "on" : ""}" id="sw_${c.method}" onclick="this.classList.toggle('on')"></span></td>
      <td><span class="tag ${c.method}">${c.label}</span></td>
      <td><input type="number" id="fee_${c.method}" value="${c.fee}" style="width:110px;font-family:inherit;font-size:13px;border:1px solid var(--line);border-radius:8px;padding:6px 10px"></td>
      <td><input type="number" id="free_${c.method}" value="${c.free_threshold}" style="width:110px;font-family:inherit;font-size:13px;border:1px solid var(--line);border-radius:8px;padding:6px 10px"></td>
    </tr>`).join("");
}

async function saveShipping() {
  busy("shipSaveBtn", true, "儲 存 中 …");
  const r = await api("/api/admin/shipping", {
    shipping: SHIPCFG.map((c) => ({
      method: c.method,
      fee: parseInt(document.getElementById("fee_" + c.method).value, 10) || 0,
      free_threshold: parseInt(document.getElementById("free_" + c.method).value, 10) || 0,
      enabled: document.getElementById("sw_" + c.method).classList.contains("on"),
    })),
  });
  busy("shipSaveBtn", false);
  if (r.ok) SHIPCFG = r.shipping;
  toast(r.ok ? "運費設定已儲存" : "儲存失敗");
}

// ═══════ 系統管理 ═══════

async function loadAdmins() {
  const r = await api("/api/admin/admins");
  if (!r.ok) return;
  document.getElementById("adminRows").innerHTML = (r.admins || []).map((a) => `
    <tr>
      <td>${esc(a.username)}</td>
      <td><span class="tag ${a.role === "full" ? "on" : ""}">${a.role === "full" ? "完整" : "一般"}</span></td>
      <td style="color:var(--soft)">${a.last_login || "還沒登入過"}</td>
      <td>${a.username === ME.username
        ? '<span style="color:var(--soft);font-size:11.5px">（你自己）</span>'
        : `<button class="b gh sm" onclick="switchRole(${a.id},'${a.role === "full" ? "normal" : "full"}')">改成${a.role === "full" ? "一般" : "完整"}</button>
           <button class="b rd sm" onclick="removeAdmin(${a.id},'${esc(a.username)}')">刪除</button>`}</td>
    </tr>`).join("");
}

function openNewAdmin() {
  document.getElementById("naUser").value = "";
  document.getElementById("naPass").value = "";
  document.getElementById("naErr").textContent = "";
  openMask("mAdmin");
}

async function createAdmin() {
  const r = await api("/api/admin/admin-create", {
    username: document.getElementById("naUser").value.trim(),
    password: document.getElementById("naPass").value,
    role: document.getElementById("naRole").value,
  });
  if (!r.ok) { document.getElementById("naErr").textContent = r.message || "建立失敗"; return; }
  closeMask("mAdmin");
  await loadAdmins();
  toast("帳號已建立");
}

async function switchRole(id, role) {
  const r = await api("/api/admin/admin-role", { id, role });
  if (!r.ok) { toast(r.message || "改不動"); return; }
  await loadAdmins();
  toast("權限已更新");
}

async function removeAdmin(id, name) {
  if (!confirm(`確定要刪除帳號「${name}」嗎？`)) return;
  const r = await api("/api/admin/admin-delete", { id });
  if (!r.ok) { toast(r.message || "刪不掉"); return; }
  await loadAdmins();
  toast("帳號已刪除");
}

async function changeMyPw() {
  const o = document.getElementById("myOld").value, n = document.getElementById("myNew").value, n2 = document.getElementById("myNew2").value;
  if (n.length < 6) { toast("新密碼至少 6 個字"); return; }
  if (n !== n2) { toast("兩次輸入的新密碼不一樣"); return; }
  const r = await api("/api/admin/change-password", { old_password: o, new_password: n });
  if (!r.ok) { toast(r.message || "更新失敗"); return; }
  ["myOld", "myNew", "myNew2"].forEach((id) => document.getElementById(id).value = "");
  toast("密碼已更新");
}

// ═══════ 啟動 ═══════

document.querySelectorAll(".mask").forEach((m) => {
  m.addEventListener("click", (e) => { if (e.target === m) m.classList.remove("on"); });
});
document.getElementById("fQ").addEventListener("input", () => {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(loadOrders, 350);   // 等打字停下來再查，不要每按一鍵就打一次
});
["lgUser", "lgPass"].forEach((id) =>
  document.getElementById(id).addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); }));
["suUser", "suPass", "suPass2"].forEach((id) =>
  document.getElementById(id).addEventListener("keydown", (e) => { if (e.key === "Enter") doSetup(); }));

boot();

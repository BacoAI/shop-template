// 販售系統 v2 — 路由總管
//
// 這個檔只做一件事：看網址決定交給誰處理。實際邏輯分在：
//   lib.js     共用小工具（時間、密碼雜湊、設定讀寫）
//   shop.js    前台 API（商品、可選日期、試算、下單擋超賣）
//   admin.js   後台 API（登入、商品、日曆、加購、設定、運費、帳號、照片）
//   orders.js  後台 · 訂單系統（篩選、匯出、編輯、版本回溯、垃圾桶）
//   mail.js    下單通知信（選填，沒設金鑰就不寄）
//
// ⚠ v1 的舊 API（/api/batch、/api/order 那些）已經不在了。
//   想看 v1 怎麼寫的：git 的 505287e。

import { json, getSettings, jsonParse, esc, rich } from "./lib.js";
import { apiHome, apiProduct, apiDates, apiQuote, apiOrder } from "./shop.js";
import { handleAdmin, currentAdmin } from "./admin.js";
import { handleOrders } from "./orders.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const M = request.method;

    try {
      // ── 前台 API ──
      if (path === "/api/shop/home" && M === "GET") return apiHome(env);
      if (path === "/api/shop/product" && M === "GET") return apiProduct(url, env);
      if (path === "/api/shop/dates" && M === "POST") return apiDates(request, env);
      if (path === "/api/shop/quote" && M === "POST") return apiQuote(request, env);
      if (path === "/api/shop/order" && M === "POST") return apiOrder(request, env, ctx);

      // ── 照片（存在 KV，用 /img/<檔名> 取）──
      if (path.startsWith("/img/")) return serveImage(path, env);

      // ── 後台 API ──
      if (path.startsWith("/api/admin/")) {
        // 整個後台只查一次登入狀態，兩個模組共用
        const me = await currentAdmin(request, env);

        const a = await handleAdmin(path, request, env, me);
        if (a) return a;

        // admin.js 不認得的 → 訂單系統（一定要登入）
        if (!me) return json({ ok: false, error: "unauthorized", message: "請先登入" }, 401);
        if (me.must_change_pw)
          return json({ ok: false, error: "must_change_pw", message: "請先修改預設密碼" }, 403);

        const o = await handleOrders(path, request, env, me);
        if (o) return o;

        return json({ ok: false, error: "not_found" }, 404);
      }

      // ── 前台頁面：先把後台設定的文字填進去再送出 ──
      if (PAGES[path]) return renderPage(request, env, PAGES[path]);

      // ── 其餘交給靜態檔（郵遞區號、圖片、設計稿）──
      return env.ASSETS.fetch(request);

    } catch (err) {
      return json({
        ok: false, error: "server_error",
        message: String((err && err.message) || err),
      }, 500);
    }
  },
};

// 照片：檔名帶時間戳、內容不會變，所以讓瀏覽器放心長期快取
async function serveImage(path, env) {
  if (!env.IMG) return new Response("image store not configured", { status: 404 });
  const key = decodeURIComponent(path.slice("/img/".length));
  if (!key || key.includes("/") || key.includes("..")) return new Response("bad key", { status: 400 });
  const got = await env.IMG.getWithMetadata(key, { type: "arrayBuffer" });
  if (!got || !got.value) return new Response("not found", { status: 404 });
  return new Response(got.value, {
    headers: {
      "Content-Type": (got.metadata && got.metadata.ct) || "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}


// ═══════════ 前台頁面：伺服器端填字 ═══════════
//
// 為什麼不讓前端 JS 自己抓：那樣客人會先看到範例文字、零點幾秒後才跳成店主的內容。
// 這裡在送出頁面之前就填好，客人拿到的是完成品。
// 動態的東西（商品清單、購物車、可選日期）仍由前端打 API，因為那些要即時。
//
// ⚠ HTML 裡的 data-s="..." 記號不要亂刪，那是這裡用來認「這格要填什麼」的位置。

// ⚠ 兩種寫法都要認：Cloudflare 的靜態檔服務會把 /cart.html 重導成 /cart，
//    只認一種的話，客人被重導之後就會拿到沒填字的原始頁面。
const PAGES = {
  "/": "index.html",
  "/index.html": "index.html", "/index": "index.html",
  "/product.html": "product.html", "/product": "product.html",
  "/cart.html": "cart.html", "/cart": "cart.html",
  "/done.html": "done.html", "/done": "done.html",
};

async function renderPage(request, env, file) {
  const url = new URL(request.url);
  const res = await env.ASSETS.fetch(new Request(new URL("/" + file, url).toString(), { method: "GET" }));

  let s, photos;
  try {
    s = await getSettings(env);
    photos = jsonParse(s.hero_photos, []);
    if (!Array.isArray(photos)) photos = [];
  } catch (e) {
    return res;   // 資料庫出問題時至少把原始頁面送出去，不要整個掛掉
  }

  const rw = new HTMLRewriter()
    .on("title", {
      element(el) { if (s.page_title) el.setInnerContent(s.page_title); },
    })
    .on("[data-s]", {
      element(el) {
        const k = el.getAttribute("data-s");
        if (s[k] === undefined) return;
        const v = String(s[k]);
        if (!v) { el.setInnerContent(""); return; }
        el.setInnerContent(rich(v, s), { html: true });
      },
    })
    // data-s-hide="key"：這個設定留空時整塊不顯示（副標那種）
    .on("[data-s-hide]", {
      element(el) {
        const k = el.getAttribute("data-s-hide");
        if (!String(s[k] || "").trim()) el.remove();
      },
    })
    // 首頁大圖：店主沒傳過就保留 HTML 裡的預設圖
    .on("[data-photos]", {
      element(el) {
        if (!photos.length) return;
        el.setInnerContent(
          photos.map((k) => `<img src="/img/${encodeURIComponent(k)}" alt="${esc(s.site_title || "")}">`).join(""),
          { html: true }
        );
      },
    });

  return new Response(rw.transform(res).body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",   // 後台一改，客人重整就要看到新的
    },
  });
}

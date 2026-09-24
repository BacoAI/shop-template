// 下單通知信 —— 選填功能
//
// Cloudflare Worker 自己不能寄信，要接別人的服務。這裡用 Resend（免費額度每月 3000 封）。
// 沒設定 RESEND_API_KEY 就完全不會執行到這裡，訂單照樣成立。
//
// 要啟用：
//   1. 去 https://resend.com 註冊、拿一組 API key
//   2. npx wrangler secret put RESEND_API_KEY
//   3.（選）npx wrangler secret put MAIL_FROM   ← 驗證過的寄件地址，沒設就用 Resend 的測試地址
//
// ⚠ 金鑰只放 wrangler secret，不要寫進程式碼、不要存進資料庫。

import { esc } from "./lib.js";

export async function sendOrderMail(env, settings, o) {
  const fromAddr = env.MAIL_FROM || "onboarding@resend.dev";
  const fromName = settings.mail_from_name || settings.site_title || "訂購通知";
  const subject = `${settings.mail_subject || "訂單成立通知"}（${o.order_no}）`;

  const rows = o.lines.map((l) => {
    const main = `<tr><td style="padding:8px 0">${esc(l.product.name)}</td>
      <td style="padding:8px 0;text-align:center">×${l.qty}</td>
      <td style="padding:8px 0;text-align:right">$${l.product.price * l.qty}</td></tr>`;
    const adds = l.addons.map((a) =>
      `<tr><td style="padding:4px 0 4px 20px;color:#8a7c66;font-size:13px">＋${esc(a.name)}</td>
       <td style="padding:4px 0;text-align:center;color:#8a7c66;font-size:13px">×${a.qty}</td>
       <td style="padding:4px 0;text-align:right;color:#8a7c66;font-size:13px">$${a.price * a.qty}</td></tr>`
    ).join("");
    return main + adds;
  }).join("");

  const html = `
<div style="font-family:-apple-system,'Noto Sans TC',sans-serif;max-width:520px;margin:0 auto;
            background:#faf6ee;color:#403628;padding:28px 24px;line-height:1.8">
  <h2 style="font-size:19px;font-weight:500;color:#46615c;letter-spacing:.08em;margin:0 0 4px">
    ${esc(settings.success_title || "訂單已成立")}</h2>
  <p style="font-size:13px;color:#8a7c66;margin:0 0 20px">${esc(o.name)} 你好，謝謝你的訂購。</p>

  <div style="background:#fff;border:1px dashed #d8cdb6;border-radius:12px;padding:14px 18px;margin-bottom:18px">
    <div style="font-size:11px;color:#8a7c66;letter-spacing:.14em">訂 單 編 號</div>
    <div style="font-size:18px;letter-spacing:.06em">${esc(o.order_no)}</div>
  </div>

  <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}
    <tr><td colspan="3" style="border-top:1px solid #e4d9c5;padding-top:10px"></td></tr>
    <tr><td colspan="2" style="color:#8a7c66">商品小計</td>
        <td style="text-align:right">$${o.subtotal}</td></tr>
    <tr><td colspan="2" style="color:#8a7c66">運費（${esc(o.ship_label)}）</td>
        <td style="text-align:right">${o.freeShipped ? "免運" : "$" + o.shipFee}</td></tr>
    <tr><td colspan="2" style="padding-top:8px;font-size:15px">應付金額</td>
        <td style="text-align:right;padding-top:8px;font-size:19px;color:#b5734a">$${o.amount}</td></tr>
  </table>

  <div style="margin-top:20px;font-size:14px">
    <div style="color:#8a7c66;font-size:12px">出貨日</div>
    <div style="margin-bottom:10px">${esc(o.ship_date)}（${esc(o.ship_label)}）</div>
    ${settings.bank_account ? `
    <div style="color:#8a7c66;font-size:12px">匯款帳號</div>
    <div style="margin-bottom:10px">${esc(settings.bank_name || "")} ${esc(settings.bank_account)}</div>` : ""}
  </div>

  <p style="font-size:12.5px;color:#8a7c66;margin-top:20px;border-top:1px solid #e4d9c5;padding-top:14px">
    ${esc(settings.email_note || "")}
  </p>
</div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${fromName} <${fromAddr}>`,
      to: [o.to],
      subject,
      html,
    }),
  });

  if (!res.ok) throw new Error("resend " + res.status + " " + (await res.text()));
  return true;
}

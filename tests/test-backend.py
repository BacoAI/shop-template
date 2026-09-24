# -*- coding: utf-8 -*-
import json, urllib.request, urllib.error, urllib.parse, http.cookiejar, datetime, sys

BASE = "http://127.0.0.1:8788"
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def call(method, path, body=None, raw=False):
    # 網址裡可能有中文(搜尋關鍵字),要先編碼
    if "?" in path:
        base, q = path.split("?", 1)
        q = "&".join(
            k + "=" + urllib.parse.quote(v) if "=" in kv else kv
            for kv in q.split("&")
            for k, v in [kv.split("=", 1) if "=" in kv else (kv, "")]
        )
        path = base + "?" + q
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data: req.add_header("Content-Type", "application/json")
    try:
        r = opener.open(req, timeout=20)
        txt = r.read().decode("utf-8", "replace")
        return r.status, (txt if raw else json.loads(txt))
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")
        try: return e.code, json.loads(txt)
        except: return e.code, {"_raw": txt[:300]}

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  ✓ " if cond else "  ✗ ") + name + (("  → " + str(detail)) if detail else ""))

today = datetime.date.today()
d1 = (today + datetime.timedelta(days=4)).isoformat()
d2 = (today + datetime.timedelta(days=6)).isoformat()
d_soon = (today + datetime.timedelta(days=1)).isoformat()

print("\n【1】前台:首頁與商品")
st, r = call("GET", "/api/shop/home")
check("首頁 API 回得來", st == 200 and r.get("ok"), st)
check("營業中", r.get("open") is True)
check("至少有 1 個商品", len(r.get("products", [])) >= 1, [p["name"] for p in r.get("products", [])])

st, r = call("GET", "/api/shop/product?id=1")
check("商品詳情", st == 200 and r["product"]["name"] == "銅鑼燒")
check("帶出可加購品 2 個", len(r.get("addons", [])) == 2)
check("每單上限 6", r["product"]["max_per_order"] == 6)

print("\n【2】後台:登入與強制改密碼")
st, r = call("POST", "/api/admin/login", {"username": "admin", "password": "admin"})
check("用出廠密碼登入", st == 200 and r.get("ok"), r)
check("被標記要改密碼", r.get("must_change_pw") is True)

st, r = call("GET", "/api/admin/products")
check("沒改密碼前擋住其他功能", st == 403 and r.get("error") == "must_change_pw", st)

st, r = call("POST", "/api/admin/change-password", {"old_password": "admin", "new_password": "test1234"})
check("改密碼成功", st == 200 and r.get("ok"), r)

st, r = call("GET", "/api/admin/products")
check("改完就能用了", st == 200 and len(r.get("products", [])) >= 1)

st, r = call("POST", "/api/admin/login", {"username": "admin", "password": "admin"})
check("舊密碼不能再登入", st == 401, st)
st, r = call("POST", "/api/admin/login", {"username": "admin", "password": "test1234"})
check("新密碼可以登入", st == 200 and r.get("ok"))

print("\n【3】後台:設定可出貨日期")
st, r = call("POST", "/api/admin/stock", {"product_id": 1, "days": [{"date": d1, "qty": 10}, {"date": d2, "qty": 3}]})
check("日曆存檔", st == 200 and r.get("ok"), r)
st, r = call("GET", "/api/admin/stock?product_id=1")
check("存進去 2 天", len(r.get("days", [])) == 2, r.get("days"))

print("\n【4】前台:可選哪幾天")
st, r = call("POST", "/api/shop/dates", {"items": [{"id": 1, "qty": 2}]})
check("買 2 個 → 兩天都可選", st == 200 and len(r.get("days", [])) == 2, r.get("days"))
st, r = call("POST", "/api/shop/dates", {"items": [{"id": 1, "qty": 5}]})
days5 = [d["date"] for d in r.get("days", [])]
check("買 5 個 → 只剩量夠的那天", days5 == [d1], days5)

print("\n【5】前台:試算")
st, r = call("POST", "/api/shop/quote", {"items": [{"id": 1, "qty": 2}]})
check("配送判成冷藏(交集裡保存要求最高)", r.get("ship_method") == "cold", r.get("ship_method"))
check("小計 1000", r.get("subtotal") == 1000, r.get("subtotal"))
check("未達冷藏免運門檻 1500 → 收運費 200", r.get("shipFee") == 200 and r.get("amount") == 1200, r)
st, r = call("POST", "/api/shop/quote", {"items": [{"id": 1, "qty": 3}]})
check("買 3 個達 1500 → 免運", r.get("freeShipped") is True and r.get("amount") == 1500, r)
st, r = call("POST", "/api/shop/quote", {"items": [{"id": 1, "qty": 7}]})
check("超過每單上限 6 被擋", st == 400 and r.get("error") == "over_max", r.get("message"))

print("\n【6】前台:下單")
order = {
  "ship_date": d1, "items": [{"id": 1, "qty": 2, "addons": [{"id": 2, "qty": 1}]}],
  "buyer_name": "王繁歌", "buyer_phone": "0912345678", "buyer_email": "test@example.com",
  "buyer_county": "台北市", "buyer_district": "大安區", "buyer_zip": "106", "buyer_address": "測試路 1 號",
  "rcpt_name": "收件人", "rcpt_phone": "0987654321",
  "rcpt_county": "台中市", "rcpt_district": "西屯區", "rcpt_zip": "407", "rcpt_address": "測試路 2 號",
  "last5": "12345", "note": "測試訂單",
}
st, r = call("POST", "/api/shop/order", order)
check("下單成功", st == 200 and r.get("ok"), r)
order_no = r.get("order_no", "")
check("訂單編號格式 YYYYMMDD-NNN", len(order_no) == 12 and order_no[8] == "-", order_no)
check("金額 = 2×500 + 提袋 20 + 運費 200 = 1220", r.get("amount") == 1220, r)

st, r = call("GET", "/api/admin/stock?product_id=1")
sold = {d["ship_date"]: d["qty_sold"] for d in r["days"]}
check("那天已售 +2", sold.get(d1) == 2, sold)

st, r = call("GET", "/api/admin/addons")
bag = [a for a in r["addons"] if a["id"] == 2][0]
check("提袋庫存 100 → 99", bag["stock"] == 99, bag["stock"])

print("\n【7】擋超賣")
o2 = dict(order); o2["ship_date"] = d2; o2["items"] = [{"id": 1, "qty": 3}]
st, r = call("POST", "/api/shop/order", o2)
check("剛好買完 3 個(那天只有 3)", st == 200 and r.get("ok"), r.get("message"))
st, r = call("POST", "/api/shop/order", o2)
check("再買就被擋住", st == 409 and r.get("error") == "no_stock", r.get("message"))

o3 = dict(order); o3["ship_date"] = d_soon
st, r = call("POST", "/api/shop/order", o3)
check("太近的日期被擋(最少提前 3 天)", st == 400 and r.get("error") == "too_soon", r.get("message"))

print("\n【8】後台:訂單系統")
st, r = call("GET", "/api/admin/orders")
check("訂單列表 2 筆", r.get("total") == 2, r.get("total"))
st, r = call("GET", "/api/admin/orders?q=繁歌")
check("搜尋姓名找得到", r.get("total") == 2, r.get("total"))
st, r = call("GET", "/api/admin/orders?pay_status=已付款")
check("篩選已付款 → 0 筆", r.get("total") == 0, r.get("total"))

st, r = call("GET", "/api/admin/orders")
OID = sorted([o["id"] for o in r.get("orders", [])])[0]      # 最早那一筆（清空重跑時 id 不會從 1 開始）
st, r = call("GET", "/api/admin/order?id=%d" % OID)
oid1_items = r.get("items", [])
check("單筆帶明細(1 商品 + 1 加購)", len(oid1_items) == 2, [i["name"] for i in oid1_items])
check("下單那一版有存起來", len(r.get("revisions", [])) == 1, r.get("revisions"))

print("\n【9】後台:改訂單 → 庫存跟著動")
main_item = [i for i in oid1_items if i["kind"] == "product"][0]
st, r = call("POST", "/api/admin/order-save", {"id": OID, "items": [{"id": main_item["id"], "qty": 4}], "pay_status": "已付款"})
check("改數量 2→4 + 標已付款", st == 200 and r.get("ok"), r.get("message"))
st, r = call("GET", "/api/admin/stock?product_id=1")
sold2 = {d["ship_date"]: d["qty_sold"] for d in r["days"]}
check("已售跟著變 2→4", sold2.get(d1) == 4, sold2)

st, r = call("POST", "/api/admin/order-save", {"id": OID, "items": [{"id": main_item["id"], "qty": 99}]})
check("改成超過庫存被擋", st == 409 and r.get("error") == "no_stock", r.get("message"))
st, r = call("GET", "/api/admin/stock?product_id=1")
sold3 = {d["ship_date"]: d["qty_sold"] for d in r["days"]}
check("被擋之後庫存沒被弄髒(還是 4)", sold3.get(d1) == 4, sold3)

print("\n【10】作廢 → 庫存還回去")
st, r = call("POST", "/api/admin/order-save", {"id": OID, "order_status": "已作廢"})
check("標記作廢", st == 200 and r.get("ok"), r.get("message"))
st, r = call("GET", "/api/admin/stock?product_id=1")
sold4 = {d["ship_date"]: d["qty_sold"] for d in r["days"]}
check("那天的已售歸還(4 → 0)", sold4.get(d1) == 0, sold4)

print("\n【11】版本回溯")
st, r = call("GET", "/api/admin/order?id=%d" % OID)
revs = r.get("revisions", [])
check("版本紀錄累積中", len(revs) >= 3, [x["summary"] for x in revs])
first_rev = revs[-1]["id"]
st, r = call("POST", "/api/admin/order-revert", {"id": OID, "revision_id": first_rev})
check("回到最初那一版", st == 200 and r.get("ok"), r.get("message"))
st, r = call("GET", "/api/admin/order?id=%d" % OID)
qty_now = [i for i in r["items"] if i["kind"] == "product"][0]["qty"]
check("數量回到下單時的 2", qty_now == 2, qty_now)

print("\n【12】匯出 CSV")
st, r = call("GET", "/api/admin/export", raw=True)
lines = r.split("\r\n") if isinstance(r, str) else []
check("CSV 下載得到", st == 200 and len(lines) >= 3, len(lines))
check("有 BOM(Excel 開不亂碼)", isinstance(r, str) and r.startswith("﻿"))
check("標題列有中文欄名", isinstance(r, str) and "訂單編號" in lines[0])

print("\n【13】權限:一般帳號碰不到系統管理")
st, r = call("POST", "/api/admin/admin-create", {"username": "helper", "password": "helper123", "role": "normal"})
check("建立一般帳號", st == 200 and r.get("ok"), r)
call("POST", "/api/admin/logout")
st, r = call("POST", "/api/admin/login", {"username": "helper", "password": "helper123"})
check("一般帳號登入", st == 200 and r.get("ok"))
st, r = call("GET", "/api/admin/orders")
check("一般帳號看得到訂單", st == 200 and r.get("ok"))
st, r = call("GET", "/api/admin/admins")
check("一般帳號被擋在系統管理外", st == 403, st)
st, r = call("POST", "/api/admin/admin-delete", {"id": 1})
check("一般帳號不能刪帳號", st == 403, st)

print("\n" + "=" * 46)
print("  PASS %d  /  FAIL %d" % (len(PASS), len(FAIL)))
if FAIL:
    print("  失敗的項目:")
    for f in FAIL: print("    ✗ " + f)
print("=" * 46)
sys.exit(1 if FAIL else 0)

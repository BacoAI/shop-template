-- ═══════════════════════════════════════════════════════════
--  販售系統 v2 — D1 資料表
--  這個檔不用自己跑 —— `npm run deploy` 會自動執行它建好資料表。
--  （用的是 Cloudflare 的 migrations 機制，跑過的會記錄下來，不會重複建。）
--
--  這個檔可以重複執行：所有建表都是 IF NOT EXISTS、
--  所有預設資料都是 INSERT OR IGNORE（已經有的不會被蓋掉）。
--
--  ⚠ v1 的 batch / orders 表不會被動到，就留在資料庫裡。
--    v2 用的是下面這些全新的表。
-- ═══════════════════════════════════════════════════════════


-- ── 1) 商品 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL DEFAULT '',        -- 產品名稱（首頁卡片 + 產品頁大標）
  subtitle      TEXT    NOT NULL DEFAULT '',        -- 副標
  thumb         TEXT    NOT NULL DEFAULT '',        -- 首頁縮圖（KV 的檔名，一張）
  photos        TEXT    NOT NULL DEFAULT '[]',      -- 產品頁照片（JSON 陣列，可多張）
  intro         TEXT    NOT NULL DEFAULT '',        -- 產品介紹文字
  description   TEXT    NOT NULL DEFAULT '',        -- 產品說明（成分、保存、過敏原）
  price         INTEGER NOT NULL DEFAULT 0,         -- 單價
  ship_methods  TEXT    NOT NULL DEFAULT '["normal"]',  -- 可用配送 JSON：normal/cold/frozen
  ship_primary  TEXT    NOT NULL DEFAULT 'normal',  -- 優先配送（買多樣東西時靠它決定整單怎麼寄）
  addon_ids     TEXT    NOT NULL DEFAULT '[]',      -- 這個商品可加購哪些（JSON，存 addons.id）
  max_per_order INTEGER NOT NULL DEFAULT 0,         -- 每張訂單最多買幾個（0 = 不限制）
  sort_order    INTEGER NOT NULL DEFAULT 0,         -- 首頁排序（小的在前）
  status        TEXT    NOT NULL DEFAULT 'on',      -- on 上架 / off 下架
  created_at    TEXT    NOT NULL DEFAULT '',
  updated_at    TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_products_sort ON products (status, sort_order, id);


-- ── 2) 每個商品、每個日期的可出貨量 ★ 擋超賣的核心 ────────
--   沒有這一列 = 那天不出貨。後台日曆上沒設過的日期就是不賣。
CREATE TABLE IF NOT EXISTS product_stock (
  product_id INTEGER NOT NULL,
  ship_date  TEXT    NOT NULL,                      -- 'YYYY-MM-DD'
  qty_total  INTEGER NOT NULL DEFAULT 0,            -- 這天總共可以做幾個
  qty_sold   INTEGER NOT NULL DEFAULT 0,            -- 已經賣掉幾個（擋超賣靠這欄）
  PRIMARY KEY (product_id, ship_date)
);
CREATE INDEX IF NOT EXISTS idx_stock_date ON product_stock (ship_date);


-- ── 3) 加購商品（蠟燭、提袋那類）─────────────────────────
--   庫存是「總量」，不分日期 —— 這種東西是買一批放著，不是每天現做。
CREATE TABLE IF NOT EXISTS addons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL DEFAULT '',
  description TEXT    NOT NULL DEFAULT '',
  price       INTEGER NOT NULL DEFAULT 0,
  photo       TEXT    NOT NULL DEFAULT '',
  stock       INTEGER NOT NULL DEFAULT 0,           -- 剩幾個（0 = 已售完，前台不給選）
  sort_order  INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'on',
  created_at  TEXT    NOT NULL DEFAULT ''
);


-- ── 4) 訂單 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no       TEXT    NOT NULL UNIQUE,           -- 訂單編號 'YYYYMMDD-NNN'
  ship_date      TEXT    NOT NULL DEFAULT '',       -- 出貨日
  ship_method    TEXT    NOT NULL DEFAULT 'normal', -- 本單配送方式

  -- 寄件人（訂購人）
  buyer_name     TEXT    NOT NULL DEFAULT '',
  buyer_phone    TEXT    NOT NULL DEFAULT '',
  buyer_email    TEXT    NOT NULL DEFAULT '',
  buyer_county   TEXT    NOT NULL DEFAULT '',
  buyer_district TEXT    NOT NULL DEFAULT '',
  buyer_zip      TEXT    NOT NULL DEFAULT '',
  buyer_address  TEXT    NOT NULL DEFAULT '',

  -- 收件人
  rcpt_name      TEXT    NOT NULL DEFAULT '',
  rcpt_phone     TEXT    NOT NULL DEFAULT '',
  rcpt_email     TEXT    NOT NULL DEFAULT '',
  rcpt_county    TEXT    NOT NULL DEFAULT '',
  rcpt_district  TEXT    NOT NULL DEFAULT '',
  rcpt_zip       TEXT    NOT NULL DEFAULT '',
  rcpt_address   TEXT    NOT NULL DEFAULT '',

  subtotal       INTEGER NOT NULL DEFAULT 0,        -- 商品小計（含加購）
  ship_fee       INTEGER NOT NULL DEFAULT 0,        -- 實收運費
  amount         INTEGER NOT NULL DEFAULT 0,        -- 總金額
  last5          TEXT    NOT NULL DEFAULT '',       -- 匯款末五碼（必填）
  note           TEXT    NOT NULL DEFAULT '',       -- 客人備註

  pay_status     TEXT    NOT NULL DEFAULT '未付款',  -- 已付款 / 未付款
  order_status   TEXT    NOT NULL DEFAULT '待處理',  -- 待處理 / 已處理 / 已作廢

  created_at     TEXT    NOT NULL DEFAULT '',
  updated_at     TEXT    NOT NULL DEFAULT '',
  deleted_at     TEXT    NOT NULL DEFAULT ''        -- 垃圾桶：空 = 正常
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at);
CREATE INDEX IF NOT EXISTS idx_orders_ship    ON orders (ship_date);
CREATE INDEX IF NOT EXISTS idx_orders_live    ON orders (deleted_at, id);


-- ── 5) 訂單明細 ──────────────────────────────────────────
--   name 與 unit_price 是「下單當時的快照」：
--   之後商品改名或改價，舊訂單長相不變，對帳才對得起來。
CREATE TABLE IF NOT EXISTS order_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL,
  kind           TEXT    NOT NULL DEFAULT 'product',  -- product / addon
  ref_id         INTEGER NOT NULL DEFAULT 0,          -- products.id 或 addons.id
  name           TEXT    NOT NULL DEFAULT '',         -- ★ 當時的名稱
  unit_price     INTEGER NOT NULL DEFAULT 0,          -- ★ 當時的單價
  qty            INTEGER NOT NULL DEFAULT 0,
  parent_item_id INTEGER NOT NULL DEFAULT 0           -- 加購掛在哪個商品下（0 = 整單層級）
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items (order_id);


-- ── 6) 訂單版本紀錄（改錯可以回去）───────────────────────
--   每筆訂單只留最近 20 版，超過的由程式自動刪最舊的。
CREATE TABLE IF NOT EXISTS order_revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL,
  snapshot   TEXT    NOT NULL DEFAULT '{}',         -- 整筆訂單 + 明細的 JSON
  summary    TEXT    NOT NULL DEFAULT '',           -- 例：「金額 1200→1400、狀態 待處理→已處理」
  changed_by TEXT    NOT NULL DEFAULT '',           -- 哪個後台帳號改的
  changed_at TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_rev_order ON order_revisions (order_id, id);


-- ── 7) 運費設定 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shipping (
  method         TEXT    PRIMARY KEY,               -- normal / cold / frozen
  label          TEXT    NOT NULL DEFAULT '',
  fee            INTEGER NOT NULL DEFAULT 0,
  free_threshold INTEGER NOT NULL DEFAULT 0,        -- 0 = 這種配送不提供免運
  rank           INTEGER NOT NULL DEFAULT 0,        -- 保存要求高低（大的優先）★ 混買時靠它決定
  enabled        INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO shipping (method, label, fee, free_threshold, rank, enabled) VALUES
  ('normal', '常溫', 120, 1000, 1, 1),
  ('cold',   '冷藏', 200, 1500, 2, 1),
  ('frozen', '冷凍', 280, 2000, 3, 1);


-- ── 8) 後台帳號 ──────────────────────────────────────────
--   密碼永遠不存明碼，存的是 PBKDF2 雜湊。
--   剛裝好時只有一組 admin / admin。第一次登入時，系統會要店主
--   「設定自己的管理員帳號」—— 連帳號名一起換掉，所以設定完 admin 就不存在了。
--   （pw_hash 是空字串 = 還沒設過 = 只認得出廠密碼 'admin'）
CREATE TABLE IF NOT EXISTS admins (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE,
  pw_hash        TEXT    NOT NULL DEFAULT '',
  pw_salt        TEXT    NOT NULL DEFAULT '',
  role           TEXT    NOT NULL DEFAULT 'normal', -- full 完整 / normal 一般
  must_change_pw INTEGER NOT NULL DEFAULT 0,        -- 1 = 下次登入強制改密碼
  created_at     TEXT    NOT NULL DEFAULT '',
  last_login     TEXT    NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO admins (username, pw_hash, pw_salt, role, must_change_pw, created_at)
  VALUES ('admin', '', '', 'full', 1, '');


-- ── 9) 登入狀態（cookie 對應的 token）────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  admin_id   INTEGER NOT NULL,
  created_at TEXT    NOT NULL DEFAULT '',
  expires_at TEXT    NOT NULL DEFAULT ''            -- 預設 7 天
);
CREATE INDEX IF NOT EXISTS idx_sess_expire ON sessions (expires_at);


-- ── 10) 網站設定（key-value）─────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL DEFAULT ''
);

-- 預設值 = 前台會顯示的那些字。學生照著改就好，不必面對空白表單。
-- 兩個小規則（沿用 v1）：
--   *星號之間的字* 會變粗體
--   {匯款期限} 會自動換成 pay_deadline 的值
INSERT OR IGNORE INTO settings (k, v) VALUES
  -- 網站
  ('site_title',        '銅鑼燒'),
  ('site_subtitle',     'D O R A Y A K I'),
  ('page_title',        '銅鑼燒・訂購'),
  ('footer_text',       '銅鑼燒'),
  ('home_section_title','本店商品'),
  ('hero_photos',       '[]'),                      -- 首頁大圖（KV 檔名陣列）

  -- 營業狀態（取代 v1 的開團/關團）
  ('biz_open',          '1'),                       -- 1 營業中 / 0 暫停接單
  ('closed_notice',     '目前暫停接單,下次開放請鎖定 IG'),

  -- 出貨
  ('lead_days',         '3'),                       -- 最少提前幾天才能選出貨日
  ('ship_remind',       '＊ 全部統一在出貨日寄出,下單即代表你接受此出貨日。'),

  -- 匯款
  ('bank_name',         ''),
  ('bank_account',      ''),
  ('ig_handle',         ''),
  ('pay_deadline',      '2 日內'),
  ('pay_hint',          '① 請先匯款 → ② 填下方後五碼'),
  ('email_note',        '收到你的匯款後,我們會以 Email 通知確認'),
  ('submit_text',       '送 出 訂 單'),
  ('cart_note',         '＊ 全部統一在出貨日寄出,下單即代表你接受此出貨日。
＊ 收到你的匯款後,我們會以 Email 通知確認。'),

  -- 各種狀態頁
  ('closed_title',      '目前暫停接單'),
  ('closed_text',       '下次開放請鎖定 IG'),
  ('soldout_text',      '這個商品目前沒有可訂購的日期'),
  ('error_title',       '暫時無法載入'),
  ('error_text',        '請稍後再試一次'),

  -- 下單成功頁
  ('success_title',     '訂單已成立'),
  ('success_sub',       '謝謝你的訂購～
請於 *{匯款期限}* 完成匯款,逾期名額將釋出。'),
  ('success_note',      '我們會以你填的 *匯款後五碼* 與 Email 核對入帳並通知確認。'),

  -- 通知信（選填：沒設 RESEND_API_KEY 就不寄）
  ('mail_from_name',    '銅鑼燒'),
  ('mail_subject',      '訂單成立通知'),

  -- 訂單系統的顯示欄位與順序（後台可調）
  ('order_columns',     '["created_at","ship_date","order_no","ship_method","buyer_name","rcpt_name","buyer_phone","amount","pay_status","order_status","last5"]');


-- ── 範例資料（第一次安裝時給你一個起點，改成自己的就好）──
INSERT OR IGNORE INTO addons (id, name, description, price, stock, sort_order, status) VALUES
  (1, '生日蠟燭', '數字蠟燭一組', 30, 50, 1, 'on'),
  (2, '提袋',     '牛皮紙提袋',   20, 100, 2, 'on');

INSERT OR IGNORE INTO products
  (id, name, subtitle, intro, description, price, ship_methods, ship_primary, addon_ids, max_per_order, sort_order, status)
VALUES
  (1, '銅鑼燒', 'どら焼き・小豆とマスカルポーネ',
   '蜂蜜餅皮,夾入萬丹紅豆餡與馬斯卡彭,以和三盆糖收尾的溫潤。',
   '保存與品嚐｜請冷藏保存,冷藏品嚐口感最佳。取出後請於 30 分鐘內享用。
成分｜雞蛋、麵粉（小麥）、砂糖、和三盆糖、萬丹紅豆、乳製品、蜂蜜、味醂、膨脹劑、水。
過敏原資訊｜本產品含蛋、牛奶及含麩質之穀物（小麥）;並含蜂蜜。',
   500, '["cold","normal"]', 'cold', '[1,2]', 6, 1, 'on');

-- ⚠ 範例商品沒有預設「可出貨日期」。
--   請進後台 → 商品設定 → 點商品 → 可出貨日期 & 數量，在日曆上點幾天設數量，前台才會出現可選日期。

/**
 * 鍋貼小所｜線上訂單後端（Google Apps Script，綁在試算表上）
 *
 * 功能：
 *  1. doPost：接收網站結帳送來的 JSON，檢查後寫入「訂單」「訂單明細」兩張表，回傳訂單編號。
 *  2. 金額以「商品」表的單價為準重算，前端送來的價格不採信。
 *  3. LockService 上鎖，同時多人下單也不會編號重複或寫錯列。
 *  4. 新訂單 Email 通知、每晚當日彙總 Email（可在「設定」表開關）。
 *  5. 試算表上方選單「鍋貼小所訂單」：初始化、送測試訂單、寄今日彙總。
 *
 * 第一次使用：在編輯器選 setup 執行一次（會要求授權），再部署成網頁應用程式。
 * 不收、不存任何付款卡號。姓名、電話、地址屬個資，試算表請勿公開分享。
 */

const CFG = {
  TZ: 'Asia/Taipei',
  PREFIX: 'GT',
  SHEET_ORDERS: '訂單',
  SHEET_ITEMS: '訂單明細',
  SHEET_PRODUCTS: '商品',
  SHEET_SETTINGS: '設定',
  METHODS: ['內用', '外帶', '宅配'],
  STATUSES: ['新訂單', '已確認', '製作中', '已完成', '已取消'],
  MAX_BODY: 8000,        // 請求內容上限（字元）
  MAX_LINES: 30,         // 一張訂單最多幾種品項
  MAX_QTY: 99,           // 單一品項數量上限
  MAX_NAME: 30,
  MAX_ADDR: 100,
  MAX_NOTE: 200,
  PHONE_LIMIT: 3,        // 同一電話 10 分鐘內最多幾筆
  PHONE_WINDOW: 600,
  HOURLY_LIMIT: 120      // 全站每小時最多幾筆
};

const ORDER_HEADERS = ['訂單編號', '下單時間', '取餐方式', '姓名', '電話', '配送地址', '備註', '件數', '總金額', '狀態', '系統備註'];
const ITEM_HEADERS = ['訂單編號', '下單時間', '商品ID', '品名', '單價', '數量', '小計'];
const PRODUCT_HEADERS = ['商品ID', '品名', '單價', '供應中'];
const SETTING_HEADERS = ['項目', '值', '說明'];

// 與網站 index2.html 的 PRODUCTS、GIFTS 一致；之後改價請直接改「商品」表
const SEED_PRODUCTS = [
  ['p1', '招牌豬肉鍋貼（10 顆）', 85], ['p2', '爆汁鮮肉鍋貼（10 顆）', 95], ['p3', '韭菜鍋貼（10 顆）', 85],
  ['p4', '泡菜起司鍋貼（10 顆）', 105], ['d1', '鮮肉水餃（10 顆）', 80], ['d2', '蝦仁水餃（10 顆）', 110],
  ['d3', '玉米水餃（10 顆）', 85], ['s1', '酸辣湯', 55], ['s2', '玉米濃湯', 45], ['s3', '古早味紅茶', 30],
  ['k1', '涼拌小黃瓜', 40], ['k2', '滷蛋', 20], ['k3', '燙青菜', 45],
  ['g1', '家庭組冷凍鍋貼（30 入）', 350], ['g2', '招財鍋貼禮盒（50 入）', 680]
];

/* ============================ 網頁應用程式入口 ============================ */

function doGet() {
  return json_({ ok: true, service: '鍋貼小所訂單 API', time: now_() });
}

function doPost(e) {
  try {
    return json_(handleOrder_(e));
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, code: 'SERVER', message: '系統忙碌中，請稍後再試一次。' });
  }
}

function handleOrder_(e) {
  const raw = e && e.postData && e.postData.contents || '';
  if (!raw || raw.length > CFG.MAX_BODY) return fail_('BAD_REQUEST', '訂單資料格式不正確。');
  let d;
  try { d = JSON.parse(raw); } catch (_) { return fail_('BAD_REQUEST', '訂單資料格式不正確。'); }
  if (!d || typeof d !== 'object') return fail_('BAD_REQUEST', '訂單資料格式不正確。');

  // 蜜罐：真人看不到這個欄位，有值就是機器人。回假成功、不寫入。
  if (str_(d.website)) return { ok: true, orderNo: CFG.PREFIX + Utilities.formatDate(new Date(), CFG.TZ, 'yyMMdd') + '-000', total: 0 };

  // ---- 欄位檢查 ----
  const method = str_(d.method);
  const name = str_(d.name);
  const phone = str_(d.phone);
  const addr = str_(d.address);
  const note = str_(d.note);
  const reqId = str_(d.requestId);
  if (CFG.METHODS.indexOf(method) < 0) return fail_('VALIDATION', '請選擇取餐方式。');
  if (!name || name.length > CFG.MAX_NAME) return fail_('VALIDATION', '請輸入姓名（' + CFG.MAX_NAME + ' 字以內）。');
  if (!/^[0-9+\-\s]{8,14}$/.test(phone)) return fail_('VALIDATION', '請輸入有效電話（8–12 碼數字）。');
  if (method === '宅配' && !addr) return fail_('VALIDATION', '宅配需填寫配送地址。');
  if (addr.length > CFG.MAX_ADDR) return fail_('VALIDATION', '配送地址請在 ' + CFG.MAX_ADDR + ' 字以內。');
  if (note.length > CFG.MAX_NOTE) return fail_('VALIDATION', '備註請在 ' + CFG.MAX_NOTE + ' 字以內。');
  if (!/^[A-Za-z0-9\-]{8,64}$/.test(reqId)) return fail_('BAD_REQUEST', '訂單資料格式不正確。');
  if (!Array.isArray(d.items) || !d.items.length || d.items.length > CFG.MAX_LINES) return fail_('VALIDATION', '購物車是空的，或品項過多。');

  // ---- 用「商品」表重算金額 ----
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const products = loadProducts_(ss);
  const merged = {};
  for (let i = 0; i < d.items.length; i++) {
    const it = d.items[i] || {};
    const id = str_(it.id);
    const qty = Number(it.qty);
    if (!products[id]) return fail_('VALIDATION', '有品項已停止供應，請重新整理頁面後再下單。');
    if (!(qty >= 1 && qty <= CFG.MAX_QTY && Math.floor(qty) === qty)) return fail_('VALIDATION', '品項數量不正確（每項 1–' + CFG.MAX_QTY + '）。');
    merged[id] = (merged[id] || 0) + qty;
    if (merged[id] > CFG.MAX_QTY) return fail_('VALIDATION', '品項數量不正確（每項 1–' + CFG.MAX_QTY + '）。');
  }
  const lines = Object.keys(merged).map(function (id) {
    const p = products[id];
    return { id: id, name: p.name, price: p.price, qty: merged[id], sub: p.price * merged[id] };
  });
  const count = lines.reduce(function (s, l) { return s + l.qty; }, 0);
  const total = lines.reduce(function (s, l) { return s + l.sub; }, 0);

  // ---- 上鎖後：重複送出檢查、頻率限制、編號、寫入 ----
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return fail_('BUSY', '目前下單人數較多，請稍後再試一次。');
  let orderNo, when;
  try {
    const done = cache.get('req_' + reqId);
    if (done) return { ok: true, orderNo: done, total: total, duplicate: true };   // 同一次送出的重試，不重複建單

    const phoneKey = 'ph_' + phone.replace(/\D/g, '');
    const phoneCnt = Number(cache.get(phoneKey) || 0);
    if (phoneCnt >= CFG.PHONE_LIMIT) return fail_('RATE_LIMIT', '下單太頻繁，請 10 分鐘後再試，或直接來電門市。');
    const hourKey = 'hr_' + Utilities.formatDate(new Date(), CFG.TZ, 'yyMMddHH');
    const hourCnt = Number(cache.get(hourKey) || 0);
    if (hourCnt >= CFG.HOURLY_LIMIT) return fail_('RATE_LIMIT', '目前訂單量過大，請稍後再試，或直接來電門市。');

    const now = new Date();
    when = Utilities.formatDate(now, CFG.TZ, 'yyyy-MM-dd HH:mm:ss');
    orderNo = nextOrderNo_(now);

    const sysNote = (Number(d.clientTotal) === total) ? '' : '前端顯示金額 ' + str_(d.clientTotal) + ' 與系統金額不符，以系統金額為準';
    const shO = ss.getSheetByName(CFG.SHEET_ORDERS);
    const shI = ss.getSheetByName(CFG.SHEET_ITEMS);
    if (!shO || !shI) return fail_('SERVER', '試算表尚未初始化，請店家先執行「初始化」。');
    shO.getRange(shO.getLastRow() + 1, 1, 1, ORDER_HEADERS.length)
      .setValues([[orderNo, when, method, safe_(name), safe_(phone), safe_(addr), safe_(note), count, total, CFG.STATUSES[0], sysNote]]);
    shI.getRange(shI.getLastRow() + 1, 1, lines.length, ITEM_HEADERS.length)
      .setValues(lines.map(function (l) { return [orderNo, when, l.id, l.name, l.price, l.qty, l.sub]; }));
    SpreadsheetApp.flush();

    cache.put('req_' + reqId, orderNo, 21600);
    cache.put(phoneKey, String(phoneCnt + 1), CFG.PHONE_WINDOW);
    cache.put(hourKey, String(hourCnt + 1), 3900);
  } finally {
    lock.releaseLock();
  }

  // 通知信寄失敗不影響訂單
  try { notifyNewOrder_(ss, orderNo, when, method, name, phone, addr, note, lines, total); } catch (err) { console.error('通知信失敗：' + err); }

  return { ok: true, orderNo: orderNo, total: total, count: count };
}

/* ============================ 訂單編號 ============================ */

// GT + 年月日 + 當日流水號，例如 GT261116-001（須在鎖內呼叫）
function nextOrderNo_(now) {
  const day = Utilities.formatDate(now, CFG.TZ, 'yyMMdd');
  const props = PropertiesService.getScriptProperties();
  const key = 'seq_' + day;
  const n = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(n));
  return CFG.PREFIX + day + '-' + ('00' + n).slice(-3);
}

/* ============================ Email ============================ */

function notifyNewOrder_(ss, orderNo, when, method, name, phone, addr, note, lines, total) {
  const st = loadSettings_(ss);
  if (st['新訂單通知'] !== '是' || !st['通知Email']) return;
  if (MailApp.getRemainingDailyQuota() < 1) return;
  const body = [
    '訂單編號：' + orderNo,
    '下單時間：' + when,
    '取餐方式：' + method,
    '姓名：' + name,
    '電話：' + phone,
    addr ? '配送地址：' + addr : '',
    note ? '備註：' + note : '',
    '',
    lines.map(function (l) { return '・' + l.name + ' × ' + l.qty + '　NT$' + l.sub; }).join('\n'),
    '',
    '總金額：NT$' + total,
    '',
    '試算表：' + ss.getUrl()
  ].filter(function (s, i, a) { return s !== '' || a[i - 1] !== ''; }).join('\n');
  MailApp.sendEmail(st['通知Email'], '【鍋貼小所】新訂單 ' + orderNo + '（' + method + '，NT$' + total + '）', body);
}

// 每晚由觸發器執行；也可從選單手動寄
function dailySummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const st = loadSettings_(ss);
  if (st['每日彙總'] !== '是' || !st['通知Email']) return;
  const today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  const orders = rows_(ss.getSheetByName(CFG.SHEET_ORDERS)).filter(function (r) { return String(r[1]).indexOf(today) === 0 && r[9] !== '已取消'; });
  const items = rows_(ss.getSheetByName(CFG.SHEET_ITEMS)).filter(function (r) { return String(r[1]).indexOf(today) === 0; });
  const valid = {};
  orders.forEach(function (r) { valid[r[0]] = true; });
  const byMethod = {}, byItem = {};
  let revenue = 0;
  orders.forEach(function (r) { byMethod[r[2]] = (byMethod[r[2]] || 0) + 1; revenue += Number(r[8]) || 0; });
  items.forEach(function (r) { if (valid[r[0]]) byItem[r[3]] = (byItem[r[3]] || 0) + (Number(r[5]) || 0); });
  const top = Object.keys(byItem).sort(function (a, b) { return byItem[b] - byItem[a]; }).slice(0, 5);
  const body = [
    today + ' 訂單彙總（不含已取消）',
    '',
    '訂單數：' + orders.length + ' 筆',
    '營業額：NT$' + revenue,
    '取餐方式：' + (Object.keys(byMethod).map(function (k) { return k + ' ' + byMethod[k] + ' 筆'; }).join('、') || '—'),
    '',
    '銷量前五：',
    top.length ? top.map(function (k, i) { return (i + 1) + '. ' + k + ' × ' + byItem[k]; }).join('\n') : '（今天沒有訂單）',
    '',
    '試算表：' + ss.getUrl()
  ].join('\n');
  MailApp.sendEmail(st['通知Email'], '【鍋貼小所】' + today + ' 當日彙總：' + orders.length + ' 筆，NT$' + revenue, body);
}

/* ============================ 初始化與選單 ============================ */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('鍋貼小所訂單')
    .addItem('初始化／修復表頭', 'setup')
    .addItem('送一筆測試訂單', 'testOrder')
    .addItem('立即寄出今日彙總', 'dailySummary')
    .addToUi();
}

// 建四張表、表頭、格式、狀態下拉、每晚彙總觸發器。可重複執行，不會清掉既有資料。
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(CFG.TZ);

  const shO = sheet_(ss, CFG.SHEET_ORDERS, ORDER_HEADERS);
  shO.getRange('A:G').setNumberFormat('@');                 // 文字格式：電話開頭的 0 不會被吃掉
  shO.getRange('I:I').setNumberFormat('"NT$"#,##0');
  shO.getRange('J2:J').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(CFG.STATUSES, true).setAllowInvalid(false).build());
  shO.setColumnWidths(1, 2, 150); shO.setColumnWidth(6, 220); shO.setColumnWidth(7, 220); shO.setColumnWidth(11, 260);

  const shI = sheet_(ss, CFG.SHEET_ITEMS, ITEM_HEADERS);
  shI.getRange('A:D').setNumberFormat('@');
  shI.getRange('E:E').setNumberFormat('"NT$"#,##0');
  shI.getRange('G:G').setNumberFormat('"NT$"#,##0');
  shI.setColumnWidths(1, 2, 150); shI.setColumnWidth(4, 220);

  const shP = sheet_(ss, CFG.SHEET_PRODUCTS, PRODUCT_HEADERS);
  if (shP.getLastRow() < 2) {
    shP.getRange(2, 1, SEED_PRODUCTS.length, 4).setValues(SEED_PRODUCTS.map(function (p) { return [p[0], p[1], p[2], '是']; }));
  }
  shP.getRange('C:C').setNumberFormat('"NT$"#,##0');
  shP.getRange('D2:D').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['是', '否'], true).build());
  shP.setColumnWidth(2, 240);

  const shS = sheet_(ss, CFG.SHEET_SETTINGS, SETTING_HEADERS);
  if (shS.getLastRow() < 2) {
    shS.getRange(2, 1, 3, 3).setValues([
      ['通知Email', Session.getEffectiveUser().getEmail(), '新訂單與每日彙總寄到這個信箱；多個信箱用逗號分隔'],
      ['新訂單通知', '是', '填「是」或「否」'],
      ['每日彙總', '是', '填「是」或「否」；每晚 21 點左右寄出']
    ]);
  }
  shS.setColumnWidth(2, 260); shS.setColumnWidth(3, 380);

  const blank = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  ss.setActiveSheet(shO);

  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'dailySummary') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailySummary').timeBased().everyDays(1).atHour(21).inTimezone(CFG.TZ).create();
}

// 不經過網站，直接在後端送一筆測試訂單（檢查寫入與通知信）
function testOrder() {
  const res = handleOrder_({ postData: { contents: JSON.stringify({
    method: '外帶', name: '測試訂單', phone: '0900000000', address: '', note: '後端自我測試，可刪除',
    items: [{ id: 'p1', qty: 2 }, { id: 's1', qty: 1 }], clientTotal: 225,
    requestId: 'selftest-' + Utilities.getUuid(), website: ''
  }) } });
  console.log(JSON.stringify(res));
  try { SpreadsheetApp.getUi().alert(res.ok ? '測試訂單已建立：' + res.orderNo : '失敗：' + res.message); } catch (_) {}
  return res;
}

/* ============================ 小工具 ============================ */

function sheet_(ss, name, headers) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#3b2a20').setFontColor('#fff8ec');
  sh.setFrozenRows(1);
  return sh;
}

function rows_(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getDisplayValues();
}

function loadProducts_(ss) {
  const map = {};
  rows_(ss.getSheetByName(CFG.SHEET_PRODUCTS)).forEach(function (r) {
    const id = String(r[0]).trim();
    const price = Number(String(r[2]).replace(/[^\d.]/g, ''));
    if (id && r[3] !== '否' && price > 0) map[id] = { name: String(r[1]), price: price };
  });
  return map;
}

function loadSettings_(ss) {
  const map = {};
  rows_(ss.getSheetByName(CFG.SHEET_SETTINGS)).forEach(function (r) { map[String(r[0]).trim()] = String(r[1]).trim(); });
  return map;
}

function str_(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }

// 防試算表公式注入：= + - @ 開頭的文字前面加單引號，當純文字存
function safe_(s) { return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; }

function now_() { return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm:ss'); }
function fail_(code, message) { return { ok: false, code: code, message: message }; }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

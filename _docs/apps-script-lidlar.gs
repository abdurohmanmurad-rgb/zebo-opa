/**
 * Zebo doctor — "Lidlar" jadvali (Google Apps Script)
 *
 * Saytdagi har bir anketa shu jadvalga alohida qator bo'lib, ketma-ket ustunlarda tushadi:
 * Sana va vaqt | Ism | Telefon | Manzil | Bola yoshi | Holati | Manba | Kampaniya | Reklama | UTM source | fbclid
 *
 * O'rnatish:
 * 1. Yangi Google Sheets oching (masalan "Zebo — Lidlar").
 * 2. Extensions → Apps Script. Ochilgan oynadagi hamma kodni o'chirib, shu faylni to'liq joylang. Save.
 * 3. Deploy → New deployment → Type: Web app
 *      Execute as: Me
 *      Who has access: Anyone
 *    → Deploy → ruxsat bering (Google "unverified app" desa: Advanced → Go to ... (unsafe) → Allow).
 * 4. Chiqqan "Web app URL" (https://script.google.com/macros/s/.../exec) ni Claude'ga yuboring.
 *
 * Tekshirish: URL'ni brauzerda ochsangiz {"ok":true,"rows":N} chiqadi.
 */

const SHEET_NAME = 'Lidlar';
const TZ = 'Asia/Tashkent';
const HEADERS = ['Sana va vaqt', 'Ism', 'Telefon', 'Manzil', 'Bola yoshi', 'Holati', 'Manba', 'Kampaniya', 'Reklama', 'UTM source', 'fbclid'];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    let d = {};
    try { d = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return out_({ ok: false, error: 'bad_json' }); }

    const phone = String(d.phone || '').replace(/[^\d+]/g, '');
    if (phone.replace(/\D/g, '').length < 9) return out_({ ok: false, error: 'no_phone' });

    const sh = sheet_();
    sh.appendRow([
      Utilities.formatDate(new Date(), TZ, 'dd.MM.yyyy HH:mm:ss'),
      clean_(d.name),
      "'" + phone,               // + belgisi formula bo'lib qolmasligi uchun
      clean_(d.region),
      clean_(d.age),
      clean_(d.topic),
      clean_(d.source),
      clean_(d.utm_campaign),
      clean_(d.utm_content),
      clean_(d.utm_source),
      clean_(d.fbclid)
    ]);
    return out_({ ok: true });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  const sh = sheet_();
  return out_({ ok: true, rows: Math.max(sh.getLastRow() - 1, 0) });
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#ece9fb');
    sh.setFrozenRows(1);
    sh.setColumnWidths(1, HEADERS.length, 160);
  }
  return sh;
}

// Matnni tozalash: uzunlik cheklovi va formula sifatida ishlab ketmasligi (=, +, -, @ bilan boshlansa)
function clean_(v) {
  let s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

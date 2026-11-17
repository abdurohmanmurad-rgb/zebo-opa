// Telegram bot (@zebodoctorstopautizm_bot) — webhook.
//
// Foydalanuvchi uchun:
//   /start → rasm + matn + «Videoni ko'rish» (Mini App) tugmasi
//   ~10 daqiqadan keyin → ovozli xabar (admin o'rnatgan bo'lsa) + «Qo'lga kiritish» tugmasi
//   Chap pastdagi menyu tugmasi → «Ilovani ochish» (sayt Mini App sifatida)
//
// Admin uchun (TG_ADMIN_IDS ro'yxatidagi ID'lar):
//   /admin      — buyruqlar ro'yxati
//   /stats      — obunachilar soni
//   /broadcast  — keyingi yuborgan xabaringizni (matn, rasm, video, ovozli...) hammaga yuborish
//   /setvoice   — 10 daqiqalik eslatmadagi ovozli xabarni o'rnatish
//   /setphoto   — /start rasmini almashtirish
//   /myid       — o'z Telegram ID'ingiz (har kim uchun ishlaydi)
//
// Env (Vercel): TG_BOT_TOKEN, TG_WEBHOOK_SECRET, TG_ADMIN_IDS (vergul bilan), ixtiyoriy TG_WEBAPP_URL
// Redis: KV_REST_API_URL / KV_REST_API_TOKEN (Upstash)
// Bir martalik sozlash: GET /api/tg?setup=<TG_WEBHOOK_SECRET>
// Kechiktirilgan xabarlar: har bir webhook so'rovida va GET /api/tg?tick=<secret> da yuboriladi.

const FOLLOWUP_MIN = 10;
const DEFAULT_PHOTO = "https://i.ytimg.com/vi/TfvFOfiNyFE/maxresdefault.jpg";
const VIDEO_URL = "https://youtu.be/TfvFOfiNyFE";
const BROADCAST_RATE_MS = 40; // ~25 xabar/soniya (Telegram limiti 30)
const BROADCAST_BUDGET_MS = 240000; // bitta chaqiruvda ~4 daqiqa

// Matnlar eski bot (ChatPlace) dan so'zma-so'z. O'zgartirilgan 3 joy: «уни даволаш», «уй шароитида ташхис»,
// «давоси борлиги ҳақидаги методика» — tibbiy da'vo. Admin /setstart va /setfu bilan o'z matnini qo'yishi mumkin.
const TEXT_START =
  "<b>“Аутизмни 10 та белгиси” бўйича бепул видео дарслик</b>\n\n" +
  "<i>Шу ҳавола орқали бепул видеони кўришингиз мумкин</i> 👇👇👇 <i>:</i>\n" +
  VIDEO_URL + "\n" + VIDEO_URL + "\n" + VIDEO_URL + "\n\n\n" +
  "Ушбу видеони кўрганингиздан сўнг:\n" +
  "- Фарзандингизни олдингидан яхшироқ тушунишни бошлайсиз\n\n" +
  "- Аутизм ва РАС ни фарқлашни билиб оласиз\n\n" +
  "- Аутизм ва соғлом бола ўртасидаги фарқларни билиб оласиз\n\n" +
  "- Фарзандингизда аутизм бор-йўқлигини кўрсатувчи 10 та белгини билиб оласиз\n\n" +
  "- Болангизни нутқий ривожланишдан ортда қолишини олдини оладиган қўлланмага эга бўласиз\n\n" +
  "- Агар фарзандингизда аутизм белгилари бўлса, нима қилиш кераклигини билиб оласиз\n\n" +
  "- Энг асосийси, фарзандингиз ривожланишини қўллаб-қувватлаш методикасини билиб оласиз\n\n" +
  "Ёқимли томоша!";

const TEXT_FOLLOWUP =
  "⏰ P.s Ушбу ҳавола, 24 соат амал қилади.\n" +
  "Кўриш учун пастдаги \"<b>Қўлга киритиш</b>\" тугмасини босинг! 👇";

const BTN_VIDEO = "Видеони кўриш";
const BTN_FU = "Қўлга киритиш";

const TEXT_OTHER =
  "Videoni ko'rish va konsultatsiyaga yozilish uchun pastdagi tugmani bosing 👇\n" +
  "Savollar bo'lsa — administrator: @dr_zebo_admin";

const TEXT_ADMIN =
  "<b>Admin buyruqlari</b>\n\n" +
  "/stats — obunachilar soni\n" +
  "/broadcast — hammaga xabar yuborish\n" +
  "/setvoice — eslatmadagi ovozli xabarni o'rnatish\n" +
  "/setphoto — /start rasmini almashtirish\n" +
  "/setstart — START xabarini to'liq almashtirish (rasm + matn)\n" +
  "/setfu — 10 daqiqalik eslatma matnini almashtirish\n" +
  "/resettext — standart matnlarga qaytarish\n" +
  "/cancel — joriy amalni bekor qilish\n\n" +
  "<b>Lidlar</b>\n" +
  "Saytdagi har bir ariza shu chatga keladi.\n" +
  "Guruhga ham tushishi uchun: botni guruhga qo'shing va guruhda /ulash yozing (uzish: /uzish).\n" +
  "/lidlar — jami lidlar va ulangan guruhlar";

// ---------- yordamchilar ----------

function webAppUrl(host, src) {
  const base = process.env.TG_WEBAPP_URL || "https://" + host + "/c-variant";
  return base + (base.indexOf("?") < 0 ? "?" : "&") + "src=" + src;
}

async function tg(method, payload) {
  const r = await fetch("https://api.telegram.org/bot" + process.env.TG_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });
  const data = await r.json().catch(() => ({ ok: false, description: "bad_json" }));
  if (!data.ok) {
    const e = new Error(method + ": " + (data.description || r.status));
    e.code = data.error_code;
    e.retryAfter = data.parameters && data.parameters.retry_after;
    throw e;
  }
  return data.result;
}

async function redis(cmds) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("redis_not_configured");
  const r = await fetch(url.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
    signal: AbortSignal.timeout(8000)
  });
  const data = await r.json();
  if (!r.ok || !Array.isArray(data)) throw new Error("redis_error");
  return data.map((d) => (d ? d.result : null));
}

const isAdmin = (id) => String(process.env.TG_ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean).indexOf(String(id)) >= 0;
const btn = (text, url) => ({ inline_keyboard: [[{ text: text, web_app: { url: url } }]] });
const linkBtn = (text, url) => ({ inline_keyboard: [[{ text: text, url: url }]] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- foydalanuvchi oqimi ----------

async function onStart(msg, host) {
  const chat = msg.chat.id;
  const payload = (msg.text || "").split(" ")[1] || "";
  const [cfg, startSrc] = await redis([
    ["HGET", "tg:cfg", "photo"],
    ["HGET", "tg:cfg", "start_src"],
    ["SADD", "tg:subs", String(chat)],
    ["HSET", "tg:user:" + chat, "name", (msg.from && msg.from.first_name) || "", "username", (msg.from && msg.from.username) || "", "src", payload.slice(0, 64), "started", String(Date.now())],
    ["ZADD", "tg:fu", String(Date.now() + FOLLOWUP_MIN * 60000), String(chat)],
    ["HINCRBY", "zst:v1:" + new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10), "c:tg_start", 1]
  ]);
  if (startSrc) {
    const [fc, mid] = startSrc.split(":");
    try { await tg("copyMessage", { chat_id: chat, from_chat_id: fc, message_id: Number(mid), reply_markup: linkBtn(BTN_VIDEO, VIDEO_URL) }); return; }
    catch (_) { /* manba o'chirilgan bo'lsa — standart xabar */ }
  }
  await tg("sendPhoto", {
    chat_id: chat,
    photo: cfg || DEFAULT_PHOTO,
    caption: TEXT_START,
    parse_mode: "HTML",
    reply_markup: linkBtn(BTN_VIDEO, VIDEO_URL)
  });
}

async function sendFollowup(chat, host, voice, fuSrc) {
  await tg("sendVoice", { chat_id: chat, voice: voice || "https://" + host + "/media/bot-voice.ogg" }).catch(() => {});
  if (fuSrc) {
    const [fc, mid] = fuSrc.split(":");
    try { await tg("copyMessage", { chat_id: chat, from_chat_id: fc, message_id: Number(mid), reply_markup: btn(BTN_FU, webAppUrl(host, "tg-fu")) }); return; }
    catch (_) {}
  }
  await tg("sendMessage", {
    chat_id: chat,
    text: TEXT_FOLLOWUP,
    parse_mode: "HTML",
    reply_markup: btn(BTN_FU, webAppUrl(host, "tg-fu"))
  });
}

// Vaqti kelgan eslatmalarni yuborish (har bir chaqiruvda ko'pi bilan 25 ta)
async function tick(host) {
  const now = Date.now();
  const [due, voice, fuSrc] = await redis([
    ["ZRANGEBYSCORE", "tg:fu", "0", String(now), "LIMIT", "0", "25"],
    ["HGET", "tg:cfg", "voice"],
    ["HGET", "tg:cfg", "fu_src"]
  ]);
  if (!due || !due.length) return 0;
  // Avval navbatdan olib tashlaymiz — ikki marta yuborilmasin
  const removed = await redis(due.map((id) => ["ZREM", "tg:fu", id]));
  let n = 0;
  for (let i = 0; i < due.length; i++) {
    if (!removed[i]) continue;
    try { await sendFollowup(due[i], host, voice, fuSrc); n++; }
    catch (e) { if (e.code === 403) await redis([["SREM", "tg:subs", due[i]]]).catch(() => {}); }
  }
  return n;
}

// ---------- admin: broadcast ----------

// "Tugma matni - https://havola" qatorlari → inline keyboard. Sayt havolasi Telegram ichida ochiladi.
function parseButtons(text, host) {
  const rows = [];
  String(text || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 6).forEach((line) => {
    const m = line.match(/^(.+?)\s*[-–—|]\s*(https?:\/\/\S+|t\.me\/\S+|@\w+)$/i);
    if (!m) return;
    let url = m[2];
    if (/^@/.test(url)) url = "https://t.me/" + url.slice(1);
    if (/^t\.me\//i.test(url)) url = "https://" + url;
    const label = m[1].slice(0, 60);
    const own = url.indexOf("https://" + host + "/") === 0;
    rows.push([own ? { text: label, web_app: { url: url } } : { text: label, url: url }]);
  });
  return rows;
}

async function previewBroadcast(chat, job) {
  const [info, subs] = await redis([["HGETALL", "tg:bc:" + job], ["SCARD", "tg:subs"]]);
  const h = {};
  for (let i = 0; info && i < info.length; i += 2) h[info[i]] = info[i + 1];
  if (!h.from_chat) return;
  const kb = h.buttons ? JSON.parse(h.buttons) : null;
  await tg("sendMessage", { chat_id: chat, text: "👇 <b>Obunachilar shunday ko'radi:</b>", parse_mode: "HTML" });
  await tg("copyMessage", { chat_id: chat, from_chat_id: h.from_chat, message_id: Number(h.msg_id), reply_markup: kb && kb.length ? { inline_keyboard: kb } : undefined });
  await tg("sendMessage", {
    chat_id: chat,
    text: "Shu xabarni <b>" + subs + "</b> ta obunachiga yuboraymi?" + (kb && kb.length ? "\nTugmalar: " + kb.length + " ta" : "\nTugmasiz"),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "✅ Ha, hammaga yuborish", callback_data: "bc_go:" + job }],
      [{ text: kb && kb.length ? "✏️ Tugmani o'zgartirish" : "➕ Tugma qo'shish", callback_data: "bc_btn:" + job }],
      [{ text: "❌ Bekor qilish", callback_data: "bc_no:" + job }]
    ] }
  });
}

async function runBroadcast(job, host) {
  const key = "tg:bc:" + job;
  const [info] = await redis([["HGETALL", key]]);
  const h = {};
  for (let i = 0; info && i < info.length; i += 2) h[info[i]] = info[i + 1];
  if (!h.from_chat) return { error: "job_not_found" };
  if (h.status === "done") return h;
  // Qulf: Telegram webhook'ni qayta yuborsa ham, broadcast ikki marta ketmasin
  const [lock] = await redis([["SET", key + ":lock", "1", "NX", "EX", "300"]]);
  if (lock !== "OK") return { error: "already_running" };
  await redis([["HSET", key, "status", "running"]]);

  const kb = h.buttons ? JSON.parse(h.buttons) : null;
  const markup = kb && kb.length ? { inline_keyboard: kb } : undefined;
  const started = Date.now();
  let cursor = h.cursor || "0", sent = Number(h.sent || 0), failed = Number(h.failed || 0), blocked = Number(h.blocked || 0);
  do {
    const [res] = await redis([["SSCAN", "tg:subs", cursor, "COUNT", "200"]]);
    cursor = res[0];
    for (const id of res[1]) {
      try {
        await tg("copyMessage", { chat_id: id, from_chat_id: h.from_chat, message_id: Number(h.msg_id), reply_markup: markup });
        sent++;
      } catch (e) {
        if (e.retryAfter) { await sleep(e.retryAfter * 1000); try { await tg("copyMessage", { chat_id: id, from_chat_id: h.from_chat, message_id: Number(h.msg_id), reply_markup: markup }); sent++; } catch (_) { failed++; } }
        else if (e.code === 403) { blocked++; await redis([["SREM", "tg:subs", id]]).catch(() => {}); }
        else failed++;
      }
      await sleep(BROADCAST_RATE_MS);
    }
    await redis([["HSET", key, "cursor", cursor, "sent", String(sent), "failed", String(failed), "blocked", String(blocked)]]);
  } while (cursor !== "0" && Date.now() - started < BROADCAST_BUDGET_MS);

  const done = cursor === "0";
  await redis([["HSET", key, "status", done ? "done" : "paused"], ["EXPIRE", key, String(7 * 86400)], ["DEL", key + ":lock"]]);
  const text = (done ? "✅ <b>Yuborish tugadi</b>" : "⏸ <b>Vaqt limiti — davom ettirish kerak</b>") +
    "\nYetkazildi: " + sent + "\nBotni bloklagan: " + blocked + "\nXato: " + failed;
  await tg("sendMessage", {
    chat_id: h.admin, text: text, parse_mode: "HTML",
    reply_markup: done ? undefined : { inline_keyboard: [[{ text: "▶️ Davom ettirish", callback_data: "bc_go:" + job }]] }
  }).catch(() => {});
  return { sent, failed, blocked, done };
}

async function onAdmin(msg, host) {
  const chat = msg.chat.id, text = msg.text || "";
  const stateKey = "tg:admin:" + chat + ":state";
  const [state] = await redis([["GET", stateKey]]);

  if (/^\/cancel/.test(text)) { await redis([["DEL", stateKey]]); await tg("sendMessage", { chat_id: chat, text: "Bekor qilindi." }); return true; }
  if (/^\/admin/.test(text)) { await tg("sendMessage", { chat_id: chat, text: TEXT_ADMIN, parse_mode: "HTML" }); return true; }
  if (/^\/stats/.test(text)) {
    const [subs, fu] = await redis([["SCARD", "tg:subs"], ["ZCARD", "tg:fu"]]);
    await tg("sendMessage", { chat_id: chat, text: "👥 Obunachilar: <b>" + subs + "</b>\n⏳ Eslatma kutayotganlar: " + fu, parse_mode: "HTML" });
    return true;
  }
  if (/^\/lidlar/.test(text)) {
    const [no, groups] = await redis([["GET", "tg:leadno"], ["SMEMBERS", "tg:leadchats"]]);
    await tg("sendMessage", { chat_id: chat, text: "📋 Jami lidlar (bot orqali): <b>" + (no || 0) + "</b>\n👥 Ulangan guruhlar: " + ((groups || []).length ? groups.join(", ") : "yo'q — guruhda /ulash yozing"), parse_mode: "HTML" });
    return true;
  }
  if (/^\/broadcast/.test(text)) {
    await redis([["SET", stateKey, "broadcast", "EX", "1800"]]);
    await tg("sendMessage", { chat_id: chat, text: "Hammaga yuboriladigan xabarni yuboring: matn, rasm, video, dumaloq video, ovozli yoki forward.\nKeyingi qadamda tugma qo'shish-qo'shmaslikni so'rayman.\n\nBekor qilish: /cancel" });
    return true;
  }
  if (/^\/setvoice/.test(text)) {
    await redis([["SET", stateKey, "voice", "EX", "1800"]]);
    await tg("sendMessage", { chat_id: chat, text: "Eslatmada yuboriladigan ovozli xabarni yozib yuboring. O'chirish uchun: /delvoice" });
    return true;
  }
  if (/^\/delvoice/.test(text)) { await redis([["HDEL", "tg:cfg", "voice"]]); await tg("sendMessage", { chat_id: chat, text: "Ovozli xabar o'chirildi." }); return true; }
  if (/^\/setstart/.test(text)) {
    await redis([["SET", stateKey, "start", "EX", "1800"]]);
    await tg("sendMessage", { chat_id: chat, text: "START bosilganda yuboriladigan xabarni aynan qanday bo'lsa shunday yuboring (rasm + izoh yoki matn). Tugma o'zi qo'shiladi.\n\nMuhim: bu xabarni chatdan o'chirmang — bot undan nusxa oladi." });
    return true;
  }
  if (/^\/setfu/.test(text)) {
    await redis([["SET", stateKey, "fu", "EX", "1800"]]);
    await tg("sendMessage", { chat_id: chat, text: "Eslatma xabarini yuboring (ovozli xabardan keyin keladi). Tugma o'zi qo'shiladi.\n\nMuhim: bu xabarni chatdan o'chirmang." });
    return true;
  }
  if (/^\/resettext/.test(text)) {
    await redis([["HDEL", "tg:cfg", "start_src", "fu_src"]]);
    await tg("sendMessage", { chat_id: chat, text: "Standart matnlar qaytarildi." });
    return true;
  }
  if (/^\/setphoto/.test(text)) {
    await redis([["SET", stateKey, "photo", "EX", "1800"]]);
    await tg("sendMessage", { chat_id: chat, text: "/start xabaridagi yangi rasmni yuboring." });
    return true;
  }

  if (state === "voice" && msg.voice) {
    await redis([["HSET", "tg:cfg", "voice", msg.voice.file_id], ["DEL", stateKey]]);
    await tg("sendMessage", { chat_id: chat, text: "✅ Ovozli xabar saqlandi. Endi har bir yangi obunachiga " + FOLLOWUP_MIN + " daqiqadan keyin yuboriladi." });
    return true;
  }
  if ((state === "start" || state === "fu") && !/^\//.test(text)) {
    await redis([["HSET", "tg:cfg", state === "start" ? "start_src" : "fu_src", chat + ":" + msg.message_id], ["DEL", stateKey]]);
    await tg("sendMessage", { chat_id: chat, text: "✅ Saqlandi. Tekshirish uchun /start bosing." });
    return true;
  }
  if (state === "photo" && msg.photo && msg.photo.length) {
    await redis([["HSET", "tg:cfg", "photo", msg.photo[msg.photo.length - 1].file_id], ["DEL", stateKey]]);
    await tg("sendMessage", { chat_id: chat, text: "✅ Rasm saqlandi." });
    return true;
  }
  if (state === "broadcast" && !/^\//.test(text)) {
    const job = Date.now().toString(36);
    await redis([
      ["HSET", "tg:bc:" + job, "from_chat", String(chat), "msg_id", String(msg.message_id), "admin", String(chat), "status", "new"],
      ["EXPIRE", "tg:bc:" + job, String(7 * 86400)],
      ["DEL", stateKey]
    ]);
    await tg("sendMessage", {
      chat_id: chat, reply_to_message_id: msg.message_id,
      text: "Xabar qabul qilindi. Unga tugma qo'shasizmi?",
      reply_markup: { inline_keyboard: [
        [{ text: "➕ Tugma qo'shish", callback_data: "bc_btn:" + job }],
        [{ text: "➡️ Tugmasiz davom etish", callback_data: "bc_pre:" + job }],
        [{ text: "❌ Bekor qilish", callback_data: "bc_no:" + job }]
      ] }
    });
    return true;
  }
  if (state && state.indexOf("bcbtn:") === 0 && !/^\//.test(text)) {
    const job = state.slice(6);
    const rows = parseButtons(text, host);
    if (!rows.length) {
      await tg("sendMessage", { chat_id: chat, text: "Tugma topilmadi. Formatni tekshiring:\n\nTugma matni - https://havola\n\nMasalan:\nKonsultatsiyaga yozilish - https://zebo-opa.vercel.app/c-variant\nAdmin bilan bog'lanish - https://t.me/dr_zebo_admin" });
      return true;
    }
    await redis([["HSET", "tg:bc:" + job, "buttons", JSON.stringify(rows)], ["DEL", stateKey]]);
    await previewBroadcast(chat, job);
    return true;
  }
  return false;
}

// ---------- handler ----------

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const token = process.env.TG_BOT_TOKEN;
  const secret = process.env.TG_WEBHOOK_SECRET;
  if (!token || !secret) return res.status(503).json({ error: "not_configured" });
  const host = req.headers.host;

  if (req.method === "GET") {
    const q = req.query || {};
    if (q.tick === secret) {
      try { return res.status(200).json({ ok: true, sent: await tick(host) }); }
      catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
    }
    if (q.setup !== secret) return res.status(404).json({ error: "not_found" });
    try {
      await tg("setWebhook", {
        url: "https://" + host + "/api/tg",
        secret_token: secret,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true
      });
      await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Ilovani ochish", web_app: { url: webAppUrl(host, "tg-menu") } } });
      await tg("setMyCommands", { commands: [{ command: "start", description: "Бепул видео дарслик" }] });
      await tg("setMyDescription", {
        description: "Ассалому алайкум, бу Зебинисо Ядгарованинг ёрдамчи боти 😊\n\nБу бот орқали “Аутизмнинг 10 та белгисини аниқлаш” бўйича БЕПУЛ видео дарсликни олишингиз мумкин.\n\nҚуйидаги “START” тугмасини босинг 👇👇👇"
      });
      await tg("setMyShortDescription", { short_description: "" });
      const me = await tg("getMe", {});
      return res.status(200).json({ ok: true, bot: "@" + me.username, webhook: "https://" + host + "/api/tg" });
    } catch (e) {
      return res.status(502).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "method_not_allowed" }); }
  if (req.headers["x-telegram-bot-api-secret-token"] !== secret) return res.status(403).json({ error: "forbidden" });

  let update;
  try { update = typeof req.body === "string" ? JSON.parse(req.body) : req.body; }
  catch (_) { return res.status(200).json({ ok: true }); }

  try {
    // Admin tugmalari (broadcast tasdiqlash)
    const cq = update && update.callback_query;
    if (cq) {
      const [act, job] = String(cq.data || "").split(":");
      await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
      if (!isAdmin(cq.from.id)) return res.status(200).json({ ok: true });
      if (act === "bc_btn") {
        await redis([["SET", "tg:admin:" + cq.message.chat.id + ":state", "bcbtn:" + job, "EX", "1800"]]);
        await tg("sendMessage", { chat_id: cq.message.chat.id, text: "Tugmalarni shu formatda yozing (har bir qator — bitta tugma, 6 tagacha):\n\nTugma matni - https://havola\n\nMasalan:\nKonsultatsiyaga yozilish - https://zebo-opa.vercel.app/c-variant\nVideoni ko'rish - https://youtu.be/TfvFOfiNyFE\nAdmin bilan bog'lanish - @dr_zebo_admin\n\nSayt havolasi Telegram ichida ochiladi. Bekor qilish: /cancel" });
      } else if (act === "bc_pre") {
        await previewBroadcast(cq.message.chat.id, job);
      } else if (act === "bc_no") {
        await tg("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: "❌ Bekor qilindi." }).catch(() => {});
      } else if (act === "bc_go") {
        await tg("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: "🚀 Yuborilmoqda... Tugagach xabar beraman." }).catch(() => {});
        await runBroadcast(job, host);
      }
      return res.status(200).json({ ok: true });
    }

    const msg = update && update.message;
    // Guruh: admin /ulash yozsa — lidlar shu guruhga ham tushadi
    if (msg && msg.chat && (msg.chat.type === "group" || msg.chat.type === "supergroup") && typeof msg.text === "string") {
      const cmd = (msg.text.match(/^\/(ulash|uzish)(@\w+)?\b/) || [])[1];
      if (cmd && msg.from && isAdmin(msg.from.id)) {
        await redis([[cmd === "ulash" ? "SADD" : "SREM", "tg:leadchats", String(msg.chat.id)]]);
        await tg("sendMessage", { chat_id: msg.chat.id, text: cmd === "ulash" ? "✅ Guruh ulandi. Saytdagi har bir yangi lid shu yerga tushadi." : "Guruh uzildi. Endi lidlar bu yerga kelmaydi." });
      } else if (cmd) {
        await tg("sendMessage", { chat_id: msg.chat.id, text: "Bu buyruq faqat bot admini uchun." });
      }
    }
    if (msg && msg.migrate_to_chat_id) { // oddiy guruh supergruppaga aylandi
      await redis([["SREM", "tg:leadchats", String(msg.chat.id)]]).then((r) => r[0] ? redis([["SADD", "tg:leadchats", String(msg.migrate_to_chat_id)]]) : null);
    }
    if (msg && msg.chat && msg.chat.type === "private") {
      const text = typeof msg.text === "string" ? msg.text : "";
      if (/^\/myid/.test(text)) {
        await tg("sendMessage", { chat_id: msg.chat.id, text: "Sizning Telegram ID: <code>" + msg.from.id + "</code>", parse_mode: "HTML" });
      } else if (isAdmin(msg.from.id) && (await onAdmin(msg, host))) {
        // admin buyrug'i bajarildi
      } else if (/^\/start/.test(text)) {
        await onStart(msg, host);
      } else {
        await tg("sendMessage", { chat_id: msg.chat.id, text: TEXT_OTHER, reply_markup: linkBtn(BTN_VIDEO, VIDEO_URL) });
      }
    }
  } catch (e) {
    console.error("tg update failed", e);
  }

  // Har bir so'rovda vaqti kelgan eslatmalarni ham yuboramiz
  try { await tick(host); } catch (_) {}
  // Telegram qayta yubormasligi uchun har doim 200
  return res.status(200).json({ ok: true });
};

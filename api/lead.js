// Saytdan kelgan lidni Telegram botga yuborish: adminlarning shaxsiy chatiga + ulangan guruhlarga.
//
// POST /api/lead   body (JSON yoki text/plain): {name, phone, region, age, topic, source, utm_source, utm_campaign, utm_content, ...}
// Guruh ulash: botni guruhga qo'shing va guruhda admin /ulash yozsin (tg.js). Uzish: /uzish.
//
// Redis: tg:leadchats (guruhlar), tg:leadno (tartib raqam), tg:leads (oxirgi 5000 lid, JSON), tg:leadrl:<ip> (spam limit)
// Env: TG_BOT_TOKEN, TG_ADMIN_IDS, KV_REST_API_URL / KV_REST_API_TOKEN
// Meta Conversions API (ixtiyoriy): META_CAPI_TOKEN (Events Manager → dataset → Settings → Generate access token),
//   META_PIXEL_ID (standart 862190763626893), META_TEST_EVENT_CODE (bo'lsa — faqat "Test events" oynasiga boradi)
const crypto = require("crypto");
const sha = (v) => crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex");

// Lead'ni serverdan Meta'ga yuborish. Brauzer bilan bir xil event_id → Meta ikkalasini bitta hisoblaydi.
async function sendCapi(lead, b, req) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token) return { skipped: "no_token" };
  const pixel = process.env.META_PIXEL_ID || "862190763626893";
  const digits = lead.phone.replace(/\D/g, "");
  const ud = {
    ph: [sha(digits)],
    fn: [sha(lead.name.split(" ")[0])],
    country: [sha("uz")],
    client_ip_address: String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || undefined,
    client_user_agent: String(req.headers["user-agent"] || "").slice(0, 400) || undefined
  };
  if (typeof b.fbp === "string" && /^fb\.\d\.\d+\.\d+$/.test(b.fbp)) ud.fbp = b.fbp;
  if (typeof b.fbc === "string" && /^fb\.\d\.\d+\.[\w-]+$/.test(b.fbc)) ud.fbc = b.fbc.slice(0, 500);
  const body = {
    data: [{
      event_name: "Lead",
      event_time: Math.floor(Date.now() / 1000),
      event_id: typeof b.event_id === "string" ? b.event_id.slice(0, 80) : undefined,
      action_source: "website",
      event_source_url: "https://" + req.headers.host + "/c-variant",
      user_data: ud,
      custom_data: { content_name: "konsultatsiya" }
    }]
  };
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;
  try {
    const r = await fetch("https://graph.facebook.com/v25.0/" + pixel + "/events?access_token=" + encodeURIComponent(token), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000)
    });
    const data = await r.json().catch(() => ({}));
    const res = { status: r.status, received: data.events_received, messages: data.messages, error: data.error && data.error.message, fbtrace: data.fbtrace_id };
    await redis([["LPUSH", "capi:log", JSON.stringify({ at: new Date().toISOString(), test: !!body.test_event_code, ...res })], ["LTRIM", "capi:log", "0", "49"]]).catch(() => {});
    return res;
  } catch (e) {
    return { error: String(e.message || e) };
  }
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

async function tg(method, payload) {
  const r = await fetch("https://api.telegram.org/bot" + process.env.TG_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000)
  });
  const data = await r.json().catch(() => ({ ok: false }));
  if (!data.ok) {
    const e = new Error(method + ": " + (data.description || r.status));
    e.code = data.error_code;
    e.migrate = data.parameters && data.parameters.migrate_to_chat_id;
    throw e;
  }
  return data.result;
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const clip = (s, n) => String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").trim().slice(0, n);

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "method_not_allowed" }); }
  if (req.headers.origin && req.headers.origin !== "https://" + req.headers.host) return res.status(403).json({ error: "forbidden" });
  if (!process.env.TG_BOT_TOKEN) return res.status(503).json({ error: "not_configured" });

  let b;
  try { b = typeof req.body === "string" ? JSON.parse(req.body) : req.body; }
  catch (_) { return res.status(400).json({ error: "invalid_body" }); }
  if (!b || typeof b !== "object") return res.status(400).json({ error: "invalid_body" });

  const name = clip(b.name, 60);
  const digits = String(b.phone || "").replace(/\D/g, "");
  if (name.length < 2 || digits.length < 11 || digits.length > 13) return res.status(400).json({ error: "invalid_lead" });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x";
  const now = new Date(Date.now() + 5 * 3600000); // Toshkent vaqti
  const when = now.toISOString().slice(0, 16).replace("T", " ");
  const lead = {
    name, phone: "+" + digits,
    region: clip(b.region, 80), age: clip(b.age, 40), topic: clip(b.topic, 300),
    source: clip(b.source, 30), utm_source: clip(b.utm_source, 60), utm_campaign: clip(b.utm_campaign, 120), utm_content: clip(b.utm_content, 120),
    at: when
  };

  let no, chats;
  try {
    const out = await redis([
      ["INCR", "tg:leadrl:" + ip], ["EXPIRE", "tg:leadrl:" + ip, "600"],
      ["SET", "tg:leaddup:" + digits, "1", "EX", "120", "NX"],
      ["SMEMBERS", "tg:leadchats"]
    ]);
    if (out[0] > 8) return res.status(429).json({ error: "too_many" });
    if (out[2] !== "OK") return res.status(200).json({ ok: true, dup: true }); // 2 daqiqa ichida bir xil raqam — qayta yubormaymiz
    chats = out[3] || [];
    [no] = await redis([["INCR", "tg:leadno"], ["LPUSH", "tg:leads", JSON.stringify(lead)], ["LTRIM", "tg:leads", "0", "4999"]]);
  } catch (_) {
    return res.status(503).json({ error: "temporarily_unavailable" });
  }

  const src = [lead.utm_source, lead.utm_campaign, lead.utm_content].filter(Boolean).join(" / ");
  const text =
    "🆕 <b>Yangi lid #" + no + "</b>\n\n" +
    "👤 <b>Ism:</b> " + esc(lead.name) + "\n" +
    "📞 <b>Telefon:</b> " + esc(lead.phone) + "\n" +
    "📍 <b>Manzil:</b> " + esc(lead.region || "—") + "\n" +
    "👶 <b>Bola yoshi:</b> " + esc(lead.age || "—") + "\n" +
    "🩺 <b>Holati:</b> " + esc(lead.topic || "—") + "\n" +
    "📣 <b>Manba:</b> " + esc(src || lead.source || "to'g'ridan-to'g'ri") + "\n" +
    "🕒 " + esc(when);

  const admins = String(process.env.TG_ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const targets = Array.from(new Set(admins.concat(chats)));
  const results = await Promise.all(targets.map(async (chat) => {
    try { await tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML" }); return 1; }
    catch (e) {
      if (e.migrate) { // guruh supergruppaga aylangan — yangi ID bilan qayta yuboramiz
        await redis([["SREM", "tg:leadchats", chat], ["SADD", "tg:leadchats", String(e.migrate)]]).catch(() => {});
        try { await tg("sendMessage", { chat_id: e.migrate, text, parse_mode: "HTML" }); return 1; } catch (_) {}
      } else if (e.code === 403 && chats.indexOf(chat) >= 0) { // bot guruhdan chiqarilgan
        await redis([["SREM", "tg:leadchats", chat]]).catch(() => {});
      }
      console.error("lead send failed", chat, e.message);
      return 0;
    }
  }));
  const capi = await sendCapi(lead, b, req);
  return res.status(200).json({ ok: true, no, delivered: results.reduce((a, x) => a + x, 0), capi: capi.skipped ? "off" : (capi.received ? "ok" : "fail") });
};

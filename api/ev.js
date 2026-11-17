// Sayt eventlarini kunlik hisoblagichlarga yozadi (Upstash Redis).
// Kalit: zst:v1:YYYY-MM-DD (Toshkent vaqti) → hash, maydon: "<variant>:<event>" → son.
// Mijoz har bir bosqichni bir sessiyada 1 marta yuboradi (pv bundan mustasno).

const EVENTS = new Set([
  'pv', 'ses', 'lead',
  'vp', 'v25', 'v50', 'v75', 'v95',
  's10', 's20', 's30', 's40', 's50', 's60', 's70', 's80', 's90', 's100'
]);
const VARIANTS = new Set(['c']);
const TTL = 60 * 60 * 24 * 180; // 180 kun saqlanadi

// Barcha HINCRBY + EXPIRE bitta so'rovda
const SCRIPT = "for i=1,#ARGV do redis.call('HINCRBY',KEYS[1],ARGV[i],1) end redis.call('EXPIRE',KEYS[1]," + TTL + ") return #ARGV";

function tashkentDate() {
  return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const host = req.headers.host;
  if (req.headers.origin && req.headers.origin !== 'https://' + host) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const ua = String(req.headers['user-agent'] || '');
  if (/bot|crawl|spider|facebookexternalhit|preview|headless/i.test(ua)) {
    return res.status(204).end();
  }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (_) { return res.status(400).json({ error: 'invalid_body' }); }
  if (!body || !VARIANTS.has(body.v) || !Array.isArray(body.e)) {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  const fields = [...new Set(body.e.filter((e) => EVENTS.has(e)))].slice(0, 20).map((e) => body.v + ':' + e);
  if (!fields.length) return res.status(204).end();

  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(503).json({ error: 'not_configured' });

  try {
    const r = await fetch(url.replace(/\/$/, ''), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(['EVAL', SCRIPT, '1', 'zst:v1:' + tashkentDate(), ...fields]),
      signal: AbortSignal.timeout(5000)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || 'redis_error');
    // Bot eslatmalari: sayt trafigi bilan daqiqada ko'pi bilan 1 marta tekshiriladi
    if (fields.indexOf(body.v + ':pv') >= 0 && process.env.TG_WEBHOOK_SECRET) {
      try {
        const lk = await fetch(url.replace(/\/$/, ''), {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(['SET', 'tg:ticklock', '1', 'NX', 'EX', '60']),
          signal: AbortSignal.timeout(3000)
        }).then((x) => x.json());
        if (lk.result === 'OK') {
          await fetch('https://' + host + '/api/tg?tick=' + encodeURIComponent(process.env.TG_WEBHOOK_SECRET), { signal: AbortSignal.timeout(8000) }).catch(() => {});
        }
      } catch (_) {}
    }
    return res.status(200).json({ ok: true });
  } catch (_) {
    return res.status(503).json({ error: 'temporarily_unavailable' });
  }
};

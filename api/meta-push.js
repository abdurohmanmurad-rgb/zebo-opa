// Meta Ads ma'lumotini tashqaridan (Claude Code + Meta MCP) dashboard bazasiga yozish.
// META_ACCESS_TOKEN bo'lmasa, /api/stats shu ma'lumotni ko'rsatadi.
// Himoya: STATS_KEY (header x-stats-key). Faqat raqamli maydonlar saqlanadi.
const crypto = require('crypto');

const NUM = ['spend', 'impressions', 'clicks', 'link_clicks', 'unique_link_clicks', 'unique_ctr', 'lpv', 'video3s', 'thruplay', 'meta_leads'];
const PERIODS = ['1', '2', '7', '14', '30', 'all'];

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const key = process.env.STATS_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured' });
  if (!safeEqual(req.headers['x-stats-key'] || '', key)) return res.status(401).json({ error: 'unauthorized' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (_) { return res.status(400).json({ error: 'invalid_body' }); }
  if (!body || !Array.isArray(body.days) || body.days.length > 1000) return res.status(400).json({ error: 'invalid_payload' });

  const days = body.days
    .filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    .map((d) => { const o = { date: d.date }; NUM.forEach((k) => { o[k] = num(d[k]); }); return o; })
    .filter((d) => d.impressions > 0 || d.spend > 0)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const totals = {};
  PERIODS.forEach((p) => {
    const t = body.totals && body.totals[p];
    totals[p] = t ? { unique_ctr: num(t.unique_ctr), unique_link_clicks: num(t.unique_link_clicks) } : null;
  });
  const meta = {
    account: String(body.account || '').replace(/\D/g, '').slice(0, 20),
    currency: 'USD', source: 'mcp', fetched: new Date().toISOString(), days, totals
  };

  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(503).json({ error: 'db_not_configured' });
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', 'zst:meta:pushed', JSON.stringify(meta)], ['DEL', 'zst:meta:v1']]),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error('redis_error');
    return res.status(200).json({ ok: true, days: days.length });
  } catch (_) {
    return res.status(503).json({ error: 'temporarily_unavailable' });
  }
};

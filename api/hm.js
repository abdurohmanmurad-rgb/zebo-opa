// Bosishlar xaritasi (heatmap) — yig'ish va o'qish.
//
// POST /api/hm            body: {v:"c1", c:[[region, xBin, yBin, "element"], ...], vw:[[region, ms, yangiKo'rish]], s:1}  — saytdan
//   region — sahifadagi bo'lim tartib raqami (.timer + section'lar), xBin 0..49 (2% qadam), yBin 0..99 (1% qadam)
// GET  /api/hm?days=7      header x-stats-key — dashboard uchun jamlangan nuqtalar va eng ko'p bosilgan elementlar
//
// Redis: hm:<v>:<sana> ("r:x:y" → bosish), hmel:<v>:<sana> (element → bosish), hmv:<v>:<sana> ("r:v" ko'rish, "r:ms" vaqt, "r:c" bosish, "ses"). 120 kun.
const crypto = require('crypto');

const VERSIONS = new Set(['c1']);
const TTL = 60 * 60 * 24 * 120;
const tashkentDate = (off) => new Date(Date.now() + 5 * 3600 * 1000 - (off || 0) * 86400000).toISOString().slice(0, 10);

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function db() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return async (cmds) => {
    const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(8000)
    });
    const data = await r.json();
    if (!r.ok || !Array.isArray(data)) throw new Error('redis_error');
    return data.map((d) => (d ? d.result : null));
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const redis = db();
  if (!redis) return res.status(503).json({ error: 'db_not_configured' });

  // ---------- o'qish (dashboard) ----------
  if (req.method === 'GET') {
    const key = process.env.STATS_KEY;
    if (!key || !safeEqual(req.headers['x-stats-key'] || '', key)) return res.status(401).json({ error: 'unauthorized' });
    const v = VERSIONS.has(req.query.v) ? req.query.v : 'c1';
    const p = String(req.query.p || '7');
    let dates;
    if (p === '2') dates = [tashkentDate(1)];
    else {
      const n = p === 'all' ? 120 : Math.min(Math.max(parseInt(p, 10) || 7, 1), 120);
      dates = Array.from({ length: n }, (_, i) => tashkentDate(i));
    }
    try {
      const cmds = [];
      dates.forEach((d) => { cmds.push(['HGETALL', 'hm:' + v + ':' + d]); cmds.push(['HGETALL', 'hmel:' + v + ':' + d]); cmds.push(['HGETALL', 'hmv:' + v + ':' + d]); });
      const out = await redis(cmds);
      const pts = {}, els = {}, vws = {};
      for (let i = 0; i < out.length; i += 3) {
        const a = out[i] || [], b = out[i + 1] || [], c = out[i + 2] || [];
        for (let j = 0; j < a.length; j += 2) pts[a[j]] = (pts[a[j]] || 0) + Number(a[j + 1]);
        for (let j = 0; j < b.length; j += 2) els[b[j]] = (els[b[j]] || 0) + Number(b[j + 1]);
        for (let j = 0; j < c.length; j += 2) vws[c[j]] = (vws[c[j]] || 0) + Number(c[j + 1]);
      }
      const regions = {};
      Object.keys(vws).forEach((k) => {
        if (k === 'ses') return;
        const [r, f] = k.split(':');
        regions[r] = regions[r] || { v: 0, ms: 0, c: 0 };
        regions[r][f] = vws[k];
      });
      const points = Object.keys(pts).map((k) => { const [r, x, y] = k.split(':').map(Number); return [r, x, y, pts[k]]; });
      const elements = Object.keys(els).map((k) => [k, els[k]]).sort((a, b) => b[1] - a[1]).slice(0, 30);
      const total = points.reduce((s, x) => s + x[3], 0);
      return res.status(200).json({ v, from: dates[dates.length - 1], to: dates[0], total, sessions: vws.ses || 0, regions, points, elements });
    } catch (_) {
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  }

  // ---------- yig'ish (sayt) ----------
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  if (req.headers.origin && req.headers.origin !== 'https://' + req.headers.host) return res.status(403).json({ error: 'forbidden' });
  if (/bot|crawl|spider|facebookexternalhit|preview|headless/i.test(String(req.headers['user-agent'] || ''))) return res.status(204).end();

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (_) { return res.status(400).json({ error: 'invalid_body' }); }
  if (!body || !VERSIONS.has(body.v) || !Array.isArray(body.c)) return res.status(400).json({ error: 'invalid_payload' });

  const d = tashkentDate(0), v = body.v;
  const kP = 'hm:' + v + ':' + d, kE = 'hmel:' + v + ':' + d, kV = 'hmv:' + v + ':' + d;
  const cmds = [];
  body.c.slice(0, 25).forEach((c) => {
    if (!Array.isArray(c)) return;
    const r = c[0] | 0, x = c[1] | 0, y = c[2] | 0;
    if (r >= 0 && r < 60 && x >= 0 && x < 50 && y >= 0 && y < 100) cmds.push(['HINCRBY', kP, r + ':' + x + ':' + y, 1]);
    if (r >= 0 && r < 60) cmds.push(['HINCRBY', kV, r + ':c', 1]);
    const el = typeof c[3] === 'string' ? c[3].replace(/[\r\n\t]+/g, ' ').trim().slice(0, 48) : '';
    if (el) cmds.push(['HINCRBY', kE, el, 1]);
  });
  (Array.isArray(body.vw) ? body.vw : []).slice(0, 60).forEach((w) => {
    if (!Array.isArray(w)) return;
    const r = w[0] | 0, ms = Math.max(0, Math.min(600000, w[1] | 0));
    if (r < 0 || r >= 60) return;
    if (ms) cmds.push(['HINCRBY', kV, r + ':ms', ms]);
    if (w[2] === 1) cmds.push(['HINCRBY', kV, r + ':v', 1]);
  });
  if (body.s === 1) cmds.push(['HINCRBY', kV, 'ses', 1]);
  if (!cmds.length) return res.status(204).end();
  cmds.push(['EXPIRE', kP, String(TTL)], ['EXPIRE', kE, String(TTL)], ['EXPIRE', kV, String(TTL)]);
  try {
    await redis(cmds.slice(0, 200));
    return res.status(200).json({ ok: true });
  } catch (_) {
    return res.status(503).json({ error: 'temporarily_unavailable' });
  }
};

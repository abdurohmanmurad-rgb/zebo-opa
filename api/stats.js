// Dashboard uchun kunlik statistika: sayt hisoblagichlari (Redis) + Meta Ads (Graph API).
// Himoya: STATS_KEY (header x-stats-key).
// Meta: META_ACCESS_TOKEN (ads_read), META_AD_ACCOUNT (default: Zebo doctor). Javob 10 daqiqa keshlanadi.
const crypto = require('crypto');

const GRAPH = 'https://graph.facebook.com/v25.0';
const META_TTL = 600;

function tashkentDate(offsetDays) {
  return new Date(Date.now() + 5 * 3600 * 1000 - offsetDays * 86400000).toISOString().slice(0, 10);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function redis(url, token) {
  const base = url.replace(/\/$/, '');
  return async function (cmds) {
    const r = await fetch(base + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(8000)
    });
    const data = await r.json();
    if (!r.ok || !Array.isArray(data)) throw new Error('redis_error');
    return data.map((d) => d && d.result);
  };
}

function act(list, type) {
  if (!Array.isArray(list)) return 0;
  const a = list.find((x) => x.action_type === type);
  return a ? Number(a.value) || 0 : 0;
}

async function fetchMeta() {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return { error: 'not_configured' };
  const account = String(process.env.META_AD_ACCOUNT || '1117207308139781').replace(/^act_/, '');
  const fields = [
    'spend', 'impressions', 'clicks', 'inline_link_clicks', 'unique_inline_link_clicks', 'unique_inline_link_click_ctr',
    'actions', 'video_thruplay_watched_actions'
  ].join(',');
  let next = GRAPH + '/act_' + account + '/insights?' + new URLSearchParams({
    level: 'account', date_preset: 'maximum', time_increment: '1', fields, limit: '200'
  });
  const rows = [];
  for (let page = 0; next && page < 10; page++) {
    const r = await fetch(next, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const e = j.error || {};
      return { error: e.code === 190 ? 'token_invalid' : 'meta_error', message: e.message || ('HTTP ' + r.status) };
    }
    (j.data || []).forEach((d) => {
      const acts = d.actions || [];
      rows.push({
        date: d.date_start,
        spend: Number(d.spend) || 0,
        impressions: Number(d.impressions) || 0,
        clicks: Number(d.clicks) || 0,
        link_clicks: Number(d.inline_link_clicks) || 0,
        unique_link_clicks: Number(d.unique_inline_link_clicks) || 0,
        unique_ctr: Number(d.unique_inline_link_click_ctr) || 0,
        lpv: act(acts, 'landing_page_view'),
        video3s: act(acts, 'video_view'),
        thruplay: act(d.video_thruplay_watched_actions, 'video_view'),
        meta_leads: act(acts, 'lead') || act(acts, 'offsite_conversion.fb_pixel_lead')
      });
    });
    next = j.paging && j.paging.next;
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));

  // Davrlar bo'yicha aniq Unique CTR (kunlarni qo'shib bo'lmaydi — Meta o'zi hisoblaydi)
  const ranges = { 1: [0, 0], 2: [1, 1], 7: [6, 0], 14: [13, 0], 30: [29, 0], all: null };
  const totals = {};
  await Promise.all(Object.keys(ranges).map(async (k) => {
    const params = { level: 'account', fields: 'unique_inline_link_click_ctr,unique_inline_link_clicks' };
    if (ranges[k]) params.time_range = JSON.stringify({ since: tashkentDate(ranges[k][0]), until: tashkentDate(ranges[k][1]) });
    else params.date_preset = 'maximum';
    try {
      const r = await fetch(GRAPH + '/act_' + account + '/insights?' + new URLSearchParams(params), {
        headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000)
      });
      const j = await r.json();
      const d = (j.data || [])[0] || {};
      totals[k] = { unique_ctr: Number(d.unique_inline_link_click_ctr) || 0, unique_link_clicks: Number(d.unique_inline_link_clicks) || 0 };
    } catch (_) { totals[k] = null; }
  }));
  return { account, currency: 'USD', days: rows.filter((r) => r.impressions > 0 || r.spend > 0), totals };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const key = process.env.STATS_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured' });
  if (!safeEqual(req.headers['x-stats-key'] || '', key)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(503).json({ error: 'db_not_configured' });
  const db = redis(url, token);

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 180);
  const dates = Array.from({ length: days }, (_, i) => tashkentDate(i));
  const fresh = req.query.fresh === '1';

  try {
    const results = await db(dates.map((d) => ['HGETALL', 'zst:v1:' + d]).concat([['GET', 'zst:meta:v1'], ['GET', 'zst:meta:pushed']]));
    const site = dates.map((date, i) => {
      const flat = results[i] || [];
      const counts = {};
      for (let j = 0; j < flat.length; j += 2) counts[flat[j]] = Number(flat[j + 1]) || 0;
      return { date, counts };
    });

    let meta = null;
    const cached = results[dates.length];
    if (cached && !fresh) { try { meta = JSON.parse(cached); } catch (_) {} }
    // Token yo'q bo'lsa — Claude Code (Meta MCP) orqali yozilgan ma'lumot
    if (!meta && !process.env.META_ACCESS_TOKEN && results[dates.length + 1]) {
      try { meta = JSON.parse(results[dates.length + 1]); } catch (_) {}
    }
    if (!meta) {
      try { meta = await fetchMeta(); } catch (e) { meta = { error: 'meta_unavailable', message: String(e.message || e) }; }
      meta.fetched = new Date().toISOString();
      if (!meta.error) db([['SET', 'zst:meta:v1', JSON.stringify(meta), 'EX', String(META_TTL)]]).catch(() => {});
    }

    return res.status(200).json({ days: site, meta, generated: new Date().toISOString() });
  } catch (_) {
    return res.status(503).json({ error: 'temporarily_unavailable' });
  }
};

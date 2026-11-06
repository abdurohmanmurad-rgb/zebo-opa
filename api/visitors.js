const SCRIPT = "redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); redis.call('ZADD',KEYS[1],ARGV[2],ARGV[3]); redis.call('EXPIRE',KEYS[1],120); return redis.call('ZCARD',KEYS[1])";
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
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (_) { return res.status(400).json({ error: 'invalid_body' }); }
  if (!body || !/^[a-f0-9-]{36}$/.test(body.visitorId || '')) {
    return res.status(400).json({ error: 'invalid_visitor' });
  }
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(503).json({ error: 'not_configured' });
  try {
    const now = Date.now();
    const response = await fetch(url.replace(/\/$/, ''), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(['EVAL', SCRIPT, '1', 'zebo:presence:v1', String(now - 60000), String(now), body.visitorId]),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error('redis_unavailable');
    const data = await response.json();
    if (data.error || !Number.isSafeInteger(data.result) || data.result < 1) throw new Error('invalid_count');
    return res.status(200).json({ count: data.result });
  } catch (_) {
    return res.status(503).json({ error: 'temporarily_unavailable' });
  }
};

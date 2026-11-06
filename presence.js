(function () {
  var badge = document.querySelector('[data-live-visitors]');
  if (!badge) return;
  var output = badge.querySelector('[data-live-count]');
  var id;
  try {
    id = localStorage.getItem('zebo-visitor-id');
    if (!/^[a-f0-9-]{36}$/.test(id || '')) {
      id = crypto.randomUUID();
      localStorage.setItem('zebo-visitor-id', id);
      id = localStorage.getItem('zebo-visitor-id');
    }
  } catch (_) {
    if (!window.crypto || !crypto.randomUUID) return;
    id = crypto.randomUUID();
  }
  var pending = false;
  async function refresh() {
    if (document.visibilityState !== 'visible' || pending) return;
    pending = true;
    try {
      var response = await fetch('/api/visitors', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId: id }), cache: 'no-store',
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error('unavailable');
      var data = await response.json();
      if (!Number.isSafeInteger(data.count) || data.count < 1) throw new Error('invalid_count');
      output.textContent = new Intl.NumberFormat('uz-UZ').format(data.count);
      badge.hidden = document.visibilityState !== 'visible';
    } catch (_) { badge.hidden = true; }
    finally { pending = false; }
  }
  document.addEventListener('visibilitychange', function () {
    badge.hidden = true;
    if (document.visibilityState === 'visible') refresh();
  });
  window.addEventListener('pageshow', refresh);
  refresh();
  setInterval(refresh, 20000);
})();
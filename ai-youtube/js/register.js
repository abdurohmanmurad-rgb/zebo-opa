'use strict';

// Ro'yxatdan o'tgan foydalanuvchi ma'lumotini Google Sheets'ga yuborish.
const WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbzMlEAMuqNhvLaNSE77mQa6l0yYrhtrOdeUfD9s5vPLvtQZdQJtwnNzUjm_pwsqiYmoCg/exec';
const SOURCE = 'yashil (AI)';

(async _ => {
  let user = JSON.parse(localStorage.getItem('user'));

  if (user && user?.name && user?.phone && user?.time) {
    if (WEBHOOK_URL) {
      try {
        const fd = new FormData();
        fd.append('name', user.name);
        fd.append('phone', user.phone);
        fd.append('time', user.time);
        fd.append('source', SOURCE);
        fd.append('utm_source', user.utm_source || '');
        fd.append('utm_medium', user.utm_medium || '');
        fd.append('utm_campaign', user.utm_campaign || '');
        fd.append('utm_content', user.utm_content || '');
        fd.append('utm_term', user.utm_term || '');
        await fetch(WEBHOOK_URL, { method: 'POST', body: fd });
      } catch (e) {
        // tarmoq xatosi — jim o'tkazamiz
      }
    }
    localStorage.removeItem('user');
  } else {
    localStorage.removeItem('user');
  }
})()

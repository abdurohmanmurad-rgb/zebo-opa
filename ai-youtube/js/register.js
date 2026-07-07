'use strict';

// Ro'yxatdan o'tgan foydalanuvchi ma'lumotini o'z backendingizga yuborish.
// DIQQAT: quyidagi WEBHOOK_URL ni O'ZINGIZNING Google Apps Script yoki
// boshqa endpoint manzilingiz bilan almashtiring. Bo'sh qolsa, lid hech
// qayerga yuborilmaydi (faqat brauzerdan tozalanadi).
const WEBHOOK_URL = ''; // <-- bu yerga o'z manzilingizni qo'ying

(async _ => {
  let user = JSON.parse(localStorage.getItem('user'));

  if (user && user?.name && user?.phone && user?.time) {
    if (WEBHOOK_URL) {
      try {
        const formData = new FormData();
        formData.append('Ismi', user?.name);
        formData.append('Telefon raqami', user?.phone);
        formData.append(`Ro'yxatdan o'tgan vaqti`, user?.time);

        const response = await fetch(WEBHOOK_URL, {
          method: 'POST',
          body: formData
        });
        await response.json();
      } catch (e) {
        // tarmoq xatosi — jim o'tkazamiz
      }
    }
    localStorage.removeItem('user');
  } else {
    localStorage.removeItem('user');
  }
})()

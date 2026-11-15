// firebase-messaging-sw.js —— 放在網站根目錄（與 index.html 同一層）。不需要修改。
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// 設定值由 index.html 註冊時帶入，所以這個檔案不用填任何資料
const q = new URL(self.location.href).searchParams;
firebase.initializeApp({
  apiKey: q.get('apiKey'), authDomain: q.get('authDomain'), projectId: q.get('projectId'),
  messagingSenderId: q.get('messagingSenderId'), appId: q.get('appId')
});
const messaging = firebase.messaging();

// 背景（網頁關閉）時收到推播 → 顯示通知
messaging.onBackgroundMessage(p => {
  const d = p.data || {};
  return self.registration.showNotification(d.title || 'Unfinished跟進系統', {
    body: d.body || '今天有顧客需要跟進',
    icon: 'icon-192.png', badge: 'icon-192.png', tag: 'crm-daily',
    data: { url: d.url || self.registration.scope }
  });
});

// 點通知 → 開啟（或切換到）系統
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return clients.openWindow(url);
  }));
});

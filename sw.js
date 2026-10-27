// Service worker : reçoit les notifications et ouvre le site au clic
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || "EVG de Tof", {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" }
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) { if ("focus" in c) { c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});

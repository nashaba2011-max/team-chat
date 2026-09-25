// Service worker بسيط: يخلي التطبيق قابل للتثبيت.
// ما نخزّن الملفات عشان كل تحديث ترفعه يوصل للموظفين مباشرة.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

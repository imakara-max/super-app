// アプリ本体（同一オリジンの静的ファイル）だけをキャッシュする。Google API の通信はキャッシュしない。
const CACHE = "today-v7";
const PUSH_CACHE = "superapp-push"; // 通知の設定 (today.js が保存する)。アプリ本体の更新では消さない
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./shell.js",
  "./mail.js",
  "./lists.js",
  "./today.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== PUSH_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ネットワーク優先、オフライン時のみキャッシュを返す。
// GitHub Pages はファイルを 10 分間ブラウザにキャッシュさせるため、更新がすぐ届くよう no-cache で再検証する。
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req.url, { cache: "no-cache" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("./index.html")))
  );
});

// ---------- 通知 ----------
// サーバーからは中身の無いお知らせだけが届くので、最新の通知文をサーバーに取りに行って表示する。
// iPhone では、届いたお知らせごとに必ず通知を表示しないと通知が止められてしまうため、失敗しても何かは出す。
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let msg = { title: "スーパーアプリ", body: "新しいお知らせがあります", view: "today" };
      try {
        const saved = await (await caches.open(PUSH_CACHE)).match("push-config");
        if (saved) {
          const { url, secret } = await saved.json();
          const res = await fetch(url, { method: "POST", body: JSON.stringify({ action: "push.latest", secret }) });
          const body = await res.json();
          if (body.title) msg = body;
        }
      } catch { /* 既定の文で知らせる */ }
      await self.registration.showNotification(msg.title, {
        body: msg.body,
        icon: "icons/icon-192.png",
        tag: "superapp",
        data: { view: msg.view || "today" },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const view = (event.notification.data && event.notification.data.view) || "today";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (windows.length) {
        windows[0].postMessage({ view });
        return windows[0].focus();
      }
      return self.clients.openWindow(new URL(`./?view=${view}`, self.registration.scope).href);
    })()
  );
});

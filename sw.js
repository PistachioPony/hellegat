// Hellegat's service worker. It runs in the background so the site can be installed,
// and later it will receive slack notifications. It never caches or intercepts pages:
// the river is live, so every visit should load fresh from the network.

// A new version takes over as soon as it's installed, instead of waiting for every open tab to close.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

// A slack notification arrives. The page may not be open, so the worker shows it.
self.addEventListener("push", event => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    // Not JSON (Firebase always sends JSON, but a test might not): show the plain text instead.
    payload = { notification: { body: event.data.text() } };
  }
  const title = payload.notification?.title ?? "Hellegat";
  const body = payload.notification?.body ?? "";
  event.waitUntil(
    self.registration.showNotification(title, { body, icon: "icons/icon-192.png" })
  );
});

// The visitor taps the notification: bring Hellegat forward, freshly loaded, or open it.
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const home = self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
      for (const win of windows) {
        if (win.url.startsWith(home)) {
          return win.navigate(home).then(fresh => (fresh || win).focus()).catch(() => win.focus());
        }
      }
      return self.clients.openWindow(home);
    })
  );
});

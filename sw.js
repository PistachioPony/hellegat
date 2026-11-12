// Hellegat's service worker. It runs in the background so the site can be installed,
// and later it will receive slack notifications. It never caches or intercepts pages:
// the river is live, so every visit should load fresh from the network.

// A new version takes over as soon as it's installed, instead of waiting for every open tab to close.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

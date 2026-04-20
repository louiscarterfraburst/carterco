const CACHE_NAME = "carterco-v1";
const CORE_ASSETS = ["/", "/manifest.webmanifest", "/logo.png", "/signature.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
          return response;
        })
        .catch(() => caches.match("/"));
    }),
  );
});

self.addEventListener("push", (event) => {
  const payload = event.data?.json() ?? {};
  const title = payload.title || "New CarterCo lead";
  const phone = payload.phone || "";

  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "Open CarterCo to follow up.",
      data: {
        url: payload.url || "/",
        phone,
      },
      icon: "/icon.png",
      badge: "/apple-icon.png",
      actions: phone
        ? [
            {
              action: "call",
              title: "Call",
            },
          ]
        : [],
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const phone = event.notification.data?.phone;
  const url = event.action === "call" && phone ? `tel:${phone}` : event.notification.data?.url || "/";

  event.waitUntil(self.clients.openWindow(url));
});

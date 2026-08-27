/* =====================================================================
   service-worker.js — permite instalar o app (Android/iOS/Windows) e
   abrir o "app shell" (HTML/CSS/JS próprios) mesmo sem internet.
   ---------------------------------------------------------------------
   Observação: os livros ficam salvos no IndexedDB (não neste cache), e
   as bibliotecas externas (Tailwind, epub.js, pdf.js) vêm de CDN — elas
   são cacheadas na primeira visita e reaproveitadas depois, mas exigem
   pelo menos UM acesso online inicial para ficarem disponíveis offline.
   ===================================================================== */

const CACHE_NAME = "estante-cache-v1";

const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./reader.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Estratégia: "cache primeiro, com atualização em segundo plano".
// Garante abertura instantânea do app shell mesmo offline, enquanto
// mantém os arquivos atualizados quando há conexão.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline: cai para o cache se a rede falhar

      return cached || networkFetch;
    })
  );
});

/* =====================================================================
   service-worker.js — PWA offline (v2)
   ---------------------------------------------------------------------
   - App Shell local (index.html, app.js, reader.js, tts-neural.js):
     estratégia Network-First (atualiza na hora quando há internet e
     cai para o cache quando está offline).
   - Bibliotecas CDN imutáveis (JSZip, PDF.js, Tailwind, fontes):
     estratégia Cache-First com atualização em segundo plano.
   - Pesos de modelo neural (.onnx / HuggingFace): ignorados pelo SW
     pois o Piper TTS já os armazena nativamente no OPFS do navegador.
   ===================================================================== */

const CACHE_NAME = "estante-cache-v5";

const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js?v=5",
  "./reader.js?v=5",
  "./tts-neural.js?v=5",
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

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Não intercepta modelos pesados (.onnx) nem blobs locais
  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:"
  ) {
    return;
  }
  if (
    url.pathname.endsWith(".onnx") ||
    url.hostname.includes("huggingface.co")
  ) {
    return;
  }

  // Arquivos do próprio domínio: Network-First para entregas rápidas de updates
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // CDNs externas: Cache-First com atualização em segundo plano
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
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});

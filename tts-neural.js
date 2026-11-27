/* =====================================================================
   tts-neural.js — Motor Neural Offline em pt-BR (Piper TTS via ONNX/WASM)
   ---------------------------------------------------------------------
   Carrega sob demanda @mintplex-labs/piper-tts-web via CDN (esm.sh).
   Os pesos (.onnx + .json) ficam armazenados no OPFS do navegador após
   o primeiro download, permitindo narração neural 100% offline e grátis.
   ===================================================================== */

const PIPER_CDN = "https://esm.sh/@mintplex-labs/piper-tts-web@1.0.4";
const DEFAULT_PT_VOICES = [
  { id: "pt_BR-faber-medium", label: "Faber — Português (BR) Neural" },
];

let piperModule = null;
let loadPromise = null;

// Cache de pré-síntese para a próxima frase (evita pausas entre sentenças)
const prefetchCache = new Map();

async function ensureModule() {
  if (piperModule) return piperModule;
  if (!loadPromise) {
    loadPromise = import(PIPER_CDN)
      .then((mod) => {
        piperModule = mod;
        return mod;
      })
      .catch((err) => {
        loadPromise = null;
        throw err;
      });
  }
  return loadPromise;
}

function isSupported() {
  return typeof WebAssembly === "object" && typeof navigator !== "undefined";
}

async function listPtBrVoices() {
  try {
    const tts = await ensureModule();
    if (typeof tts.voices === "function") {
      const all = await tts.voices();
      const list = Array.isArray(all)
        ? all
        : Object.keys(all || {}).map((key) => ({ key, ...(all[key] || {}) }));
      const pt = list
        .filter((v) => {
          const id = typeof v === "string" ? v : v.key || v.id || "";
          return id.toLowerCase().startsWith("pt_br");
        })
        .map((v) => {
          const id = typeof v === "string" ? v : v.key || v.id;
          const pretty = id
            .replace(/^pt_BR-/i, "")
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
          return { id, label: `${pretty} (pt-BR Neural)` };
        });
      if (pt.length) return pt;
    }
  } catch (err) {
    console.warn("Não foi possível listar vozes Piper dinamicamente:", err);
  }
  return DEFAULT_PT_VOICES;
}

async function getStoredVoices() {
  try {
    const tts = await ensureModule();
    if (typeof tts.stored === "function") {
      const stored = await tts.stored();
      return Array.isArray(stored) ? stored : [];
    }
  } catch (err) {
    console.warn("Não foi possível consultar cache OPFS do Piper:", err);
  }
  return [];
}

async function downloadVoice(voiceId = "pt_BR-faber-medium", onProgress = null) {
  const tts = await ensureModule();
  await tts.download(voiceId, (progress) => {
    if (!onProgress || !progress) return;
    const pct =
      progress.total > 0
        ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
        : 0;
    onProgress({ ...progress, percent: pct });
  });
  return true;
}

async function synthesize(text, voiceId = "pt_BR-faber-medium") {
  const clean = (text || "").trim();
  if (!clean) return null;

  const key = `${voiceId}::${clean}`;
  if (prefetchCache.has(key)) {
    const pending = prefetchCache.get(key);
    prefetchCache.delete(key);
    return pending;
  }

  const tts = await ensureModule();
  return tts.predict({
    text: clean,
    voiceId,
  });
}

function prefetch(text, voiceId = "pt_BR-faber-medium") {
  const clean = (text || "").trim();
  if (!clean) return;
  const key = `${voiceId}::${clean}`;
  if (prefetchCache.has(key)) return;

  // Limita o cache em memória a no máximo 2 frases antecipadas
  if (prefetchCache.size >= 2) {
    const oldestKey = prefetchCache.keys().next().value;
    prefetchCache.delete(oldestKey);
  }

  const promise = ensureModule()
    .then((tts) => tts.predict({ text: clean, voiceId }))
    .catch(() => {
      prefetchCache.delete(key);
      return null;
    });

  prefetchCache.set(key, promise);
}

function clearPrefetch() {
  prefetchCache.clear();
}

window.NeuralTTS = {
  isSupported,
  listPtBrVoices,
  getStoredVoices,
  downloadVoice,
  synthesize,
  prefetch,
  clearPrefetch,
  DEFAULT_VOICE: "pt_BR-faber-medium",
};

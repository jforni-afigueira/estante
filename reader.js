/* =====================================================================
   reader.js — Leitor Nativo EPUB/PDF + TTS Híbrido (Navegador + Neural)
   ---------------------------------------------------------------------
   - EPUB nativo com JSZip + DOMParser, TOC instantâneo (EPUB 3 nav /
     EPUB 2 ncx), sanitização segura, links internos e Blob URLs.
   - PDF híbrido com Canvas HiDPI + Zoom + camada de texto com TTS.
   - Motor de voz fatiado por frase (sem cortes no Chrome/Android),
     destaque em O(1), priorização de vozes neurais nativas do navegador
     e modo Neural Offline (Piper pt-BR via ONNX/WASM com pré-síntese).
   - Media Session API, Wake Lock, Sleep Timer, busca no texto, atalhos
     de teclado e gestos de deslizar (swipe).
   ===================================================================== */

/* ---- Elementos da UI do leitor ---- */
const viewLibrary = document.getElementById("view-library");
const viewReader = document.getElementById("view-reader");
const readerFrame = document.getElementById("reader-frame");
const readerTitle = document.getElementById("reader-title");
const readerToc = document.getElementById("reader-toc");
const readerCoverThumb = document.getElementById("reader-cover-thumb");
const btnBack = document.getElementById("btn-back");
const btnA11y = document.getElementById("btn-a11y");
const modalA11y = document.getElementById("modal-a11y");
const btnCloseA11y = document.getElementById("btn-close-a11y");
const btnBookmark = document.getElementById("btn-bookmark");
const iconBookmark = document.getElementById("icon-bookmark");
const modalCoverFull = document.getElementById("modal-cover-full");
const imgCoverFull = document.getElementById("img-cover-full");
const btnCloseCover = document.getElementById("btn-close-cover");

const progressLabel = document.getElementById("progress-label");
const progressPercent = document.getElementById("progress-percent");
const progressBar = document.getElementById("progress-bar");
const ttsEngineBadge = document.getElementById("tts-engine-badge");
const sleepTimerBadge = document.getElementById("sleep-timer-badge");

const btnTtsToggle = document.getElementById("btn-tts-toggle");
const iconPlay = document.getElementById("icon-play");
const iconPause = document.getElementById("icon-pause");
const iconTtsLoading = document.getElementById("icon-tts-loading");
const ttsSpeed = document.getElementById("tts-speed");
const ttsSpeedVal = document.getElementById("tts-speed-val");

const pdfZoomSection = document.getElementById("pdf-zoom-section");
const pdfZoomVal = document.getElementById("pdf-zoom-val");

const browserVoicePanel = document.getElementById("browser-voice-panel");
const ttsVoiceSelect = document.getElementById("tts-voice-select");
const btnTestVoice = document.getElementById("btn-test-voice");

const neuralVoicePanel = document.getElementById("neural-voice-panel");
const neuralVoiceSelect = document.getElementById("neural-voice-select");
const neuralCacheStatus = document.getElementById("neural-cache-status");
const btnDownloadNeural = document.getElementById("btn-download-neural");
const neuralProgressWrap = document.getElementById("neural-progress-wrap");
const neuralProgressLabel = document.getElementById("neural-progress-label");
const neuralProgressPct = document.getElementById("neural-progress-pct");
const neuralProgressBar = document.getElementById("neural-progress-bar");

const btnSearchText = document.getElementById("btn-search-text");
const readerSearchBar = document.getElementById("reader-search-bar");
const readerSearchInput = document.getElementById("reader-search-input");
const readerSearchCount = document.getElementById("reader-search-count");

/* ---- Estado do livro atualmente aberto ---- */
let currentBook = null;
let currentType = null;      // "epub" | "pdf"
let epubZip = null;
let epubManifestItems = {};
let epubSpineIds = [];
let epubChapterTitles = [];
let epubPathToSpine = {};    // mapa rápido absPath (lowercase) -> spineIndex
let currentSpineIndex = 0;
let createdBlobUrls = [];

let pdfDoc = null;
let pdfCurrentPage = 1;
let pdfTotalPages = 0;
let pdfZoom = 1.5;
let pdfRenderTask = null;

let saveTimer = null;

/* ---- Estado do TTS Híbrido ---- */
const STORAGE_ENGINE_KEY = "estante_tts_engine";
const STORAGE_VOICE_URI_KEY = "estante_tts_voice_uri";
const STORAGE_NEURAL_VOICE_KEY = "estante_tts_neural_voice";
const STORAGE_SPEED_KEY = "estante_tts_speed";

let ttsEngine = localStorage.getItem(STORAGE_ENGINE_KEY) || "browser"; // "browser" | "neural"
let selectedBrowserVoiceURI = localStorage.getItem(STORAGE_VOICE_URI_KEY) || "";
let selectedNeuralVoiceId = localStorage.getItem(STORAGE_NEURAL_VOICE_KEY) || "pt_BR-faber-medium";

let ttsWords = [];           // [{ el, text, paraEl }]
let ttsSentences = [];       // [{ startIdx, endIdx, text, offsets }]
let ttsCurrentIndex = 0;
let ttsSpeaking = false;
let ttsSessionId = 0;        // invalida callbacks/sínteses de sessões anteriores
let ttsUtterance = null;
let cachedVoice = null;
let lastHighlightedEl = null;
let activeSentenceEls = [];

// Áudio do modo Neural (Piper)
let neuralAudio = null;
let neuralAudioUrl = null;
let neuralHighlightRaf = null;
let neuralVoicesInitialized = false;

// Wake Lock e Sleep Timer
let wakeLockSentinel = null;
let sleepTimerInterval = null;
let sleepTimerEndsAt = 0;

// Busca no texto
let searchMatches = [];
let searchMatchIndex = -1;

/* =====================================================================
   Inicialização única de preferências de velocidade e motor
   ===================================================================== */

(function initStoredTtsPrefs() {
  const savedSpeed = parseFloat(localStorage.getItem(STORAGE_SPEED_KEY) || "2");
  const clamped = Number.isFinite(savedSpeed) ? Math.min(3, Math.max(0.5, savedSpeed)) : 2;
  ttsSpeed.value = String(clamped);
  ttsSpeedVal.textContent = `${clamped.toFixed(1)}x`;
  syncTtsEngineUI();
  initBrowserVoiceList();
})();

/* =====================================================================
   Abertura / fechamento do leitor
   ===================================================================== */

async function openReader(bookId) {
  showLoading("Abrindo livro…");
  const book = await getBook(bookId);
  if (!book || !book.fileData) {
    hideLoading();
    alert("Não foi possível localizar os dados deste arquivo.");
    return;
  }

  // Garante objeto de preferências completo mesmo em registros legados
  book.prefs = {
    theme: "claro",
    font: "sans",
    fontSize: 18,
    pdfZoom: 1.5,
    ...(book.prefs || {}),
  };
  book.progress = {
    location: null,
    percent: 0,
    page: 0,
    totalPages: 0,
    ...(book.progress || {}),
  };

  currentBook = book;
  currentType = book.type;
  pdfZoom = book.prefs.pdfZoom || 1.5;

  readerTitle.textContent = book.title;

  if (book.type === "pdf") {
    readerTitle.classList.remove("hidden");
    readerToc.classList.add("hidden");
    pdfZoomSection?.classList.remove("hidden");
    updatePdfZoomLabel();
  } else {
    pdfZoomSection?.classList.add("hidden");
  }

  if (book.cover && readerCoverThumb) {
    readerCoverThumb.src = book.cover;
    readerCoverThumb.classList.remove("hidden");
  } else if (readerCoverThumb) {
    readerCoverThumb.src = "";
    readerCoverThumb.classList.add("hidden");
  }

  viewLibrary.classList.add("hidden");
  viewReader.classList.remove("hidden");
  closeSearchBar();

  applyTheme(book.prefs.theme);
  applyFont(book.prefs.font);
  applyFontSize(book.prefs.fontSize);
  syncA11yButtons(book.prefs);
  updateMediaSessionMetadata();

  try {
    if (book.type === "epub") await loadEpub(book);
    else await loadPdf(book);
  } catch (err) {
    console.error("Erro ao abrir livro:", err);
    alert("Não foi possível abrir este arquivo. Ele pode estar corrompido.");
    closeReader();
  }
  hideLoading();
}

function closeReader() {
  stopSpeaking();
  clearSleepTimer();
  closeSearchBar();

  // Salva progresso imediato antes de limpar o estado
  if (currentBook) {
    patchBook(currentBook.id, { progress: currentBook.progress }).catch(() => {});
  }

  revokeBlobUrls();
  epubZip = null;
  epubManifestItems = {};
  epubSpineIds = [];
  epubChapterTitles = [];
  epubPathToSpine = {};
  currentSpineIndex = 0;

  readerToc.classList.add("hidden");
  readerToc.innerHTML = "";
  readerTitle.classList.remove("hidden");

  if (pdfRenderTask) {
    try { pdfRenderTask.cancel(); } catch (_) {}
    pdfRenderTask = null;
  }
  if (pdfDoc) {
    try { pdfDoc.destroy(); } catch (_) {}
    pdfDoc = null;
  }

  ttsWords = [];
  ttsSentences = [];
  ttsCurrentIndex = 0;
  lastHighlightedEl = null;
  activeSentenceEls = [];
  readerFrame.innerHTML = "";

  if (readerCoverThumb) {
    readerCoverThumb.src = "";
    readerCoverThumb.classList.add("hidden");
  }

  viewReader.classList.add("hidden");
  viewLibrary.classList.remove("hidden");
  currentBook = null;
  currentType = null;
  renderLibrary();
}

btnBack.addEventListener("click", closeReader);

/* ---- Listener permanente do TOC (corrige bug do replaceChild) ---- */
readerToc.addEventListener("change", (e) => {
  if (currentType !== "epub") return;
  const idx = parseInt(e.target.value, 10);
  if (!Number.isNaN(idx)) {
    stopSpeaking();
    displayEpubChapter(idx, 0);
  }
});

/* ---- Listener delegado único em readerFrame (EPUB + PDF) ---- */
readerFrame.addEventListener("click", (e) => {
  if (!currentBook) return;

  // 1. Links internos em capítulos EPUB (navegação por âncoras / sumário)
  const anchor = e.target.closest("a[href]");
  if (anchor && currentType === "epub") {
    const href = anchor.getAttribute("href") || "";
    if (!href.startsWith("http://") && !href.startsWith("https://") && !href.startsWith("mailto:")) {
      e.preventDefault();
      navigateEpubHref(href);
      return;
    }
  }

  // 2. Clique em uma palavra para mover o ponto de leitura (Click-to-Read)
  const wordEl = e.target.closest(".tts-word");
  if (wordEl) {
    // Se o usuário estiver selecionando texto com o mouse, não interrompe
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) return;

    const idx = parseInt(wordEl.dataset.wordIdx, 10);
    if (!Number.isNaN(idx) && idx >= 0 && idx < ttsWords.length) {
      ttsCurrentIndex = idx;
      if (ttsSpeaking) {
        speakFrom(ttsCurrentIndex);
      } else {
        highlightWord(ttsCurrentIndex);
      }
      return;
    }
  }

  // 3. Clique nas bordas laterais para virar capítulo / página
  const rect = readerFrame.getBoundingClientRect();
  const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
  if (relX < 0.12) {
    if (currentType === "epub") {
      stopSpeaking();
      displayEpubChapter(currentSpineIndex - 1);
    } else if (currentType === "pdf") {
      goToPdfPage(pdfCurrentPage - 1);
    }
  } else if (relX > 0.88) {
    if (currentType === "epub") {
      stopSpeaking();
      displayEpubChapter(currentSpineIndex + 1);
    } else if (currentType === "pdf") {
      goToPdfPage(pdfCurrentPage + 1);
    }
  }
});

/* ---- Gestos de deslizar (Swipe) no mobile ---- */
let touchStartX = 0;
let touchStartY = 0;

readerFrame.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) return;
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}, { passive: true });

readerFrame.addEventListener("touchend", (e) => {
  if (!currentBook || e.changedTouches.length !== 1) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;

  // Só dispara swipe horizontal nítido (evita confundir com rolagem vertical)
  if (Math.abs(dx) > 75 && Math.abs(dx) > Math.abs(dy) * 1.8) {
    if (dx < 0) {
      if (currentType === "epub") {
        stopSpeaking();
        displayEpubChapter(currentSpineIndex + 1);
      } else if (currentType === "pdf") {
        goToPdfPage(pdfCurrentPage + 1);
      }
    } else {
      if (currentType === "epub") {
        stopSpeaking();
        displayEpubChapter(currentSpineIndex - 1);
      } else if (currentType === "pdf") {
        goToPdfPage(pdfCurrentPage - 1);
      }
    }
  }
}, { passive: true });

/* =====================================================================
   EPUB — Motor nativo (JSZip + DOMParser + TOC instantâneo)
   ===================================================================== */

function revokeBlobUrls() {
  createdBlobUrls.forEach((url) => URL.revokeObjectURL(url));
  createdBlobUrls = [];
}

/** Extrai mapa de títulos (absPath.toLowerCase() -> label) a partir do nav.xhtml (EPUB 3) ou toc.ncx (EPUB 2). */
async function parseEpubTocMap(opfDoc, rootDir) {
  const titleByPath = {};

  // 1. Tenta EPUB 3 Nav Document (properties="nav")
  const navItem = Object.values(epubManifestItems).find((item) =>
    (item.properties || "").split(/\s+/).includes("nav")
  );
  if (navItem) {
    const navFile = findZipFile(epubZip, navItem.absPath);
    if (navFile) {
      try {
        const navText = await navFile.async("text");
        const navDoc = new DOMParser().parseFromString(navText, "text/html");
        const navDir = navItem.absPath.includes("/")
          ? navItem.absPath.substring(0, navItem.absPath.lastIndexOf("/") + 1)
          : "";
        const tocNav =
          navDoc.querySelector('nav[epub\\:type="toc"], nav[role="doc-toc"], nav') || navDoc;
        tocNav.querySelectorAll("a[href]").forEach((a) => {
          const label = a.textContent?.replace(/\s+/g, " ").trim();
          const targetPath = resolveZipPath(navDir, a.getAttribute("href") || "").toLowerCase();
          if (label && targetPath && !titleByPath[targetPath]) {
            titleByPath[targetPath] = label;
          }
        });
      } catch (err) {
        console.warn("Falha ao ler EPUB 3 nav:", err);
      }
    }
  }

  // 2. Tenta EPUB 2 NCX (toc.ncx) caso o nav esteja ausente ou incompleto
  if (Object.keys(titleByPath).length === 0) {
    const spineTocId = opfDoc.querySelector("spine")?.getAttribute("toc");
    const ncxItem =
      (spineTocId && epubManifestItems[spineTocId]) ||
      Object.values(epubManifestItems).find(
        (item) =>
          item.mediaType === "application/x-dtbncx+xml" ||
          (item.href || "").toLowerCase().endsWith(".ncx")
      );

    if (ncxItem) {
      const ncxFile = findZipFile(epubZip, ncxItem.absPath);
      if (ncxFile) {
        try {
          const ncxText = await ncxFile.async("text");
          const ncxDoc = new DOMParser().parseFromString(ncxText, "text/xml");
          const ncxDir = ncxItem.absPath.includes("/")
            ? ncxItem.absPath.substring(0, ncxItem.absPath.lastIndexOf("/") + 1)
            : "";
          ncxDoc.querySelectorAll("navPoint").forEach((point) => {
            const label = point.querySelector("navLabel > text")?.textContent?.replace(/\s+/g, " ").trim();
            const src = point.querySelector("content")?.getAttribute("src") || "";
            const targetPath = resolveZipPath(ncxDir, src).toLowerCase();
            if (label && targetPath && !titleByPath[targetPath]) {
              titleByPath[targetPath] = label;
            }
          });
        } catch (err) {
          console.warn("Falha ao ler EPUB 2 toc.ncx:", err);
        }
      }
    }
  }

  return titleByPath;
}

/** Sanitiza o documento HTML do capítulo para segurança e fidelidade aos temas. */
function sanitizeChapterDom(doc) {
  if (!doc || !doc.body) return;

  doc.body.querySelectorAll("script, iframe, object, embed, form, link, style, meta").forEach((el) => el.remove());

  doc.body.querySelectorAll("*").forEach((el) => {
    // Remove atributos de evento inline (onclick, onerror, etc.)
    Array.from(el.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
      }
    });

    // Remove cores fixas inline que quebram os temas Escuro/Sépia
    if (el.style) {
      el.style.removeProperty("color");
      el.style.removeProperty("background");
      el.style.removeProperty("background-color");
      el.style.removeProperty("font-family");
      el.style.removeProperty("font-size");
    }
  });
}

async function loadEpub(book) {
  readerFrame.innerHTML = "";
  revokeBlobUrls();

  const arrayBuffer =
    book.fileData instanceof Blob ? await book.fileData.arrayBuffer() : book.fileData;

  epubZip = await JSZip.loadAsync(arrayBuffer);

  // 1. Localiza META-INF/container.xml -> rootfile (.opf)
  const containerFile = findZipFile(epubZip, "META-INF/container.xml");
  if (!containerFile) throw new Error("META-INF/container.xml ausente no EPUB.");

  const containerXmlText = await containerFile.async("text");
  const containerDoc = new DOMParser().parseFromString(containerXmlText, "text/xml");
  const rootfilePath = containerDoc.querySelector("rootfile")?.getAttribute("full-path");
  if (!rootfilePath) throw new Error("Caminho do arquivo .opf não encontrado.");

  const rootDir = rootfilePath.includes("/")
    ? rootfilePath.substring(0, rootfilePath.lastIndexOf("/") + 1)
    : "";

  // 2. Processa manifesto e spine do .opf
  const opfFile = findZipFile(epubZip, rootfilePath);
  if (!opfFile) throw new Error("Arquivo .opf não encontrado no EPUB.");

  const opfText = await opfFile.async("text");
  const opfDoc = new DOMParser().parseFromString(opfText, "text/xml");

  epubManifestItems = {};
  opfDoc.querySelectorAll("manifest > item").forEach((item) => {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    epubManifestItems[id] = {
      id,
      href,
      absPath: resolveZipPath(rootDir, href),
      mediaType: item.getAttribute("media-type") || "",
      properties: item.getAttribute("properties") || "",
    };
  });

  epubSpineIds = [];
  epubPathToSpine = {};
  opfDoc.querySelectorAll("spine > itemref").forEach((itemref) => {
    const idref = itemref.getAttribute("idref");
    if (idref && epubManifestItems[idref]) {
      const idx = epubSpineIds.length;
      epubSpineIds.push(idref);
      epubPathToSpine[epubManifestItems[idref].absPath.toLowerCase()] = idx;
    }
  });

  if (!epubSpineIds.length) throw new Error("Nenhum capítulo encontrado no spine do EPUB.");

  // 3. Carrega TOC de forma instantânea (1 arquivo) em vez de abrir todos os capítulos
  const tocMap = await parseEpubTocMap(opfDoc, rootDir);
  epubChapterTitles = epubSpineIds.map((id, i) => {
    const item = epubManifestItems[id];
    const mapped = tocMap[item.absPath.toLowerCase()];
    return mapped || `Capítulo ${i + 1}`;
  });

  // 4. Preenche o seletor TOC existente (sem recriar o nó do DOM)
  readerToc.innerHTML = epubChapterTitles
    .map((t, idx) => `<option value="${idx}">${escapeHtml(t)}</option>`)
    .join("");
  readerToc.classList.remove("hidden");
  readerTitle.classList.add("hidden");

  // 5. Decodifica progresso salvo ("chapterIndex:wordIndex")
  let targetChapter = 0;
  let targetWord = 0;
  if (typeof book.progress?.location === "string" && book.progress.location.includes(":")) {
    const [ch, wd] = book.progress.location.split(":");
    targetChapter = parseInt(ch, 10) || 0;
    targetWord = parseInt(wd, 10) || 0;
  }

  await displayEpubChapter(targetChapter, targetWord);
}

function navigateEpubHref(href) {
  const item = epubManifestItems[epubSpineIds[currentSpineIndex]];
  const chapterDir = item?.absPath.includes("/")
    ? item.absPath.substring(0, item.absPath.lastIndexOf("/") + 1)
    : "";

  const [rawPath, hash] = href.split("#");
  if (!rawPath && hash) {
    const targetEl = document.getElementById(hash);
    if (targetEl) targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  const resolved = resolveZipPath(chapterDir, rawPath).toLowerCase();
  const targetSpine = epubPathToSpine[resolved];
  if (targetSpine !== undefined) {
    stopSpeaking();
    displayEpubChapter(targetSpine, 0, hash || null);
  }
}

async function displayEpubChapter(chapterIndex, targetWordIndex = 0, targetAnchorId = null) {
  if (!epubSpineIds.length) return;
  chapterIndex = Math.min(Math.max(0, chapterIndex), epubSpineIds.length - 1);
  currentSpineIndex = chapterIndex;
  readerToc.value = String(chapterIndex);

  revokeBlobUrls();
  clearSearchHighlights();
  if (window.NeuralTTS) window.NeuralTTS.clearPrefetch();

  const id = epubSpineIds[chapterIndex];
  const item = epubManifestItems[id];
  const chapterFile = item ? findZipFile(epubZip, item.absPath) : null;
  if (!chapterFile) {
    readerFrame.innerHTML = `<p class="text-center opacity-50 py-12">Erro ao carregar o capítulo.</p>`;
    return;
  }

  showLoading("Carregando capítulo…");

  const htmlText = await chapterFile.async("text");
  const doc = new DOMParser().parseFromString(htmlText, "text/html");
  sanitizeChapterDom(doc);

  // Aproveita para melhorar o título do capítulo no TOC caso ainda seja genérico
  if (epubChapterTitles[chapterIndex] === `Capítulo ${chapterIndex + 1}`) {
    const heading = doc.querySelector("h1, h2, h3")?.textContent?.replace(/\s+/g, " ").trim();
    if (heading && heading.length <= 80) {
      epubChapterTitles[chapterIndex] = heading;
      const opt = readerToc.options[chapterIndex];
      if (opt) opt.textContent = heading;
    }
  }

  const chapterDir = item.absPath.includes("/")
    ? item.absPath.substring(0, item.absPath.lastIndexOf("/") + 1)
    : "";

  // Resolve <img> internas para Blob URLs
  for (const img of doc.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (src && !src.startsWith("data:") && !src.startsWith("http")) {
      const relPath = resolveZipPath(chapterDir, src);
      const imgFile = findZipFile(epubZip, relPath);
      if (imgFile) {
        const blob = await imgFile.async("blob");
        const blobUrl = URL.createObjectURL(blob);
        img.setAttribute("src", blobUrl);
        createdBlobUrls.push(blobUrl);
      }
    }
  }

  // Resolve <image> dentro de SVG para Blob URLs
  for (const img of doc.querySelectorAll("image")) {
    const href = img.getAttribute("href") || img.getAttribute("xlink:href");
    if (href && !href.startsWith("data:") && !href.startsWith("http")) {
      const relPath = resolveZipPath(chapterDir, href);
      const imgFile = findZipFile(epubZip, relPath);
      if (imgFile) {
        const blob = await imgFile.async("blob");
        const blobUrl = URL.createObjectURL(blob);
        img.setAttribute("href", blobUrl);
        img.setAttribute("xlink:href", blobUrl);
        createdBlobUrls.push(blobUrl);
      }
    }
  }

  readerFrame.innerHTML = `
    <div id="epub-page" class="h-full overflow-y-auto px-5 py-8 sm:px-12">
      <div id="epub-text" class="max-w-2xl mx-auto leading-relaxed epub-body-content"></div>
    </div>
  `;

  const textContainer = document.getElementById("epub-text");
  textContainer.innerHTML = doc.body.innerHTML;

  wrapWordsForTts(textContainer);

  const pageEl = document.getElementById("epub-page");
  if (targetAnchorId) {
    const anchorTarget = document.getElementById(targetAnchorId);
    if (anchorTarget) anchorTarget.scrollIntoView({ block: "start" });
    ttsCurrentIndex = 0;
  } else if (targetWordIndex > 0 && targetWordIndex < ttsWords.length) {
    ttsCurrentIndex = targetWordIndex;
    highlightWord(targetWordIndex, true);
  } else {
    pageEl.scrollTop = 0;
    ttsCurrentIndex = 0;
  }

  hideLoading();
  updateEpubProgress();
  scheduleSave();

  if (!readerSearchBar.classList.contains("hidden") && readerSearchInput.value.trim()) {
    runTextSearch(readerSearchInput.value);
  }
}

function getEpubCurrentLocation() {
  if (epubSpineIds.length) {
    return `${currentSpineIndex}:${ttsCurrentIndex}`;
  }
  return null;
}

function updateEpubProgress() {
  if (!epubSpineIds.length) return;
  const wordFraction =
    ttsWords.length > 1 ? Math.min(1, ttsCurrentIndex / (ttsWords.length - 1)) : 1;
  const rawPct = ((currentSpineIndex + wordFraction) / epubSpineIds.length) * 100;
  const percent = Math.min(100, Math.max(0, Math.round(rawPct)));

  progressLabel.textContent = `Capítulo ${currentSpineIndex + 1} de ${epubSpineIds.length}`;
  progressPercent.textContent = `${percent}%`;
  progressBar.style.width = `${percent}%`;

  if (currentBook) {
    currentBook.progress = {
      location: getEpubCurrentLocation(),
      percent,
      page: currentSpineIndex + 1,
      totalPages: epubSpineIds.length,
    };
  }
}

/* =====================================================================
   PDF — Renderização Híbrida HiDPI (Canvas + Zoom + Texto/TTS)
   ===================================================================== */

function updatePdfZoomLabel() {
  if (pdfZoomVal) pdfZoomVal.textContent = `${Math.round(pdfZoom * 100)}%`;
}

async function loadPdf(book) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const arrayBuffer =
    book.fileData instanceof Blob ? await book.fileData.arrayBuffer() : book.fileData;

  pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  pdfTotalPages = pdfDoc.numPages;

  let targetPage = book.progress?.page || 1;
  let targetWord = 0;
  if (typeof book.progress?.location === "string" && book.progress.location.includes(":")) {
    const [pg, wd] = book.progress.location.split(":");
    targetPage = parseInt(pg, 10) || targetPage;
    targetWord = parseInt(wd, 10) || 0;
  }

  readerFrame.innerHTML = `
    <div id="pdf-page" class="h-full overflow-y-auto flex flex-col items-center gap-6 px-4 sm:px-6 py-6 sm:py-8">
      <div id="pdf-canvas-container" class="relative max-w-full overflow-x-auto shadow-lg border border-black/15 rounded bg-white">
        <canvas id="pdf-canvas" class="block rounded"></canvas>
      </div>
      <div id="pdf-text" class="max-w-2xl w-full leading-relaxed bg-black/5 p-5 rounded-lg border border-black/10"></div>
    </div>
  `;

  await renderPdfPage(targetPage, targetWord);
}

async function renderPdfPage(pageNum, targetWordIndex = 0) {
  if (!pdfDoc) return;
  pageNum = Math.min(Math.max(pageNum, 1), pdfTotalPages);
  pdfCurrentPage = pageNum;
  clearSearchHighlights();
  if (window.NeuralTTS) window.NeuralTTS.clearPrefetch();

  const page = await pdfDoc.getPage(pageNum);

  // 1. Renderiza folha visual em HiDPI respeitando o zoom selecionado
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssViewport = page.getViewport({ scale: pdfZoom });
  const renderViewport = page.getViewport({ scale: pdfZoom * dpr });
  const canvas = document.getElementById("pdf-canvas");

  if (canvas) {
    const context = canvas.getContext("2d");
    canvas.width = Math.floor(renderViewport.width);
    canvas.height = Math.floor(renderViewport.height);
    canvas.style.width = `${Math.floor(cssViewport.width)}px`;
    canvas.style.maxWidth = "100%";
    canvas.style.height = "auto";

    if (pdfRenderTask) {
      try { pdfRenderTask.cancel(); } catch (_) {}
      pdfRenderTask = null;
    }

    pdfRenderTask = page.render({ canvasContext: context, viewport: renderViewport });
    try {
      await pdfRenderTask.promise;
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") {
        console.warn("Erro ao renderizar canvas do PDF:", err);
      }
    }
    pdfRenderTask = null;
  }

  // 2. Extrai e exibe o texto selecionável (quando existir)
  const textContent = await page.getTextContent();
  const lines = [];
  let currentLine = [];
  let lastY = null;

  textContent.items.forEach((item) => {
    const y = Math.round(item.transform[5]);
    if (lastY !== null && Math.abs(y - lastY) > 2) {
      lines.push(currentLine.join(" "));
      currentLine = [];
    }
    currentLine.push(item.str);
    lastY = y;
  });
  if (currentLine.length) lines.push(currentLine.join(" "));

  const container = document.getElementById("pdf-text");
  if (container) {
    const cleanLines = lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (cleanLines.length === 0) {
      container.innerHTML = "";
      container.classList.add("hidden");
      ttsWords = [];
      ttsSentences = [];
      ttsCurrentIndex = 0;
      lastHighlightedEl = null;
    } else {
      container.classList.remove("hidden");
      container.dataset.ttsWrapped = "false";
      container.innerHTML = cleanLines.map((l) => `<p class="mb-3">${escapeHtml(l)}</p>`).join("");
      wrapWordsForTts(container);
    }
  }

  const pdfPageEl = document.getElementById("pdf-page");
  if (targetWordIndex > 0 && targetWordIndex < ttsWords.length) {
    ttsCurrentIndex = targetWordIndex;
    highlightWord(targetWordIndex, true);
  } else {
    if (pdfPageEl) pdfPageEl.scrollTop = 0;
    ttsCurrentIndex = 0;
  }

  updatePdfProgress();
  scheduleSave();

  if (!readerSearchBar.classList.contains("hidden") && readerSearchInput.value.trim()) {
    runTextSearch(readerSearchInput.value);
  }
}

function goToPdfPage(n) {
  stopSpeaking();
  renderPdfPage(n, 0);
}

function updatePdfProgress() {
  if (!pdfTotalPages) return;
  const percent = Math.round((pdfCurrentPage / pdfTotalPages) * 100);
  progressLabel.textContent = `Página ${pdfCurrentPage} de ${pdfTotalPages}`;
  progressPercent.textContent = `${percent}%`;
  progressBar.style.width = `${percent}%`;

  if (currentBook) {
    currentBook.progress = {
      location: `${pdfCurrentPage}:${ttsCurrentIndex}`,
      percent,
      page: pdfCurrentPage,
      totalPages: pdfTotalPages,
    };
  }
}

/* =====================================================================
   Autosave com debounce + salvamento ao sair da aba
   ===================================================================== */

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (currentBook) patchBook(currentBook.id, { progress: currentBook.progress }).catch(() => {});
  }, 600);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (currentBook) patchBook(currentBook.id, { progress: currentBook.progress }).catch(() => {});
    releaseWakeLock();
  } else if (document.visibilityState === "visible" && ttsSpeaking) {
    requestWakeLock();
  }
});

window.addEventListener("beforeunload", () => {
  if (currentBook) patchBook(currentBook.id, { progress: currentBook.progress }).catch(() => {});
});

/* =====================================================================
   Indexação de palavras e fatiamento em frases (TTS)
   ===================================================================== */

function wrapWordsForTts(rootEl) {
  if (!rootEl || rootEl.dataset.ttsWrapped === "true") return;

  const doc = rootEl.ownerDocument || document;
  const walker = doc.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue.trim().length) textNodes.push(node);
  }

  textNodes.forEach((textNode) => {
    const frag = doc.createDocumentFragment();
    const parts = textNode.nodeValue.split(/(\s+)/);
    parts.forEach((part) => {
      if (part.trim().length === 0) {
        frag.appendChild(doc.createTextNode(part));
      } else {
        const span = doc.createElement("span");
        span.className = "tts-word";
        span.textContent = part;
        frag.appendChild(span);
      }
    });
    textNode.parentNode.replaceChild(frag, textNode);
  });

  rootEl.dataset.ttsWrapped = "true";
  rebuildTtsIndex(rootEl);
}

function rebuildTtsIndex(rootEl) {
  const spans = Array.from(rootEl.querySelectorAll(".tts-word"));
  ttsWords = spans.map((el, idx) => {
    el.dataset.wordIdx = String(idx);
    const paraEl = el.closest("p, li, h1, h2, h3, h4, h5, h6, blockquote, div");
    return { el, text: el.textContent, paraEl };
  });

  // Agrupa palavras em frases curtas (evita corte de 15s no Chrome e acelera o Piper Neural)
  ttsSentences = [];
  let start = 0;
  let charCount = 0;

  const flushSentence = (endIdx) => {
    if (endIdx < start) return;
    const offsets = [];
    const parts = [];
    let acc = 0;
    for (let i = start; i <= endIdx; i++) {
      offsets.push(acc);
      parts.push(ttsWords[i].text);
      acc += ttsWords[i].text.length + 1;
    }
    ttsSentences.push({
      startIdx: start,
      endIdx,
      text: parts.join(" "),
      offsets,
    });
  };

  for (let i = 0; i < ttsWords.length; i++) {
    const word = ttsWords[i];
    const next = ttsWords[i + 1];
    charCount += word.text.length + 1;

    const endsPunct = /[.!?…:;]["”’»)]*$/.test(word.text);
    const paraChanged = next && next.paraEl !== word.paraEl;
    const tooLong = charCount >= 220 && /[,;—–-]$/.test(word.text);
    const hardLimit = charCount >= 280;

    if (endsPunct || paraChanged || tooLong || hardLimit || !next) {
      flushSentence(i);
      start = i + 1;
      charCount = 0;
    }
  }

  ttsCurrentIndex = 0;
  lastHighlightedEl = null;
  activeSentenceEls = [];
}

function findSentenceIndexForWord(wordIdx) {
  let lo = 0;
  let hi = ttsSentences.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = ttsSentences[mid];
    if (wordIdx < s.startIdx) hi = mid - 1;
    else if (wordIdx > s.endIdx) lo = mid + 1;
    else return mid;
  }
  return 0;
}

/** Busca binária O(log k) de charIndex dentro da frase atual. */
function findWordOffsetInSentence(offsets, charIndex) {
  let lo = 0;
  let hi = offsets.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= charIndex) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/* ---- Destaque O(1) + rolagem suave inteligente ---- */
function highlightWord(index, forceScroll = false) {
  if (lastHighlightedEl) {
    lastHighlightedEl.classList.remove("tts-highlight");
    lastHighlightedEl = null;
  }

  const wordObj = ttsWords[index];
  if (!wordObj || !wordObj.el) return;

  const el = wordObj.el;
  el.classList.add("tts-highlight");
  lastHighlightedEl = el;

  // Só faz scroll se forçado ou se a palavra saiu da faixa confortável da tela
  const rect = el.getBoundingClientRect();
  const frameRect = readerFrame.getBoundingClientRect();
  const margin = frameRect.height * 0.22;
  if (
    forceScroll ||
    rect.top < frameRect.top + margin ||
    rect.bottom > frameRect.bottom - margin
  ) {
    el.scrollIntoView({ behavior: forceScroll ? "auto" : "smooth", block: "center" });
  }

  if (currentType === "epub") {
    updateEpubProgress();
    scheduleSave();
  } else if (currentType === "pdf") {
    updatePdfProgress();
    scheduleSave();
  }
}

function highlightActiveSentence(startIdx, endIdx) {
  clearSentenceHighlight();
  for (let i = startIdx; i <= endIdx && i < ttsWords.length; i++) {
    const el = ttsWords[i].el;
    el.classList.add("tts-sentence-active");
    activeSentenceEls.push(el);
  }
}

function clearSentenceHighlight() {
  for (const el of activeSentenceEls) {
    el.classList.remove("tts-sentence-active");
  }
  activeSentenceEls = [];
}

function clearHighlight() {
  if (lastHighlightedEl) {
    lastHighlightedEl.classList.remove("tts-highlight");
    lastHighlightedEl = null;
  }
  clearSentenceHighlight();
}

/* =====================================================================
   Seleção inteligente de vozes do navegador (prioriza neurais pt-BR)
   ===================================================================== */

function scorePortugueseVoice(v) {
  const lang = (v.lang || "").toLowerCase();
  const name = (v.name || "").toLowerCase();
  let score = 0;

  if (lang === "pt-br") score += 100;
  else if (lang.startsWith("pt")) score += 40;
  else return -1;

  // Prioriza vozes neurais/naturais disponíveis no Edge, Chrome, macOS/iOS e Android
  if (name.includes("natural") || name.includes("neural")) score += 80;
  if (name.includes("online")) score += 40;
  if (name.includes("francisca") || name.includes("antonio") || name.includes("thalita")) score += 50;
  if (name.includes("google")) score += 35;
  if (name.includes("enhanced") || name.includes("premium") || name.includes("luciana") || name.includes("felipe")) score += 30;
  if (v.localService) score += 5;

  return score;
}

function getSortedPortugueseVoices() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const ptVoices = voices
    .map((v) => ({ v, score: scorePortugueseVoice(v) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.v);
  return ptVoices.length ? ptVoices : voices;
}

function populateBrowserVoiceSelect() {
  if (!ttsVoiceSelect) return;
  const voices = getSortedPortugueseVoices();
  if (!voices.length) {
    ttsVoiceSelect.innerHTML = `<option value="">Padrão do sistema (pt-BR)</option>`;
    return;
  }

  ttsVoiceSelect.innerHTML = voices
    .map((v) => {
      const tag = /natural|neural|online/i.test(v.name) ? " ★" : "";
      return `<option value="${escapeHtml(v.voiceURI)}">${escapeHtml(v.name)} (${escapeHtml(v.lang)})${tag}</option>`;
    })
    .join("");

  // Restaura escolha salva ou seleciona a melhor voz ranqueada
  const chosen =
    voices.find((v) => v.voiceURI === selectedBrowserVoiceURI) || voices[0];
  if (chosen) {
    cachedVoice = chosen;
    selectedBrowserVoiceURI = chosen.voiceURI;
    ttsVoiceSelect.value = chosen.voiceURI;
  }
}

function initBrowserVoiceList() {
  if (!("speechSynthesis" in window)) return;
  populateBrowserVoiceSelect();
  window.speechSynthesis.addEventListener?.("voiceschanged", populateBrowserVoiceSelect);
}

function pickPortugueseVoice() {
  if (cachedVoice) return Promise.resolve(cachedVoice);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      populateBrowserVoiceSelect();
      resolve(cachedVoice || getSortedPortugueseVoices()[0] || null);
    };

    const existing = window.speechSynthesis?.getVoices?.() || [];
    if (existing.length) return finish();

    const timer = setTimeout(finish, 1200);
    window.speechSynthesis.onvoiceschanged = () => {
      clearTimeout(timer);
      finish();
    };
  });
}

/* =====================================================================
   Reprodução TTS Híbrida (Navegador fatiado + Neural Piper Offline)
   ===================================================================== */

function setTtsButtonState(state) {
  // state: "idle" | "playing" | "loading"
  iconPlay.classList.toggle("hidden", state !== "idle");
  iconPause.classList.toggle("hidden", state !== "playing");
  iconTtsLoading.classList.toggle("hidden", state !== "loading");
  updateMediaSessionPlaybackState(state === "idle" ? "paused" : "playing");
}

function stopNeuralAudioOnly() {
  if (neuralHighlightRaf) {
    cancelAnimationFrame(neuralHighlightRaf);
    neuralHighlightRaf = null;
  }
  if (neuralAudio) {
    neuralAudio.onended = null;
    neuralAudio.onerror = null;
    try { neuralAudio.pause(); } catch (_) {}
    neuralAudio = null;
  }
  if (neuralAudioUrl) {
    URL.revokeObjectURL(neuralAudioUrl);
    neuralAudioUrl = null;
  }
}

async function speakFrom(startIndex) {
  if (!ttsWords.length) {
    showToast("Esta página não possui texto selecionável para narração.");
    return;
  }

  ttsSessionId++;
  const session = ttsSessionId;

  window.speechSynthesis?.cancel?.();
  stopNeuralAudioOnly();

  ttsCurrentIndex = Math.min(Math.max(0, startIndex), ttsWords.length - 1);
  ttsSpeaking = true;
  requestWakeLock();

  if (ttsEngine === "neural" && window.NeuralTTS?.isSupported()) {
    await speakSentenceNeural(session, ttsCurrentIndex);
  } else {
    await speakSentenceBrowser(session, ttsCurrentIndex);
  }
}

/** Modo 1: Web Speech API fatiada por frase (sem cortes no Chrome/Android). */
async function speakSentenceBrowser(session, wordStartIndex) {
  if (session !== ttsSessionId || !ttsSpeaking) return;

  const sentIdx = findSentenceIndexForWord(wordStartIndex);
  const sentence = ttsSentences[sentIdx];
  if (!sentence) {
    advancePageAndContinueSpeaking(session);
    return;
  }

  const voice = await pickPortugueseVoice();
  if (session !== ttsSessionId || !ttsSpeaking) return;

  // Constrói o texto a partir de wordStartIndex até o fim desta frase
  const sliceStart = Math.max(sentence.startIdx, wordStartIndex);
  const localOffsets = [];
  const parts = [];
  let acc = 0;
  for (let i = sliceStart; i <= sentence.endIdx; i++) {
    localOffsets.push(acc);
    parts.push(ttsWords[i].text);
    acc += ttsWords[i].text.length + 1;
  }
  const text = parts.join(" ");

  highlightActiveSentence(sentence.startIdx, sentence.endIdx);
  highlightWord(sliceStart);

  ttsUtterance = new SpeechSynthesisUtterance(text);
  ttsUtterance.lang = voice?.lang || "pt-BR";
  if (voice) ttsUtterance.voice = voice;
  ttsUtterance.rate = parseFloat(ttsSpeed.value || "2");

  ttsUtterance.onboundary = (event) => {
    if (session !== ttsSessionId || !ttsSpeaking) return;
    if (event.name && event.name !== "word") return;
    const relIdx = findWordOffsetInSentence(localOffsets, event.charIndex);
    ttsCurrentIndex = sliceStart + relIdx;
    highlightWord(ttsCurrentIndex);
  };

  ttsUtterance.onend = () => {
    if (session !== ttsSessionId || !ttsSpeaking) return;
    const nextWordIdx = sentence.endIdx + 1;
    if (nextWordIdx < ttsWords.length) {
      ttsCurrentIndex = nextWordIdx;
      speakSentenceBrowser(session, nextWordIdx);
    } else {
      advancePageAndContinueSpeaking(session);
    }
  };

  ttsUtterance.onerror = (event) => {
    if (session !== ttsSessionId) return;
    if (event.error === "canceled" || event.error === "interrupted") return;
    console.warn("Erro na Web Speech API:", event.error);
    stopSpeaking();
  };

  setTtsButtonState("playing");
  window.speechSynthesis.speak(ttsUtterance);
}

/** Modo 2: Piper Neural Offline (ONNX/WASM) com pré-síntese da frase seguinte. */
async function speakSentenceNeural(session, wordStartIndex) {
  if (session !== ttsSessionId || !ttsSpeaking) return;

  const sentIdx = findSentenceIndexForWord(wordStartIndex);
  const sentence = ttsSentences[sentIdx];
  if (!sentence) {
    advancePageAndContinueSpeaking(session);
    return;
  }

  const sliceStart = Math.max(sentence.startIdx, wordStartIndex);
  const sliceWords = ttsWords.slice(sliceStart, sentence.endIdx + 1);
  const text = sliceWords.map((w) => w.text).join(" ");

  highlightActiveSentence(sentence.startIdx, sentence.endIdx);
  highlightWord(sliceStart);
  setTtsButtonState("loading");

  try {
    // Dispara pré-síntese da frase seguinte em paralelo (leitura sem pausas!)
    const nextSent = ttsSentences[sentIdx + 1];
    if (nextSent) {
      window.NeuralTTS.prefetch(nextSent.text, selectedNeuralVoiceId);
    }

    const wavBlob = await window.NeuralTTS.synthesize(text, selectedNeuralVoiceId);
    if (session !== ttsSessionId || !ttsSpeaking) return;

    if (!wavBlob) {
      const nextWordIdx = sentence.endIdx + 1;
      if (nextWordIdx < ttsWords.length) speakSentenceNeural(session, nextWordIdx);
      else advancePageAndContinueSpeaking(session);
      return;
    }

    stopNeuralAudioOnly();
    neuralAudioUrl = URL.createObjectURL(wavBlob);
    neuralAudio = new Audio(neuralAudioUrl);
    neuralAudio.preservesPitch = true;
    neuralAudio.playbackRate = parseFloat(ttsSpeed.value || "2");

    // Pré-calcula pesos cumulativos por caracteres para estimar palavra ativa no áudio
    const cumWeights = [];
    let totalChars = 0;
    for (const w of sliceWords) {
      totalChars += Math.max(1, w.text.length) + 1;
      cumWeights.push(totalChars);
    }

    const trackHighlight = () => {
      if (session !== ttsSessionId || !ttsSpeaking || !neuralAudio) return;
      if (neuralAudio.duration > 0 && Number.isFinite(neuralAudio.duration)) {
        const ratio = Math.min(0.999, Math.max(0, neuralAudio.currentTime / neuralAudio.duration));
        const targetChar = ratio * totalChars;
        let rel = 0;
        while (rel < cumWeights.length - 1 && cumWeights[rel] < targetChar) rel++;
        const wordIdx = sliceStart + rel;
        if (wordIdx !== ttsCurrentIndex) {
          ttsCurrentIndex = wordIdx;
          highlightWord(wordIdx);
        }
      }
      neuralHighlightRaf = requestAnimationFrame(trackHighlight);
    };

    neuralAudio.onended = () => {
      if (session !== ttsSessionId || !ttsSpeaking) return;
      stopNeuralAudioOnly();
      const nextWordIdx = sentence.endIdx + 1;
      if (nextWordIdx < ttsWords.length) {
        ttsCurrentIndex = nextWordIdx;
        speakSentenceNeural(session, nextWordIdx);
      } else {
        advancePageAndContinueSpeaking(session);
      }
    };

    neuralAudio.onerror = () => {
      if (session !== ttsSessionId) return;
      showToast("Falha no áudio neural; alternando para voz do navegador.");
      setTtsEngine("browser");
      speakSentenceBrowser(session, sliceStart);
    };

    setTtsButtonState("playing");
    await neuralAudio.play();
    neuralHighlightRaf = requestAnimationFrame(trackHighlight);
  } catch (err) {
    if (session !== ttsSessionId) return;
    console.warn("Erro no motor Neural Piper:", err);
    showToast("Motor neural indisponível (offline ou erro). Usando voz do navegador.");
    setTtsEngine("browser");
    speakSentenceBrowser(session, sliceStart);
  }
}

async function advancePageAndContinueSpeaking(session) {
  if (session !== ttsSessionId || !ttsSpeaking) return;

  if (currentType === "epub") {
    if (currentSpineIndex >= epubSpineIds.length - 1) {
      stopSpeaking();
      showToast("Fim do livro!");
      return;
    }
    await displayEpubChapter(currentSpineIndex + 1, 0);
    if (session === ttsSessionId && ttsSpeaking) {
      speakFrom(0);
    }
  } else if (currentType === "pdf") {
    if (pdfCurrentPage >= pdfTotalPages) {
      stopSpeaking();
      showToast("Fim do documento!");
      return;
    }
    await renderPdfPage(pdfCurrentPage + 1, 0);
    if (session === ttsSessionId && ttsSpeaking) {
      if (ttsWords.length > 0) speakFrom(0);
      else advancePageAndContinueSpeaking(session); // pula página escaneada sem texto
    }
  }
}

function stopSpeaking() {
  ttsSessionId++;
  ttsSpeaking = false;
  window.speechSynthesis?.cancel?.();
  stopNeuralAudioOnly();
  clearHighlight();
  setTtsButtonState("idle");
  releaseWakeLock();
}

/* =====================================================================
   Controles do Player (Play/Pause, Páginas, Parágrafos, Velocidade)
   ===================================================================== */

btnTtsToggle.addEventListener("click", () => {
  if (ttsSpeaking) {
    stopSpeaking();
  } else {
    speakFrom(ttsCurrentIndex || 0);
  }
});

document.getElementById("btn-prev-page").addEventListener("click", () => {
  if (currentType === "epub") {
    stopSpeaking();
    displayEpubChapter(currentSpineIndex - 1);
  } else if (currentType === "pdf") {
    goToPdfPage(pdfCurrentPage - 1);
  }
});

document.getElementById("btn-next-page").addEventListener("click", () => {
  if (currentType === "epub") {
    stopSpeaking();
    displayEpubChapter(currentSpineIndex + 1);
  } else if (currentType === "pdf") {
    goToPdfPage(pdfCurrentPage + 1);
  }
});

function skipParagraph(direction) {
  if (!ttsWords.length) return;
  const currentWordObj = ttsWords[ttsCurrentIndex];
  if (!currentWordObj || !currentWordObj.el) return;

  const container =
    document.getElementById("epub-text") || document.getElementById("pdf-text");
  if (!container) return;

  const currentPara = currentWordObj.el.closest("p, li, h1, h2, h3, h4, h5, h6, blockquote");
  if (!currentPara) {
    ttsSkipWords(direction * 15);
    return;
  }

  const allParas = Array.from(
    container.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, blockquote")
  ).filter((p) => p.querySelector(".tts-word"));

  const currentParaIndex = allParas.indexOf(currentPara);
  if (currentParaIndex === -1) {
    ttsSkipWords(direction * 15);
    return;
  }

  const targetParaIndex = currentParaIndex + direction;
  if (targetParaIndex < 0) {
    ttsCurrentIndex = 0;
  } else if (targetParaIndex >= allParas.length) {
    ttsCurrentIndex = ttsWords.length - 1;
  } else {
    const firstWord = allParas[targetParaIndex].querySelector(".tts-word");
    const idx = firstWord ? parseInt(firstWord.dataset.wordIdx, 10) : -1;
    if (!Number.isNaN(idx) && idx >= 0) ttsCurrentIndex = idx;
  }

  if (ttsSpeaking) speakFrom(ttsCurrentIndex);
  else highlightWord(ttsCurrentIndex, true);
}

function ttsSkipWords(count) {
  ttsCurrentIndex = Math.max(0, Math.min(ttsWords.length - 1, ttsCurrentIndex + count));
  if (ttsSpeaking) speakFrom(ttsCurrentIndex);
  else highlightWord(ttsCurrentIndex, true);
}

document.getElementById("btn-tts-prev").addEventListener("click", () => skipParagraph(-1));
document.getElementById("btn-tts-next").addEventListener("click", () => skipParagraph(1));

// Marcador manual (Bookmark) com Toast visível em EPUB e PDF
if (btnBookmark) {
  btnBookmark.addEventListener("click", async () => {
    if (!currentBook) return;

    if (currentType === "epub") updateEpubProgress();
    else if (currentType === "pdf") updatePdfProgress();

    await patchBook(currentBook.id, { progress: currentBook.progress });

    if (iconBookmark) iconBookmark.setAttribute("fill", "currentColor");
    showToast("🔖 Marcador salvo neste trecho!");

    setTimeout(() => {
      if (iconBookmark) iconBookmark.setAttribute("fill", "none");
    }, 1500);
  });
}

ttsSpeed.addEventListener("input", () => {
  const val = parseFloat(ttsSpeed.value);
  ttsSpeedVal.textContent = `${val.toFixed(1)}x`;
  localStorage.setItem(STORAGE_SPEED_KEY, String(val));
  // No modo Neural, a velocidade muda em tempo real sem reiniciar a frase!
  if (neuralAudio) {
    neuralAudio.playbackRate = val;
  }
});

ttsSpeed.addEventListener("change", () => {
  if (ttsSpeaking && ttsEngine === "browser") {
    speakFrom(ttsCurrentIndex);
  }
});

/* =====================================================================
   Configurações de Motor de Voz (Navegador vs. Piper Neural Offline)
   ===================================================================== */

function setTtsEngine(engine) {
  ttsEngine = engine === "neural" ? "neural" : "browser";
  localStorage.setItem(STORAGE_ENGINE_KEY, ttsEngine);
  syncTtsEngineUI();
  if (ttsEngine === "neural") {
    refreshNeuralVoicePanel();
  }
}

function syncTtsEngineUI() {
  document.querySelectorAll(".tts-engine-opt").forEach((b) =>
    b.classList.toggle("ring-2", b.dataset.engine === ttsEngine)
  );
  browserVoicePanel?.classList.toggle("hidden", ttsEngine !== "browser");
  neuralVoicePanel?.classList.toggle("hidden", ttsEngine !== "neural");
  ttsEngineBadge?.classList.toggle("hidden", ttsEngine !== "neural");
}

async function refreshNeuralVoicePanel() {
  if (!window.NeuralTTS || !window.NeuralTTS.isSupported()) {
    if (neuralCacheStatus) neuralCacheStatus.textContent = "Não suportado";
    if (btnDownloadNeural) btnDownloadNeural.disabled = true;
    return;
  }

  try {
    if (!neuralVoicesInitialized) {
      neuralVoicesInitialized = true;
      const voices = await window.NeuralTTS.listPtBrVoices();
      if (neuralVoiceSelect && voices.length) {
        neuralVoiceSelect.innerHTML = voices
          .map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.label)}</option>`)
          .join("");
        if (voices.some((v) => v.id === selectedNeuralVoiceId)) {
          neuralVoiceSelect.value = selectedNeuralVoiceId;
        } else {
          selectedNeuralVoiceId = voices[0].id;
          neuralVoiceSelect.value = selectedNeuralVoiceId;
        }
      }
    }

    const stored = await window.NeuralTTS.getStoredVoices();
    const isCached = stored.includes(selectedNeuralVoiceId);
    if (neuralCacheStatus) {
      neuralCacheStatus.textContent = isCached ? "Pronto offline ✓" : "Não baixado";
      neuralCacheStatus.className = isCached
        ? "text-[10px] px-2 py-0.5 rounded-full bg-[var(--verdigris)]/25 text-[var(--verdigris)] font-medium"
        : "text-[10px] px-2 py-0.5 rounded-full bg-white/10";
    }
    if (btnDownloadNeural) {
      btnDownloadNeural.textContent = isCached ? "Testar" : "Baixar";
    }
  } catch (err) {
    console.warn("Erro ao consultar painel neural:", err);
  }
}

document.querySelectorAll(".tts-engine-opt").forEach((btn) => {
  btn.addEventListener("click", () => {
    const wasSpeaking = ttsSpeaking;
    if (wasSpeaking) stopSpeaking();
    setTtsEngine(btn.dataset.engine);
    if (wasSpeaking) speakFrom(ttsCurrentIndex);
  });
});

if (ttsVoiceSelect) {
  ttsVoiceSelect.addEventListener("change", () => {
    selectedBrowserVoiceURI = ttsVoiceSelect.value;
    localStorage.setItem(STORAGE_VOICE_URI_KEY, selectedBrowserVoiceURI);
    cachedVoice =
      getSortedPortugueseVoices().find((v) => v.voiceURI === selectedBrowserVoiceURI) || null;
    if (ttsSpeaking && ttsEngine === "browser") speakFrom(ttsCurrentIndex);
  });
}

if (btnTestVoice) {
  btnTestVoice.addEventListener("click", async () => {
    window.speechSynthesis?.cancel?.();
    const voice = await pickPortugueseVoice();
    const sample = new SpeechSynthesisUtterance("Olá! Esta é uma amostra da voz selecionada na Estante.");
    sample.lang = voice?.lang || "pt-BR";
    if (voice) sample.voice = voice;
    sample.rate = parseFloat(ttsSpeed.value || "2");
    window.speechSynthesis.speak(sample);
  });
}

if (neuralVoiceSelect) {
  neuralVoiceSelect.addEventListener("change", () => {
    selectedNeuralVoiceId = neuralVoiceSelect.value;
    localStorage.setItem(STORAGE_NEURAL_VOICE_KEY, selectedNeuralVoiceId);
    window.NeuralTTS?.clearPrefetch();
    refreshNeuralVoicePanel();
  });
}

if (btnDownloadNeural) {
  btnDownloadNeural.addEventListener("click", async () => {
    if (!window.NeuralTTS) return;
    const stored = await window.NeuralTTS.getStoredVoices();
    const isCached = stored.includes(selectedNeuralVoiceId);

    if (isCached) {
      btnDownloadNeural.disabled = true;
      btnDownloadNeural.textContent = "Gerando…";
      try {
        const blob = await window.NeuralTTS.synthesize(
          "Olá! A voz neural em português brasileiro está pronta para leitura offline.",
          selectedNeuralVoiceId
        );
        if (blob) {
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.playbackRate = parseFloat(ttsSpeed.value || "2");
          audio.onended = () => URL.revokeObjectURL(url);
          audio.play();
        }
      } catch (err) {
        showToast("Erro ao testar voz neural.");
      } finally {
        btnDownloadNeural.disabled = false;
        btnDownloadNeural.textContent = "Testar";
      }
      return;
    }

    btnDownloadNeural.disabled = true;
    neuralProgressWrap?.classList.remove("hidden");
    neuralProgressLabel.textContent = "Baixando modelo neural…";
    neuralProgressPct.textContent = "0%";
    neuralProgressBar.style.width = "0%";

    try {
      await window.NeuralTTS.downloadVoice(selectedNeuralVoiceId, ({ percent }) => {
        neuralProgressPct.textContent = `${percent}%`;
        neuralProgressBar.style.width = `${percent}%`;
      });
      showToast("🎙️ Voz neural pt-BR pronta para uso offline!");
      await refreshNeuralVoicePanel();
    } catch (err) {
      console.error("Falha ao baixar voz neural:", err);
      showToast("Não foi possível baixar o modelo neural. Verifique sua conexão.");
    } finally {
      btnDownloadNeural.disabled = false;
      neuralProgressWrap?.classList.add("hidden");
    }
  });
}

/* =====================================================================
   Media Session API (Tela de bloqueio / Fone Bluetooth) & Wake Lock
   ===================================================================== */

function updateMediaSessionMetadata() {
  if (!("mediaSession" in navigator) || !currentBook) return;
  try {
    const artwork = currentBook.cover
      ? [{ src: currentBook.cover, sizes: "512x512" }]
      : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentBook.title || "Estante",
      artist: currentBook.author || "Estante Leitor Digital",
      album: currentType === "epub" ? "EPUB" : "PDF",
      artwork,
    });

    navigator.mediaSession.setActionHandler("play", () => {
      if (!ttsSpeaking) speakFrom(ttsCurrentIndex || 0);
    });
    navigator.mediaSession.setActionHandler("pause", () => stopSpeaking());
    navigator.mediaSession.setActionHandler("previoustrack", () => skipParagraph(-1));
    navigator.mediaSession.setActionHandler("nexttrack", () => skipParagraph(1));
  } catch (_) {}
}

function updateMediaSessionPlaybackState(state) {
  if ("mediaSession" in navigator) {
    try { navigator.mediaSession.playbackState = state; } catch (_) {}
  }
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || wakeLockSentinel) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
    wakeLockSentinel.addEventListener("release", () => {
      wakeLockSentinel = null;
    });
  } catch (_) {}
}

function releaseWakeLock() {
  if (wakeLockSentinel) {
    wakeLockSentinel.release().catch(() => {});
    wakeLockSentinel = null;
  }
}

/* =====================================================================
   Temporizador de Sono (Sleep Timer)
   ===================================================================== */

function setSleepTimer(minutes) {
  clearSleepTimer();
  syncSleepButtons(minutes);
  if (!minutes || minutes <= 0) {
    showToast("Temporizador de sono desativado.");
    return;
  }

  sleepTimerEndsAt = Date.now() + minutes * 60 * 1000;
  updateSleepBadge();
  sleepTimerBadge?.classList.remove("hidden");
  showToast(`⏱️ Narração pausará em ${minutes} min.`);

  sleepTimerInterval = setInterval(() => {
    const remainingMs = sleepTimerEndsAt - Date.now();
    if (remainingMs <= 0) {
      clearSleepTimer();
      if (ttsSpeaking) stopSpeaking();
      showToast("🌙 Temporizador encerrado. Boa noite!");
    } else {
      updateSleepBadge();
    }
  }, 1000);
}

function updateSleepBadge() {
  if (!sleepTimerBadge || !sleepTimerEndsAt) return;
  const totalSec = Math.max(0, Math.ceil((sleepTimerEndsAt - Date.now()) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  sleepTimerBadge.textContent = `⏱ ${m}:${String(s).padStart(2, "0")}`;
}

function clearSleepTimer() {
  if (sleepTimerInterval) {
    clearInterval(sleepTimerInterval);
    sleepTimerInterval = null;
  }
  sleepTimerEndsAt = 0;
  sleepTimerBadge?.classList.add("hidden");
  syncSleepButtons(0);
}

function syncSleepButtons(activeMin) {
  document.querySelectorAll(".sleep-opt").forEach((b) =>
    b.classList.toggle("ring-2", parseInt(b.dataset.sleep, 10) === activeMin)
  );
}

document.querySelectorAll(".sleep-opt").forEach((btn) => {
  btn.addEventListener("click", () => setSleepTimer(parseInt(btn.dataset.sleep, 10) || 0));
});
syncSleepButtons(0);

/* =====================================================================
   Busca no texto do capítulo / página atual
   ===================================================================== */

function clearSearchHighlights() {
  for (const el of searchMatches) {
    el.classList.remove("search-hit", "search-hit-current");
  }
  searchMatches = [];
  searchMatchIndex = -1;
  if (readerSearchCount) readerSearchCount.textContent = "0/0";
}

function runTextSearch(query) {
  clearSearchHighlights();
  const term = (query || "").trim().toLowerCase();
  if (!term) return;

  for (const w of ttsWords) {
    if (w.text.toLowerCase().includes(term)) {
      w.el.classList.add("search-hit");
      searchMatches.push(w.el);
    }
  }

  if (searchMatches.length > 0) {
    jumpToSearchMatch(0);
  }
}

function jumpToSearchMatch(idx) {
  if (!searchMatches.length) return;
  if (searchMatchIndex >= 0 && searchMatches[searchMatchIndex]) {
    searchMatches[searchMatchIndex].classList.remove("search-hit-current");
  }
  searchMatchIndex = (idx + searchMatches.length) % searchMatches.length;
  const el = searchMatches[searchMatchIndex];
  el.classList.add("search-hit-current");
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  readerSearchCount.textContent = `${searchMatchIndex + 1}/${searchMatches.length}`;
}

function openSearchBar() {
  readerSearchBar.classList.remove("hidden");
  readerSearchInput.focus();
  readerSearchInput.select();
}

function closeSearchBar() {
  readerSearchBar.classList.add("hidden");
  readerSearchInput.value = "";
  clearSearchHighlights();
}

btnSearchText?.addEventListener("click", () => {
  if (readerSearchBar.classList.contains("hidden")) openSearchBar();
  else closeSearchBar();
});
readerSearchInput?.addEventListener("input", () => runTextSearch(readerSearchInput.value));
readerSearchInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    jumpToSearchMatch(searchMatchIndex + (e.shiftKey ? -1 : 1));
  } else if (e.key === "Escape") {
    closeSearchBar();
  }
});
document.getElementById("btn-search-prev")?.addEventListener("click", () => jumpToSearchMatch(searchMatchIndex - 1));
document.getElementById("btn-search-next")?.addEventListener("click", () => jumpToSearchMatch(searchMatchIndex + 1));
document.getElementById("btn-search-close")?.addEventListener("click", closeSearchBar);

/* =====================================================================
   Atalhos de teclado no leitor
   ===================================================================== */

document.addEventListener("keydown", (e) => {
  if (viewReader.classList.contains("hidden")) return;

  const tag = (document.activeElement?.tagName || "").toLowerCase();
  const inInput = tag === "input" || tag === "textarea" || tag === "select";

  // Ctrl+F abre a busca interna do leitor
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    openSearchBar();
    return;
  }

  if (e.key === "Escape") {
    if (!modalCoverFull.classList.contains("hidden")) closeCoverModal();
    else if (!modalA11y.classList.contains("hidden")) modalA11y.classList.add("hidden");
    else if (!readerSearchBar.classList.contains("hidden")) closeSearchBar();
    return;
  }

  if (inInput) return;

  if (e.code === "Space") {
    e.preventDefault();
    if (ttsSpeaking) stopSpeaking();
    else speakFrom(ttsCurrentIndex || 0);
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (e.shiftKey) skipParagraph(-1);
    else if (currentType === "epub") { stopSpeaking(); displayEpubChapter(currentSpineIndex - 1); }
    else if (currentType === "pdf") goToPdfPage(pdfCurrentPage - 1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    if (e.shiftKey) skipParagraph(1);
    else if (currentType === "epub") { stopSpeaking(); displayEpubChapter(currentSpineIndex + 1); }
    else if (currentType === "pdf") goToPdfPage(pdfCurrentPage + 1);
  }
});

/* =====================================================================
   Menu de acessibilidade — tema, fonte, tamanho, zoom PDF e capa cheia
   ===================================================================== */

btnA11y.addEventListener("click", () => {
  modalA11y.classList.remove("hidden");
  populateBrowserVoiceSelect();
  if (ttsEngine === "neural") refreshNeuralVoicePanel();
});
btnCloseA11y.addEventListener("click", () => modalA11y.classList.add("hidden"));
modalA11y.addEventListener("click", (e) => {
  if (e.target === modalA11y) modalA11y.classList.add("hidden");
});

function applyTheme(theme) {
  viewReader.classList.remove("theme-claro", "theme-sepia", "theme-escuro");
  viewReader.classList.add(`theme-${theme}`);
}

function applyFont(fontKey) {
  viewReader.classList.remove("font-sans-reader", "font-serif-reader");
  viewReader.classList.add(fontKey === "serif" ? "font-serif-reader" : "font-sans-reader");
}

function applyFontSize(px) {
  viewReader.style.fontSize = `${px}px`;
  document.getElementById("font-size-val").textContent = `${px}px`;
}

function syncA11yButtons(prefs) {
  document.querySelectorAll(".theme-opt").forEach((b) =>
    b.classList.toggle("ring-2", b.dataset.theme === prefs.theme)
  );
  document.querySelectorAll(".font-opt").forEach((b) =>
    b.classList.toggle("ring-2", b.dataset.font === prefs.font)
  );
}

document.querySelectorAll(".theme-opt").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!currentBook) return;
    currentBook.prefs.theme = btn.dataset.theme;
    applyTheme(btn.dataset.theme);
    syncA11yButtons(currentBook.prefs);
    patchBook(currentBook.id, { prefs: currentBook.prefs });
  });
});

document.querySelectorAll(".font-opt").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!currentBook) return;
    currentBook.prefs.font = btn.dataset.font;
    applyFont(btn.dataset.font);
    syncA11yButtons(currentBook.prefs);
    patchBook(currentBook.id, { prefs: currentBook.prefs });
  });
});

document.getElementById("font-inc").addEventListener("click", () => {
  if (!currentBook) return;
  currentBook.prefs.fontSize = Math.min(32, currentBook.prefs.fontSize + 2);
  applyFontSize(currentBook.prefs.fontSize);
  patchBook(currentBook.id, { prefs: currentBook.prefs });
});

document.getElementById("font-dec").addEventListener("click", () => {
  if (!currentBook) return;
  currentBook.prefs.fontSize = Math.max(12, currentBook.prefs.fontSize - 2);
  applyFontSize(currentBook.prefs.fontSize);
  patchBook(currentBook.id, { prefs: currentBook.prefs });
});

// Zoom do PDF
function applyPdfZoom(nextZoom) {
  if (!currentBook || currentType !== "pdf") return;
  pdfZoom = Math.min(2.5, Math.max(0.75, Math.round(nextZoom * 100) / 100));
  currentBook.prefs.pdfZoom = pdfZoom;
  updatePdfZoomLabel();
  patchBook(currentBook.id, { prefs: currentBook.prefs });
  renderPdfPage(pdfCurrentPage, ttsCurrentIndex);
}

document.getElementById("pdf-zoom-inc")?.addEventListener("click", () => applyPdfZoom(pdfZoom + 0.25));
document.getElementById("pdf-zoom-dec")?.addEventListener("click", () => applyPdfZoom(pdfZoom - 0.25));
document.getElementById("pdf-zoom-reset")?.addEventListener("click", () => applyPdfZoom(1.5));

// Modal da capa em tamanho cheio
if (readerCoverThumb) {
  readerCoverThumb.addEventListener("click", () => {
    if (currentBook && currentBook.cover && modalCoverFull && imgCoverFull) {
      imgCoverFull.src = currentBook.cover;
      modalCoverFull.classList.remove("hidden");
    }
  });
}

function closeCoverModal() {
  if (modalCoverFull) modalCoverFull.classList.add("hidden");
  if (imgCoverFull) imgCoverFull.src = "";
}

modalCoverFull?.addEventListener("click", (e) => {
  if (e.target === modalCoverFull) closeCoverModal();
});
btnCloseCover?.addEventListener("click", closeCoverModal);

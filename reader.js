/* =====================================================================
   reader.js — Renderização do livro + Text-to-Speech (Web Speech API)
   ---------------------------------------------------------------------
   Este arquivo assume o controle assim que o usuário abre um livro na
   Estante (app.js chama openReader(bookId)). Ele decide, pelo tipo do
   arquivo, se usa epub.js (EPUB) ou pdf.js (PDF), e depois expõe uma
   camada comum de: tema, fonte, progresso e narração por voz.
   ===================================================================== */

/* ---- Elementos da UI do leitor ---- */
const viewLibrary = document.getElementById("view-library");
const viewReader = document.getElementById("view-reader");
const readerFrame = document.getElementById("reader-frame");
const readerTitle = document.getElementById("reader-title");
const btnBack = document.getElementById("btn-back");
const btnA11y = document.getElementById("btn-a11y");
const modalA11y = document.getElementById("modal-a11y");
const btnCloseA11y = document.getElementById("btn-close-a11y");
const readerCoverThumb = document.getElementById("reader-cover-thumb");
const btnBookmark = document.getElementById("btn-bookmark");
const iconBookmark = document.getElementById("icon-bookmark");
const modalCoverFull = document.getElementById("modal-cover-full");
const imgCoverFull = document.getElementById("img-cover-full");
const btnCloseCover = document.getElementById("btn-close-cover");
const readerToc = document.getElementById("reader-toc");

const progressLabel = document.getElementById("progress-label");
const progressPercent = document.getElementById("progress-percent");
const progressBar = document.getElementById("progress-bar");

const btnTtsToggle = document.getElementById("btn-tts-toggle");
const iconPlay = document.getElementById("icon-play");
const iconPause = document.getElementById("icon-pause");
const ttsLabel = document.getElementById("tts-label");
const ttsSpeed = document.getElementById("tts-speed");
const ttsSpeedVal = document.getElementById("tts-speed-val");

/* ---- Estado do livro atualmente aberto ---- */
let currentBook = null;      // registro do IndexedDB
let currentType = null;      // "epub" | "pdf"
let epubBook = null;         // Legado
let epubRendition = null;    // Legado
let epubZip = null;          // Instância do JSZip
let epubManifestItems = {};  // Arquivos mapeados no zip
let epubSpineIds = [];       // IDs na ordem de leitura (Spine)
let epubChapterTitles = [];  // Nomes de cada capítulo do spine
let currentSpineIndex = 0;   // Índice do capítulo ativo
let createdBlobUrls = [];    // URLs criadas para liberar memória
let pdfDoc = null;           // instância do PDFDocumentProxy (pdf.js)
let pdfCurrentPage = 1;
let pdfTotalPages = 0;
let pdfRenderTask = null;

let saveTimer = null;        // debounce do autosave

/* =====================================================================
   Abertura / fechamento do leitor
   ===================================================================== */

async function openReader(bookId) {
  showLoading("Abrindo livro…");
  const book = await getBook(bookId);
  if (!book) { hideLoading(); return; }

  currentBook = book;
  currentType = book.type;
  readerTitle.textContent = book.title;

  if (book.type === "pdf") {
    if (readerTitle) readerTitle.classList.remove("hidden");
    if (readerToc) readerToc.classList.add("hidden");
  }

  // Exibe a miniatura da capa do livro se existir
  if (book.cover && readerCoverThumb) {
    readerCoverThumb.src = book.cover;
    readerCoverThumb.classList.remove("hidden");
  } else if (readerCoverThumb) {
    readerCoverThumb.src = "";
    readerCoverThumb.classList.add("hidden");
  }

  viewLibrary.classList.add("hidden");
  viewReader.classList.remove("hidden");

  applyTheme(book.prefs.theme);
  applyFont(book.prefs.font);
  applyFontSize(book.prefs.fontSize);
  syncA11yButtons(book.prefs);

  try {
    if (book.type === "epub") await loadEpub(book);
    else await loadPdf(book);
  } catch (err) {
    console.error(err);
    alert("Não foi possível abrir este arquivo. Ele pode estar corrompido.");
    closeReader();
  }
  hideLoading();
}

function closeReader() {
  stopSpeaking();
  if (epubRendition) { epubRendition.destroy(); epubRendition = null; }
  epubBook = null;

  // Limpeza das URLs de blobs e do estado do custom EPUB
  revokeBlobUrls();
  epubZip = null;
  epubManifestItems = {};
  epubSpineIds = [];
  epubChapterTitles = [];
  currentSpineIndex = 0;
  if (readerToc) {
    readerToc.classList.add("hidden");
    readerToc.innerHTML = "";
  }

  if (pdfRenderTask) {
    try {
      pdfRenderTask.cancel();
    } catch (_) {}
    pdfRenderTask = null;
  }
  pdfDoc = null;
  readerFrame.innerHTML = "";

  // Oculta a miniatura da capa ao fechar o leitor
  if (readerCoverThumb) {
    readerCoverThumb.src = "";
    readerCoverThumb.classList.add("hidden");
  }

  viewReader.classList.add("hidden");
  viewLibrary.classList.remove("hidden");
  currentBook = null;
  renderLibrary();
}
btnBack.addEventListener("click", closeReader);

/* =====================================================================
   EPUB — renderização com epub.js
   ===================================================================== */

// URLs criadas para recursos locais do EPUB (devem ser revogadas para evitar vazamento de memória)
function revokeBlobUrls() {
  createdBlobUrls.forEach(url => URL.revokeObjectURL(url));
  createdBlobUrls = [];
}

function resolveRelativePath(baseDir, relativePath) {
  const parts = (baseDir + relativePath).split("/");
  const stack = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

function getMimeType(path) {
  const ext = path.split(".").pop().toLowerCase();
  const mimes = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp"
  };
  return mimes[ext] || "image/jpeg";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

async function loadEpub(book) {
  readerFrame.innerHTML = "";
  revokeBlobUrls();

  let arrayBuffer;
  if (book.fileData instanceof Blob) {
    arrayBuffer = await book.fileData.arrayBuffer();
  } else {
    arrayBuffer = book.fileData;
  }

  // Carrega o ZIP na memória
  epubZip = await JSZip.loadAsync(arrayBuffer);

  // 1. Encontra o container.xml
  const containerXmlText = await epubZip.file("META-INF/container.xml").async("text");
  const containerDoc = new DOMParser().parseFromString(containerXmlText, "text/xml");
  const rootfilePath = containerDoc.querySelector("rootfile").getAttribute("full-path");
  const rootDir = rootfilePath.includes("/") ? rootfilePath.substring(0, rootfilePath.lastIndexOf("/") + 1) : "";

  // 2. Lê e processa o arquivo .opf (Manifesto)
  const opfText = await epubZip.file(rootfilePath).async("text");
  const opfDoc = new DOMParser().parseFromString(opfText, "text/xml");

  // Mapeia todos os arquivos do manifesto
  epubManifestItems = {};
  opfDoc.querySelectorAll("manifest > item").forEach(item => {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    epubManifestItems[id] = { href, absPath: rootDir + href, mediaType: item.getAttribute("media-type") };
  });

  // Mapeia a ordem de leitura (Spine)
  epubSpineIds = [];
  opfDoc.querySelectorAll("spine > itemref").forEach(itemref => {
    epubSpineIds.push(itemref.getAttribute("idref"));
  });

  // 3. Extrai ou gera os títulos dos capítulos para o TOC
  epubChapterTitles = [];
  for (let i = 0; i < epubSpineIds.length; i++) {
    const id = epubSpineIds[i];
    const item = epubManifestItems[id];
    if (item && epubZip.file(item.absPath)) {
      try {
        const text = await epubZip.file(item.absPath).async("text");
        const doc = new DOMParser().parseFromString(text, "text/html");
        const titleText = doc.querySelector("h1, h2, h3, title")?.textContent?.trim();
        epubChapterTitles.push(titleText || `Capítulo ${i + 1}`);
      } catch (_) {
        epubChapterTitles.push(`Capítulo ${i + 1}`);
      }
    } else {
      epubChapterTitles.push(`Capítulo ${i + 1}`);
    }
  }

  // 4. Configura o menu suspenso (TOC select) no cabeçalho
  if (readerToc) {
    readerToc.innerHTML = epubChapterTitles
      .map((t, idx) => `<option value="${idx}">${escapeHtml(t)}</option>`)
      .join("");

    // Mostra o seletor TOC e esconde o título estático para EPUB
    readerToc.classList.remove("hidden");
    readerTitle.classList.add("hidden");

    // Remove event listener antigo e recria
    const newSelect = readerToc.cloneNode(true);
    readerToc.parentNode.replaceChild(newSelect, readerToc);

    // Atualiza a referência global
    document.getElementById("reader-toc").addEventListener("change", (e) => {
      stopSpeaking();
      displayEpubChapter(parseInt(e.target.value));
    });
  }

  // 5. Restaura o progresso de leitura
  let targetChapter = 0;
  let targetWord = 0;

  if (book.progress && book.progress.location) {
    // Tenta decodificar o formato "chapterIndex:wordIndex"
    if (book.progress.location.includes(":")) {
      const parts = book.progress.location.split(":");
      targetChapter = parseInt(parts[0]) || 0;
      targetWord = parseInt(parts[1]) || 0;
    }
  }

  // 6. Exibe o capítulo inicial
  await displayEpubChapter(targetChapter, targetWord);
}

async function displayEpubChapter(chapterIndex, targetWordIndex = 0) {
  if (!epubSpineIds.length) return;
  chapterIndex = Math.min(Math.max(0, chapterIndex), epubSpineIds.length - 1);
  currentSpineIndex = chapterIndex;

  // Atualiza o select do TOC no cabeçalho
  const selectEl = document.getElementById("reader-toc");
  if (selectEl) {
    selectEl.value = chapterIndex;
  }

  // Revoga URLs anteriores para evitar sobrecarga de memória
  revokeBlobUrls();

  const id = epubSpineIds[chapterIndex];
  const item = epubManifestItems[id];
  if (!item || !epubZip.file(item.absPath)) {
    readerFrame.innerHTML = `<p class="text-center opacity-50 py-12">Erro ao carregar o capítulo.</p>`;
    return;
  }

  showLoading("Carregando capítulo…");

  let htmlText = await epubZip.file(item.absPath).async("text");
  const doc = new DOMParser().parseFromString(htmlText, "text/html");
  const chapterDir = item.absPath.includes("/") ? item.absPath.substring(0, item.absPath.lastIndexOf("/") + 1) : "";

  // Resolve imagens inline (img) para Blob URLs
  const imgs = doc.querySelectorAll("img");
  for (const img of imgs) {
    const src = img.getAttribute("src");
    if (src && !src.startsWith("data:") && !src.startsWith("http")) {
      const relPath = resolveRelativePath(chapterDir, src);
      const imgFile = epubZip.file(relPath);
      if (imgFile) {
        const blob = await imgFile.async("blob");
        const blobUrl = URL.createObjectURL(blob);
        img.setAttribute("src", blobUrl);
        createdBlobUrls.push(blobUrl);
      }
    }
  }

  // Resolve imagens em SVG (image) para Blob URLs
  const svgImgs = doc.querySelectorAll("image");
  for (const img of svgImgs) {
    const href = img.getAttribute("href") || img.getAttribute("xlink:href");
    if (href && !href.startsWith("data:") && !href.startsWith("http")) {
      const relPath = resolveRelativePath(chapterDir, href);
      const imgFile = epubZip.file(relPath);
      if (imgFile) {
        const blob = await imgFile.async("blob");
        const blobUrl = URL.createObjectURL(blob);
        img.setAttribute("href", blobUrl);
        img.setAttribute("xlink:href", blobUrl);
        createdBlobUrls.push(blobUrl);
      }
    }
  }

  // Limpa e renderiza o HTML diretamente no leitor (sem usar iframe)
  readerFrame.innerHTML = `
    <div id="epub-page" class="h-full overflow-y-auto px-6 py-8 sm:px-12">
      <div id="epub-text" class="max-w-2xl mx-auto leading-relaxed epub-body-content"></div>
    </div>
  `;

  const textContainer = document.getElementById("epub-text");
  textContainer.innerHTML = doc.body.innerHTML;

  // Prepara as palavras do texto para narração/destaque
  wrapWordsForTts(textContainer);

  // Escuta cliques no container para selecionar palavra e pular o TTS
  document.getElementById("epub-page").addEventListener("click", (e) => {
    const wordEl = e.target.closest(".tts-word");
    if (wordEl) {
      const idx = ttsWords.findIndex(w => w.el === wordEl);
      if (idx !== -1) {
        ttsCurrentIndex = idx;
        if (ttsSpeaking) {
          speakFrom(ttsCurrentIndex);
        } else {
          highlightWord(ttsCurrentIndex);
        }
        return; // impede passagem lateral
      }
    }

    // Clique nas laterais para avançar/retroceder capítulos
    const x = e.clientX / window.innerWidth;
    if (x < 0.15) {
      stopSpeaking();
      displayEpubChapter(currentSpineIndex - 1);
    } else if (x > 0.85) {
      stopSpeaking();
      displayEpubChapter(currentSpineIndex + 1);
    }
  });

  // Se houver palavra-alvo para restaurar progresso, aplica o realce
  if (targetWordIndex > 0 && targetWordIndex < ttsWords.length) {
    ttsCurrentIndex = targetWordIndex;
    highlightWord(targetWordIndex);
  } else {
    document.getElementById("epub-page").scrollTop = 0;
    ttsCurrentIndex = 0;
  }

  hideLoading();
  updateEpubProgress();
}

function getEpubCurrentCfi() {
  if (epubSpineIds.length) {
    return `${currentSpineIndex}:${ttsCurrentIndex}`;
  }
  return null;
}

function updateEpubProgress() {
  if (!epubSpineIds.length) return;
  const percent = Math.round((currentSpineIndex / epubSpineIds.length) * 100);

  progressLabel.textContent = `Capítulo ${currentSpineIndex + 1} de ${epubSpineIds.length}`;
  progressPercent.textContent = `${percent}%`;
  progressBar.style.width = `${percent}%`;

  if (currentBook) {
    currentBook.progress = {
      location: getEpubCurrentCfi(),
      percent,
      page: currentSpineIndex + 1,
      totalPages: epubSpineIds.length,
    };
  }
}

/* =====================================================================
   PDF — renderização com pdf.js
   ---------------------------------------------------------------------
   Em vez de exibir apenas a imagem (canvas) da página, extraímos o texto
   real com pdf.js e o exibimos como HTML — isso permite aplicar tema,
   fonte e tamanho de texto (item 2 da especificação) e também narrar o
   conteúdo com destaque de palavras (item 3), o que não seria possível
   sobre uma imagem estática.
   ===================================================================== */

async function loadPdf(book) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  // Converte Blob/File para ArrayBuffer de forma assíncrona para compatibilidade universal
  let arrayBuffer;
  if (book.fileData instanceof Blob) {
    arrayBuffer = await book.fileData.arrayBuffer();
  } else {
    arrayBuffer = book.fileData;
  }

  pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  pdfTotalPages = pdfDoc.numPages;
  pdfCurrentPage = book.progress.page || 1;

  readerFrame.innerHTML = `
    <div id="pdf-page" class="h-full overflow-y-auto flex flex-col items-center gap-6 px-6 py-8">
      <div id="pdf-canvas-container" class="relative max-w-full shadow-lg border border-white/10 rounded bg-white">
        <canvas id="pdf-canvas" class="max-w-full h-auto block rounded"></canvas>
      </div>
      <div id="pdf-text" class="max-w-2xl w-full leading-relaxed bg-[var(--ink-soft)]/20 p-5 rounded-lg border border-white/5"></div>
    </div>
  `;

  readerFrame.addEventListener("click", (e) => {
    // Se clicou em uma palavra do TTS, move o ponto de leitura
    const wordEl = e.target.closest(".tts-word");
    if (wordEl) {
      const idx = ttsWords.findIndex(w => w.el === wordEl);
      if (idx !== -1) {
        ttsCurrentIndex = idx;
        if (ttsSpeaking) {
          speakFrom(ttsCurrentIndex);
        } else {
          highlightWord(ttsCurrentIndex);
        }
        return; // Interrompe para não disparar navegação lateral
      }
    }

    const x = e.clientX / window.innerWidth;
    if (x < 0.15) goToPdfPage(pdfCurrentPage - 1);
    else if (x > 0.85) goToPdfPage(pdfCurrentPage + 1);
  });

  await renderPdfPage(pdfCurrentPage);
}

async function renderPdfPage(pageNum) {
  pageNum = Math.min(Math.max(pageNum, 1), pdfTotalPages);
  pdfCurrentPage = pageNum;

  const page = await pdfDoc.getPage(pageNum);

  // 1. Renderiza a página visual no canvas
  const viewport = page.getViewport({ scale: 1.5 });
  const canvas = document.getElementById("pdf-canvas");
  if (canvas) {
    const context = canvas.getContext("2d");
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    // Cancela tarefa anterior em andamento para evitar conflitos de renderização
    if (pdfRenderTask) {
      try {
        pdfRenderTask.cancel();
      } catch (_) {}
      pdfRenderTask = null;
    }

    const renderContext = {
      canvasContext: context,
      viewport: viewport
    };
    pdfRenderTask = page.render(renderContext);
    try {
      await pdfRenderTask.promise;
    } catch (err) {
      if (err.name !== "RenderingCancelledException" && err.message !== "Rendering cancelled, page.render() was called again.") {
        console.warn("Erro ao renderizar canvas do PDF:", err);
      }
    }
    pdfRenderTask = null;
  }

  // 2. Extrai e exibe o texto da página (se existir)
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
    const cleanLines = lines.filter((l) => l.trim().length);
    if (cleanLines.length === 0) {
      container.innerHTML = "";
      container.classList.add("hidden");
      // Reseta index do TTS para evitar falas residuais
      ttsWords = [];
      ttsCurrentIndex = 0;
    } else {
      container.classList.remove("hidden");
      container.innerHTML = cleanLines
        .map((l) => `<p class="mb-4">${escapeHtml(l)}</p>`)
        .join("");
      wrapWordsForTts(container);
    }
  }

  document.getElementById("pdf-page").scrollTop = 0;

  updatePdfProgress();
  scheduleSave();
}

function goToPdfPage(n) {
  stopSpeaking();
  renderPdfPage(n);
}

function updatePdfProgress() {
  const percent = Math.round((pdfCurrentPage / pdfTotalPages) * 100);
  progressLabel.textContent = `Página ${pdfCurrentPage} de ${pdfTotalPages}`;
  progressPercent.textContent = `${percent}%`;
  progressBar.style.width = `${percent}%`;

  if (currentBook) {
    currentBook.progress = {
      location: null,
      percent,
      page: pdfCurrentPage,
      totalPages: pdfTotalPages,
    };
  }
}

/* =====================================================================
   Autosave — grava o progresso no IndexedDB (com debounce)
   ===================================================================== */

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (currentBook) patchBook(currentBook.id, { progress: currentBook.progress });
  }, 600);
}

// Também salva ao trocar de aba, minimizar ou fechar o navegador —
// cobre o requisito de "salvar ao fechar o navegador ou pausar o app".
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && currentBook) {
    patchBook(currentBook.id, { progress: currentBook.progress });
  }
});
window.addEventListener("beforeunload", () => {
  if (currentBook) patchBook(currentBook.id, { progress: currentBook.progress });
});

/* =====================================================================
   Sistema de voz (TTS) — Web Speech API
   ---------------------------------------------------------------------
   Limitações importantes de navegadores móveis (comentado conforme
   pedido na especificação):
   1) iOS Safari e Chrome Android só permitem chamar speechSynthesis
      dentro de um gesto direto do usuário (um clique/toque). Por isso
      TODA chamada a speak() aqui parte de um clique no botão "Ouvir" —
      nunca é disparada automaticamente ao abrir a página.
   2) window.speechSynthesis.pause()/resume() tem suporte inconsistente
      no Android; por segurança, ao pausar em mobile, o mais confiável é
      cancelar e, ao retomar, criar uma NOVA utterance a partir da
      palavra onde a leitura parou (é o que fazemos abaixo).
   3) As vozes (getVoices()) podem carregar de forma assíncrona — por
      isso escutamos o evento 'voiceschanged' antes de escolher a voz
      em pt-BR.
   ===================================================================== */

let ttsWords = [];        // [{el, text}] — todas as palavras da página/seção atual
let ttsPlainText = "";    // texto concatenado usado na utterance (charIndex bate com isto)
let ttsWordOffsets = [];  // offset inicial de cada palavra dentro de ttsPlainText
let ttsCurrentIndex = 0;  // próxima palavra a narrar (permite retomar após pausa)
let ttsSpeaking = false;
let ttsUtterance = null;
let cachedVoice = null;

/** Envolve cada palavra de um elemento em <span class="tts-word"> para permitir o destaque. */
function wrapWordsForTts(rootEl) {
  if (!rootEl || rootEl.dataset.ttsWrapped === "true") return;

  const walker = (rootEl.ownerDocument || document).createTreeWalker(
    rootEl,
    NodeFilter.SHOW_TEXT,
    null
  );
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue.trim().length) textNodes.push(node);
  }

  textNodes.forEach((textNode) => {
    const frag = (rootEl.ownerDocument || document).createDocumentFragment();
    const parts = textNode.nodeValue.split(/(\s+)/); // mantém os espaços como itens separados
    parts.forEach((part) => {
      if (part.trim().length === 0) {
        frag.appendChild((rootEl.ownerDocument || document).createTextNode(part));
      } else {
        const span = (rootEl.ownerDocument || document).createElement("span");
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

/** Reconstrói a lista plana de palavras + o texto usado pela utterance. */
function rebuildTtsIndex(rootEl) {
  const doc = rootEl.ownerDocument || document;
  const spans = Array.from(doc.querySelectorAll(".tts-word"));
  ttsWords = spans.map((el) => ({ el, text: el.textContent }));
  ttsWordOffsets = [];
  let offset = 0;
  const parts = [];
  ttsWords.forEach((w) => {
    ttsWordOffsets.push(offset);
    parts.push(w.text);
    offset += w.text.length + 1; // +1 pelo espaço entre as palavras
  });
  ttsPlainText = parts.join(" ");
  ttsCurrentIndex = 0;
}

/** Escolhe a melhor voz em pt-BR disponível no sistema do usuário. */
function pickPortugueseVoice() {
  return new Promise((resolve) => {
    const select = () => {
      const voices = window.speechSynthesis.getVoices();
      const ptBR = voices.find((v) => v.lang?.toLowerCase() === "pt-br");
      const ptAny = voices.find((v) => v.lang?.toLowerCase().startsWith("pt"));
      resolve(ptBR || ptAny || voices[0] || null);
    };
    const existing = window.speechSynthesis.getVoices();
    if (existing.length) return select();
    window.speechSynthesis.onvoiceschanged = select;
  });
}

function highlightWord(index) {
  ttsWords.forEach((w, i) => w.el.classList.toggle("tts-highlight", i === index));
  const el = ttsWords[index]?.el;
  if (el && el.scrollIntoView) {
    // Mantém a palavra sempre centralizada, tanto no leitor de PDF/EPUB
    // (documento normal) quanto dentro do iframe do epub.js.
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  }

  // Se for EPUB, atualiza o progresso com a palavra exata em tempo real
  if (currentType === "epub") {
    updateEpubProgress();
    scheduleSave();
  }
}

function clearHighlight() {
  ttsWords.forEach((w) => w.el.classList.remove("tts-highlight"));
}

async function speakFrom(startIndex) {
  if (!ttsWords.length) return;
  window.speechSynthesis.cancel(); // garante que não há fala sobreposta

  if (!cachedVoice) cachedVoice = await pickPortugueseVoice();

  // Reconstrói o texto a partir da palavra de início, para que o índice
  // de caracteres (charIndex) do evento 'boundary' comece do zero.
  const remaining = ttsWords.slice(startIndex);
  const text = remaining.map((w) => w.text).join(" ");

  ttsUtterance = new SpeechSynthesisUtterance(text);
  ttsUtterance.lang = "pt-BR";
  if (cachedVoice) ttsUtterance.voice = cachedVoice;
  ttsUtterance.rate = parseFloat(ttsSpeed.value || "2");

  ttsUtterance.onboundary = (event) => {
    if (event.name && event.name !== "word") return; // alguns navegadores também disparam 'sentence'
    // Encontra a palavra cujo início de texto corresponde ao charIndex atual
    let acc = 0;
    for (let i = 0; i < remaining.length; i++) {
      const len = remaining[i].text.length + 1;
      if (event.charIndex < acc + len) {
        ttsCurrentIndex = startIndex + i;
        highlightWord(ttsCurrentIndex);
        break;
      }
      acc += len;
    }
  };

  ttsUtterance.onend = () => {
    // Se chegou ao fim do texto atual (e não foi uma parada manual), avança
    // automaticamente para a próxima página/seção e continua narrando —
    // assim a leitura em voz alta não exige toque a cada página.
    if (ttsSpeaking) advancePageAndContinueSpeaking();
  };

  ttsSpeaking = true;
  setTtsButtonState(true);
  window.speechSynthesis.speak(ttsUtterance);
}

async function advancePageAndContinueSpeaking() {
  if (currentType === "epub") {
    if (currentSpineIndex >= epubSpineIds.length - 1) { stopSpeaking(); return; }
    await displayEpubChapter(currentSpineIndex + 1);
    // pequena espera para o DOM preparar e indexar ttsWords do novo capítulo
    setTimeout(() => { if (ttsSpeaking) speakFrom(0); }, 300);
  } else if (currentType === "pdf") {
    if (pdfCurrentPage >= pdfTotalPages) { stopSpeaking(); return; }
    await renderPdfPage(pdfCurrentPage + 1);
    if (ttsSpeaking) speakFrom(0);
  }
}

function stopSpeaking() {
  ttsSpeaking = false;
  window.speechSynthesis.cancel();
  clearHighlight();
  setTtsButtonState(false);
}

function setTtsButtonState(isSpeaking) {
  iconPlay.classList.toggle("hidden", isSpeaking);
  iconPause.classList.toggle("hidden", !isSpeaking);
  if (ttsLabel) ttsLabel.textContent = isSpeaking ? "Pausar" : "Ouvir";
}

btnTtsToggle.addEventListener("click", () => {
  // Este clique É o "gesto do usuário" exigido pelos navegadores móveis
  // para liberar o áudio — ver comentário no topo desta seção.
  if (ttsSpeaking) {
    stopSpeaking();
  } else {
    speakFrom(ttsCurrentIndex || 0);
  }
});

// Eventos do painel de controle do leitor
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

// Navega entre parágrafos (TTS skip por parágrafos)
function skipParagraph(direction) {
  if (!ttsWords.length) return;

  // 1. Identifica a palavra atual
  const currentWordObj = ttsWords[ttsCurrentIndex];
  if (!currentWordObj || !currentWordObj.el) return;

  const currentEl = currentWordObj.el;
  const doc = currentEl.ownerDocument || document;

  // 2. Encontra o parágrafo do elemento atual
  const currentPara = currentEl.closest("p, li, h1, h2, h3, h4, h5, h6, [class*='paragraph']");
  if (!currentPara) {
    // Fallback se não encontrar container semântico
    ttsSkipWords(direction * 15);
    return;
  }

  // 3. Busca todos os elementos de parágrafo no documento que contêm palavras do TTS
  const allParas = Array.from(doc.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, [class*='paragraph']"))
    .filter(p => p.querySelector(".tts-word"));

  // 4. Acha o índice do parágrafo atual
  const currentParaIndex = allParas.indexOf(currentPara);
  if (currentParaIndex === -1) {
    ttsSkipWords(direction * 15);
    return;
  }

  // 5. Determina o parágrafo de destino
  const targetParaIndex = currentParaIndex + direction;
  if (targetParaIndex < 0 || targetParaIndex >= allParas.length) {
    // Limite atingido: início ou fim do texto da seção
    if (direction === -1) {
      ttsCurrentIndex = 0;
    } else {
      ttsCurrentIndex = ttsWords.length - 1;
    }
  } else {
    // 6. Encontra a primeira palavra do parágrafo de destino
    const targetPara = allParas[targetParaIndex];
    const firstWordInTarget = targetPara.querySelector(".tts-word");
    if (firstWordInTarget) {
      const idx = ttsWords.findIndex(w => w.el === firstWordInTarget);
      if (idx !== -1) {
        ttsCurrentIndex = idx;
      }
    }
  }

  // 7. Retoma a fala ou atualiza realce
  if (ttsSpeaking) {
    speakFrom(ttsCurrentIndex);
  } else {
    highlightWord(ttsCurrentIndex);
  }
}

function ttsSkipWords(count) {
  const newIndex = Math.max(0, Math.min(ttsWords.length - 1, ttsCurrentIndex + count));
  ttsCurrentIndex = newIndex;
  if (ttsSpeaking) {
    speakFrom(newIndex);
  } else {
    highlightWord(newIndex);
  }
}

document.getElementById("btn-tts-prev").addEventListener("click", () => {
  skipParagraph(-1);
});

document.getElementById("btn-tts-next").addEventListener("click", () => {
  skipParagraph(1);
});

// Marcador manual (Bookmark) no cabeçalho
if (btnBookmark) {
  btnBookmark.addEventListener("click", async () => {
    if (!currentBook) return;

    // Salva o progresso atual imediatamente
    if (currentType === "epub") {
      updateEpubProgress();
    } else if (currentType === "pdf") {
      updatePdfProgress();
    }

    await patchBook(currentBook.id, { progress: currentBook.progress });

    // Feedback visual animado no título do leitor
    if (iconBookmark) iconBookmark.setAttribute("fill", "currentColor");
    const originalTitle = readerTitle.textContent;
    readerTitle.textContent = "🔖 Marcador Salvo!";
    readerTitle.classList.add("text-[var(--brass)]");

    setTimeout(() => {
      if (iconBookmark) iconBookmark.setAttribute("fill", "none");
      if (currentBook) {
        readerTitle.textContent = currentBook.title;
      }
      readerTitle.classList.remove("text-[var(--brass)]");
    }, 1800);
  });
}

ttsSpeed.addEventListener("input", () => {
  ttsSpeedVal.textContent = `${parseFloat(ttsSpeed.value).toFixed(1)}x`;
});
ttsSpeed.addEventListener("change", () => {
  // A taxa de fala não pode ser alterada em uma utterance já em andamento,
  // então reiniciamos a partir da palavra atual com a nova velocidade.
  if (ttsSpeaking) speakFrom(ttsCurrentIndex);
});

/* =====================================================================
   Menu de acessibilidade — tema, fonte, tamanho, modo de visualização
   ===================================================================== */

btnA11y.addEventListener("click", () => modalA11y.classList.remove("hidden"));
btnCloseA11y.addEventListener("click", () => modalA11y.classList.add("hidden"));
modalA11y.addEventListener("click", (e) => { if (e.target === modalA11y) modalA11y.classList.add("hidden"); });

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
  document.querySelectorAll(".flow-opt").forEach((b) =>
    b.classList.toggle("ring-2", b.dataset.flow === prefs.flow)
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

document.querySelectorAll(".flow-opt").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (!currentBook || currentType !== "epub") return;
    currentBook.prefs.flow = btn.dataset.flow;
    syncA11yButtons(currentBook.prefs);
    patchBook(currentBook.id, { prefs: currentBook.prefs });
    // O layout do leitor nativo flui automaticamente em rolagem contínua
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

// Controle de visualização da capa em tamanho cheio (Modal)
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

if (modalCoverFull) {
  modalCoverFull.addEventListener("click", (e) => {
    if (e.target === modalCoverFull) closeCoverModal();
  });
}
if (btnCloseCover) {
  btnCloseCover.addEventListener("click", closeCoverModal);
}

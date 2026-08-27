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
let epubBook = null;         // instância do Book (epub.js)
let epubRendition = null;    // instância do Rendition (epub.js)
let pdfDoc = null;           // instância do PDFDocumentProxy (pdf.js)
let pdfCurrentPage = 1;
let pdfTotalPages = 0;

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
  pdfDoc = null;
  readerFrame.innerHTML = "";
  viewReader.classList.add("hidden");
  viewLibrary.classList.remove("hidden");
  currentBook = null;
  renderLibrary();
}
btnBack.addEventListener("click", closeReader);

/* =====================================================================
   EPUB — renderização com epub.js
   ===================================================================== */

async function loadEpub(book) {
  readerFrame.innerHTML = "";
  // Cria um Blob do ArrayBuffer do EPUB para aumentar a estabilidade do epub.js
  const blob = new Blob([book.fileData], { type: "application/epub+zip" });
  epubBook = ePub(blob);

  epubRendition = epubBook.renderTo(readerFrame, {
    width: "100%",
    height: "100%",
    flow: book.prefs.flow === "scrolled" ? "scrolled-doc" : "paginated",
    spread: "none",
  });

  // Injeta estilos básicos e fontes do leitor no iframe do EPUB
  epubRendition.themes.default({
    "@import": "url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Literata:ital,wght@0,400;0,600;1,400&display=swap')",
    ".tts-highlight": {
      "background-color": "#FFE58A !important",
      "color": "#241C08 !important",
      "border-radius": "3px",
      "padding": "0 1px",
      "box-shadow": "0 0 0 2px #FFE58A"
    }
  });

  registerEpubThemes();
  epubRendition.themes.select(book.prefs.theme);
  epubRendition.themes.fontSize(book.prefs.fontSize + "px");
  setEpubFontFamily(book.prefs.font);

  // Restaura a posição salva, ou começa do início
  await epubRendition.display(book.progress.location || undefined);

  // Gera o índice de localizações em segundo plano (necessário para % de progresso).
  // Comentário: em livros grandes isso pode levar alguns segundos — por isso não
  // bloqueamos a exibição do livro esperando essa promessa.
  epubBook.locations.generate(1000).then(() => {
    updateEpubProgress();
  });

  epubRendition.on("relocated", (location) => {
    updateEpubProgress(location);
    scheduleSave();
  });

  // Sempre que uma nova seção é desenhada na tela, preparamos o texto
  // dela para poder ser narrado (envolvendo cada palavra em um <span>).
  epubRendition.on("rendered", (section, view) => {
    try {
      const contents = epubRendition.getContents();
      if (contents) {
        contents.forEach((c) => {
          if (c && c.document && c.document.body) {
            wrapWordsForTts(c.document.body);
          }
        });
      }
    } catch (err) {
      console.warn("Erro ao preparar texto para TTS:", err);
    }

    // Escuta cliques dentro do documento do iframe para navegação de página
    if (view && view.document) {
      view.document.addEventListener("click", (e) => {
        const x = e.clientX / view.document.documentElement.clientWidth;
        if (x < 0.25) {
          stopSpeaking();
          epubRendition.prev();
        } else if (x > 0.75) {
          stopSpeaking();
          epubRendition.next();
        }
      });
    }
  });

  // Navegação fallback no container principal (caso o clique caia fora do iframe)
  readerFrame.addEventListener("click", (e) => {
    const x = e.clientX / window.innerWidth;
    if (x < 0.25) {
      stopSpeaking();
      epubRendition.prev();
    } else if (x > 0.75) {
      stopSpeaking();
      epubRendition.next();
    }
  });
}

function registerEpubThemes() {
  epubRendition.themes.register("claro", { body: { background: "#F4EEDF", color: "#2A2118" } });
  epubRendition.themes.register("sepia", { body: { background: "#EAD9B4", color: "#2A2118" } });
  epubRendition.themes.register("escuro", { body: { background: "#15191E", color: "#DCD5C4" } });
}

function setEpubFontFamily(fontKey) {
  const family = fontKey === "serif" ? "'Literata', Georgia, serif" : "'Inter', sans-serif";
  epubRendition.themes.font(family);
}

function updateEpubProgress(location) {
  const loc = location || epubRendition.currentLocation();
  if (!loc || !loc.start) return;
  let percent = 0;
  if (epubBook.locations.length()) {
    percent = Math.round(epubBook.locations.percentageFromCfi(loc.start.cfi) * 100);
  }
  progressLabel.textContent = `Local ${loc.start.location || "—"}`;
  progressPercent.textContent = `${percent}%`;
  progressBar.style.width = `${percent}%`;

  if (currentBook) {
    currentBook.progress = {
      location: loc.start.cfi,
      percent,
      page: loc.start.location || 0,
      totalPages: epubBook.locations.length() || 0,
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

  pdfDoc = await pdfjsLib.getDocument({ data: book.fileData.slice(0) }).promise;
  pdfTotalPages = pdfDoc.numPages;
  pdfCurrentPage = book.progress.page || 1;

  readerFrame.innerHTML = `
    <div id="pdf-page" class="h-full overflow-y-auto px-6 py-8 sm:px-16">
      <div id="pdf-text" class="max-w-2xl mx-auto leading-relaxed"></div>
    </div>
  `;

  readerFrame.addEventListener("click", (e) => {
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
  const textContent = await page.getTextContent();

  // Agrupa os itens de texto em "linhas" (heurística simples: mesma
  // coordenada Y aproximada) para formar parágrafos legíveis.
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
  container.innerHTML = lines
    .filter((l) => l.trim().length)
    .map((l) => `<p class="mb-4">${escapeHtml(l)}</p>`)
    .join("");

  wrapWordsForTts(container);
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
  ttsUtterance.rate = parseFloat(ttsSpeed.value || "1");

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
    const atEnd = epubRendition.location?.atEnd;
    if (atEnd) { stopSpeaking(); return; }
    await epubRendition.next();
    // pequena espera para o 'rendered' reconstruir ttsWords da nova seção
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
  ttsLabel.textContent = isSpeaking ? "Pausar" : "Ouvir";
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
  if (epubRendition) epubRendition.themes.select(theme);
}

function applyFont(fontKey) {
  viewReader.classList.remove("font-sans-reader", "font-serif-reader");
  viewReader.classList.add(fontKey === "serif" ? "font-serif-reader" : "font-sans-reader");
  if (epubRendition) setEpubFontFamily(fontKey);
}

function applyFontSize(px) {
  viewReader.style.fontSize = `${px}px`;
  document.getElementById("font-size-val").textContent = `${px}px`;
  if (epubRendition) epubRendition.themes.fontSize(`${px}px`);
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
    // Recarrega a exibição do epub.js no novo modo de fluxo
    const cfi = epubRendition.currentLocation()?.start?.cfi;
    epubRendition.destroy();
    await loadEpub(currentBook);
    if (cfi) epubRendition.display(cfi);
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

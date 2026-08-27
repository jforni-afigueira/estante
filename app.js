/* =====================================================================
   app.js — Estante (galeria) + armazenamento local (IndexedDB)
   ---------------------------------------------------------------------
   Este arquivo cuida de tudo que acontece ANTES de abrir um livro:
   - Criação/abertura do banco IndexedDB (arquivos, progresso, metadados)
   - Importação de arquivos .epub / .pdf
   - Extração de metadados e capa (quando existir)
   - Renderização da grade de capas na tela inicial ("Estante")

   A renderização do conteúdo do livro (epub.js / pdf.js) e o motor de
   voz (TTS) ficam em reader.js — este arquivo só entrega o "livro"
   (registro do IndexedDB) para o reader.js quando o usuário clica nele.
   ===================================================================== */

const DB_NAME = "estante-db";
const DB_VERSION = 1;
const STORE_BOOKS = "books";

let dbInstance = null;

/** Abre (ou cria, na primeira vez) o banco IndexedDB do navegador. */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        // keyPath "id" = identificador único de cada livro importado
        const store = db.createObjectStore(STORE_BOOKS, { keyPath: "id" });
        store.createIndex("title", "title", { unique: false });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

async function getDB() {
  if (!dbInstance) dbInstance = await openDatabase();
  return dbInstance;
}

/** Salva (ou atualiza) o registro completo de um livro. */
async function saveBook(book) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, "readwrite");
    tx.objectStore(STORE_BOOKS).put(book);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Atualiza só alguns campos de um livro (ex.: progresso de leitura). */
async function patchBook(id, patch) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, "readwrite");
    const store = tx.objectStore(STORE_BOOKS);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const current = getReq.result;
      if (!current) return resolve();
      store.put({ ...current, ...patch });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getBook(id) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, "readonly");
    const req = tx.objectStore(STORE_BOOKS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function getAllBooks() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, "readonly");
    const req = tx.objectStore(STORE_BOOKS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** Remove um livro completo do banco local. */
async function deleteBook(id) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, "readwrite");
    tx.objectStore(STORE_BOOKS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* --------------------------------------------------------------------
   Importação de arquivos
   -------------------------------------------------------------------- */

const fileInput = document.getElementById("file-input");
const btnImport = document.getElementById("btn-import");
const libraryGrid = document.getElementById("library-grid");
const emptyState = document.getElementById("empty-state");
const loadingOverlay = document.getElementById("loading-overlay");
const loadingLabel = document.getElementById("loading-label");

function showLoading(text) {
  loadingLabel.textContent = text || "Carregando…";
  loadingOverlay.classList.remove("hidden");
}
function hideLoading() {
  loadingOverlay.classList.add("hidden");
}

btnImport.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  showLoading(files.length > 1 ? "Importando livros…" : "Importando livro…");
  for (const file of files) {
    try {
      await importFile(file);
    } catch (err) {
      console.error("Falha ao importar", file.name, err);
      alert(`Não foi possível importar "${file.name}". Verifique se é um EPUB ou PDF válido.`);
    }
  }
  fileInput.value = ""; // permite re-selecionar o mesmo arquivo depois
  hideLoading();
  await renderLibrary();
});

/** Lê o arquivo escolhido, extrai metadados/capa e grava no IndexedDB. */
async function importFile(file) {
  const ext = file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "epub";

  // Utiliza FileReader para maior compatibilidade de leitura do buffer em todos os navegadores
  const arrayBuffer = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });

  let title = file.name.replace(/\.(epub|pdf)$/i, "");
  let author = "";
  let coverDataUrl = null;

  if (ext === "epub") {
    const meta = await extractEpubMetadata(arrayBuffer);
    title = meta.title || title;
    author = meta.author || "";
    coverDataUrl = meta.cover || null;
  } else {
    const meta = await extractPdfMetadata(arrayBuffer);
    title = meta.title || title;
    author = meta.author || "";
    coverDataUrl = meta.cover || null;
  }

  const book = {
    id: `book_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: ext,
    title,
    author,
    cover: coverDataUrl,
    fileData: arrayBuffer, // IndexedDB aceita ArrayBuffer nativamente
    fileName: file.name,
    addedAt: Date.now(),
    // Progresso de leitura (preenchido pelo reader.js)
    progress: { location: null, percent: 0, page: 0, totalPages: 0 },
    // Preferências de leitura específicas deste livro
    prefs: { theme: "claro", font: "sans", fontSize: 18, flow: "paginated" },
  };

  await saveBook(book);
}

/** Extrai título, autor e capa (se existir) de um EPUB usando epub.js. */
async function extractEpubMetadata(arrayBuffer) {
  try {
    const book = ePub();
    await book.open(arrayBuffer);
    await book.ready;
    const metadata = await book.loaded.metadata;

    let cover = null;
    try {
      const coverUrl = await book.coverUrl();
      if (coverUrl) cover = await urlToDataURL(coverUrl);
    } catch (_) {
      /* nem todo EPUB tem capa — segue sem ela */
    }

    return {
      title: metadata.title,
      author: metadata.creator,
      cover,
    };
  } catch (err) {
    console.warn("Não foi possível ler metadados do EPUB:", err);
    return {};
  }
}

/** Extrai título/autor (metadados do PDF) e renderiza a 1ª página como capa. */
async function extractPdfMetadata(arrayBuffer) {
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
    const meta = await pdf.getMetadata().catch(() => null);

    // Renderiza a primeira página em um canvas pequeno para usar como "capa"
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 0.4 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

    return {
      title: meta?.info?.Title || null,
      author: meta?.info?.Author || null,
      cover: canvas.toDataURL("image/jpeg", 0.75),
    };
  } catch (err) {
    console.warn("Não foi possível ler metadados do PDF:", err);
    return {};
  }
}

/** Converte uma URL (blob: ou http:) em data URL, para poder guardar no IndexedDB. */
function urlToDataURL(url) {
  return fetch(url)
    .then((r) => r.blob())
    .then(
      (blob) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        })
    );
}

/* --------------------------------------------------------------------
   Renderização da galeria ("Estante")
   -------------------------------------------------------------------- */

// Paleta de "lombadas" — cada capa sem imagem recebe uma cor consistente
// derivada do próprio título, para a estante nunca parecer repetitiva.
const SPINE_PALETTE = ["#6FA089", "#C6A15B", "#8A6FA0", "#A0716F", "#6F8FA0", "#A0946F"];
function spineColorFor(title) {
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = title.charCodeAt(i) + ((hash << 5) - hash);
  return SPINE_PALETTE[Math.abs(hash) % SPINE_PALETTE.length];
}

async function renderLibrary() {
  const books = await getAllBooks();
  books.sort((a, b) => b.addedAt - a.addedAt);

  libraryGrid.innerHTML = "";
  emptyState.classList.toggle("hidden", books.length > 0);

  for (const book of books) {
    const card = document.createElement("div");
    card.className =
      "focus-ring group relative text-left rounded-lg overflow-hidden bg-[var(--ink-soft)] border border-white/5 hover:border-[var(--verdigris)]/60 transition-colors";

    const spine = spineColorFor(book.title);
    const coverInner = book.cover
      ? `<img src="${book.cover}" alt="" class="w-full h-44 object-cover" />`
      : `<div class="cover-fallback w-full h-44 flex items-end p-3" style="--cover-a:${spine}55;--cover-b:#1B2129">
           <p class="font-display text-sm leading-snug text-white/90 line-clamp-4">${escapeHtml(book.title)}</p>
         </div>`;

    const pct = Math.round(book.progress?.percent || 0);

    card.innerHTML = `
      <button class="w-full text-left" aria-label="Abrir ${book.title}">
        <div class="book-spine" style="--spine-color:${spine}">
          ${coverInner}
        </div>
        <div class="p-2.5 pr-8">
          <p class="text-xs font-medium truncate">${escapeHtml(book.title)}</p>
          <p class="text-[11px] text-white/45 truncate">${escapeHtml(book.author || (book.type === "pdf" ? "PDF" : "EPUB"))}</p>
          ${pct > 0 ? `
            <div class="h-1 mt-2 rounded-full bg-white/10 overflow-hidden">
              <div class="h-full bg-[var(--verdigris)]" style="width:${pct}%"></div>
            </div>` : ""}
        </div>
      </button>
      <button class="btn-delete-book absolute bottom-2.5 right-2 p-1.5 rounded-full bg-black/40 hover:bg-red-500/80 text-white/80 hover:text-white opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all" title="Excluir livro" aria-label="Excluir ${book.title}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
      </button>
    `;

    // Abertura do livro ao clicar no botão da capa/detalhes
    card.querySelector("button").addEventListener("click", () => openReader(book.id));

    // Exclusão do livro ao clicar na lixeira com confirmação
    card.querySelector(".btn-delete-book").addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmDelete = confirm(`Deseja mesmo excluir "${book.title}" da sua estante?`);
      if (confirmDelete) {
        await deleteBook(book.id);
        await renderLibrary();
      }
    });

    libraryGrid.appendChild(card);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

/* --------------------------------------------------------------------
   Inicialização + registro do Service Worker (PWA)
   -------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  renderLibrary();

  if ("serviceWorker" in navigator) {
    // Registrado por último e de forma silenciosa — se falhar (ex.: ambiente
    // sem HTTPS/localhost), o app continua funcionando normalmente, só sem
    // o modo offline completo.
    navigator.serviceWorker.register("service-worker.js").catch((err) => {
      console.warn("Service worker não registrado:", err);
    });
  }
});

/* =====================================================================
   app.js — Estante (galeria) + armazenamento local otimizado (IndexedDB)
   ---------------------------------------------------------------------
   - Separa metadados (books) dos arquivos binários (book_files) no
     IndexedDB v2 para a galeria abrir instantaneamente sem carregar
     dezenas/centenas de MB de PDFs/EPUBs na memória RAM.
   - Mantém compatibilidade total com livros salvos na v1 (migração
     automática e transparente ao abrir um livro legado).
   - Suporta busca na estante, Drag & Drop de arquivos e notificações
     via toast global.
   ===================================================================== */

const DB_META_NAME = "estante-db";
const DB_FILES_NAME = "estante-files-db";
const STORE_BOOKS = "books";
const STORE_FILES = "book_files";

let metaDbInstance = null;
let filesDbInstance = null;
let allLibraryBooks = [];

/**
 * Abre o banco de metadados (estante-db) SEM forçar troca de versão:
 * - Se não existir, o navegador cria na v1 (criando STORE_BOOKS).
 * - Se já existir na v1 (mesmo com abas antigas abertas!) ou na v2,
 *   abre instantaneamente sem deadlock (onblocked) e sem VersionError.
 */
function openMetaDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_META_NAME);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        const store = db.createObjectStore(STORE_BOOKS, { keyPath: "id" });
        store.createIndex("title", "title", { unique: false });
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      db.onversionchange = () => {
        try { db.close(); } catch (_) {}
        if (metaDbInstance === db) metaDbInstance = null;
      };
      resolve(db);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Abre o banco dedicado aos binários (estante-files-db v1).
 * Separar os arquivos em um banco próprio evita qualquer bloqueio
 * de upgrade no estante-db e mantém a abertura da estante leve na RAM.
 */
function openFilesDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_FILES_NAME, 1);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        db.createObjectStore(STORE_FILES, { keyPath: "id" });
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      db.onversionchange = () => {
        try { db.close(); } catch (_) {}
        if (filesDbInstance === db) filesDbInstance = null;
      };
      resolve(db);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

async function getMetaDB() {
  if (!metaDbInstance) metaDbInstance = await openMetaDatabase();
  return metaDbInstance;
}

async function getFilesDB() {
  if (!filesDbInstance) filesDbInstance = await openFilesDatabase();
  return filesDbInstance;
}

/** Salva metadados leves em estante-db e o binário em estante-files-db. */
async function saveBook(book) {
  const [metaDb, filesDb] = await Promise.all([getMetaDB(), getFilesDB()]);
  const { fileData, ...meta } = book;

  if (fileData !== undefined) {
    await new Promise((resolve, reject) => {
      const tx = filesDb.transaction(STORE_FILES, "readwrite");
      tx.objectStore(STORE_FILES).put({ id: meta.id, fileData });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  await new Promise((resolve, reject) => {
    const tx = metaDb.transaction(STORE_BOOKS, "readwrite");
    tx.objectStore(STORE_BOOKS).put(meta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Atualiza apenas campos leves de metadados (progresso, preferências). */
async function patchBook(id, patch) {
  const metaDb = await getMetaDB();
  return new Promise((resolve, reject) => {
    const tx = metaDb.transaction(STORE_BOOKS, "readwrite");
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

/**
 * Carrega um livro completo (metadados + fileData binário).
 * Compatível com registros novos (estante-files-db), registros v2
 * (store book_files dentro de estante-db) e registros legados v1.
 */
async function getBook(id) {
  const [metaDb, filesDb] = await Promise.all([getMetaDB(), getFilesDB()]);

  const meta = await new Promise((resolve, reject) => {
    const tx = metaDb.transaction(STORE_BOOKS, "readonly");
    const req = tx.objectStore(STORE_BOOKS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  if (!meta) return null;

  let fileEntry = await new Promise((resolve, reject) => {
    const tx = filesDb.transaction(STORE_FILES, "readonly");
    const req = tx.objectStore(STORE_FILES).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });

  // Fallback caso o binário tenha sido salvo na store book_files do estante-db v2
  if (!fileEntry && metaDb.objectStoreNames.contains(STORE_FILES)) {
    fileEntry = await new Promise((resolve, reject) => {
      const tx = metaDb.transaction(STORE_FILES, "readonly");
      const req = tx.objectStore(STORE_FILES).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  // Migração silenciosa de registros legados v1 (fileData embutido em meta)
  if (!fileEntry && meta.fileData) {
    const legacyFileData = meta.fileData;
    const cleanMeta = { ...meta };
    delete cleanMeta.fileData;
    saveBook({ ...cleanMeta, fileData: legacyFileData }).catch(() => {});
    return { ...cleanMeta, fileData: legacyFileData };
  }

  return {
    ...meta,
    fileData: fileEntry?.fileData ?? meta.fileData ?? null,
  };
}

/** Carrega apenas os metadados leves da estante (sem Blobs na RAM). */
async function getAllBooks() {
  const metaDb = await getMetaDB();
  return new Promise((resolve, reject) => {
    const tx = metaDb.transaction(STORE_BOOKS, "readonly");
    const req = tx.objectStore(STORE_BOOKS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** Remove metadados e binário do livro dos bancos locais. */
async function deleteBook(id) {
  const [metaDb, filesDb] = await Promise.all([getMetaDB(), getFilesDB()]);

  const metaStores = metaDb.objectStoreNames.contains(STORE_FILES)
    ? [STORE_BOOKS, STORE_FILES]
    : [STORE_BOOKS];

  await Promise.all([
    new Promise((resolve, reject) => {
      const tx = metaDb.transaction(metaStores, "readwrite");
      tx.objectStore(STORE_BOOKS).delete(id);
      if (metaStores.includes(STORE_FILES)) tx.objectStore(STORE_FILES).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }),
    new Promise((resolve, reject) => {
      const tx = filesDb.transaction(STORE_FILES, "readwrite");
      tx.objectStore(STORE_FILES).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }),
  ]);
}

/* --------------------------------------------------------------------
   Utilitários globais compartilhados com reader.js
   -------------------------------------------------------------------- */

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

/** Normaliza e decodifica caminhos relativos dentro de um ZIP/EPUB. */
function resolveZipPath(baseDir, relativePath) {
  if (!relativePath) return "";
  const cleanRel = relativePath.split("#")[0].split("?")[0];
  let decoded;
  try {
    decoded = decodeURIComponent(cleanRel);
  } catch (_) {
    decoded = cleanRel;
  }
  const combined = decoded.startsWith("/") ? decoded.slice(1) : baseDir + decoded;
  const parts = combined.split("/");
  const stack = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

/** Busca arquivo no JSZip tolerando encoding e diferença de maiúsculas/minúsculas. */
function findZipFile(zip, path) {
  if (!zip || !path) return null;
  let file = zip.file(path);
  if (file) return file;

  try {
    const decoded = decodeURIComponent(path);
    file = zip.file(decoded);
    if (file) return file;
  } catch (_) {}

  const lower = path.toLowerCase();
  const matchKey = Object.keys(zip.files).find((k) => k.toLowerCase() === lower);
  return matchKey ? zip.files[matchKey] : null;
}

let toastTimer = null;
function showToast(message, duration = 2200) {
  const el = document.getElementById("toast-notice");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add("hidden");
  }, duration);
}

/* --------------------------------------------------------------------
   Importação de arquivos (botão + Drag & Drop)
   -------------------------------------------------------------------- */

const fileInput = document.getElementById("file-input");
const btnImport = document.getElementById("btn-import");
const libraryGrid = document.getElementById("library-grid");
const emptyState = document.getElementById("empty-state");
const emptyStateTitle = document.getElementById("empty-state-title");
const emptyStateDesc = document.getElementById("empty-state-desc");
const librarySearch = document.getElementById("library-search");
const dropOverlay = document.getElementById("drop-overlay");
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

async function handleImportedFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) =>
    /\.(epub|pdf)$/i.test(f.name || "")
  );
  if (!files.length) {
    showToast("Selecione arquivos .epub ou .pdf.");
    return;
  }

  showLoading(files.length > 1 ? `Importando ${files.length} livros…` : "Importando livro…");
  let importedCount = 0;

  try {
    for (const file of files) {
      try {
        await importFile(file);
        importedCount++;
      } catch (err) {
        console.error("Falha ao importar", file.name, err);
        alert(`Não foi possível importar "${file.name}". Verifique se é um EPUB ou PDF válido.`);
      }
    }
  } finally {
    fileInput.value = "";
    hideLoading();
  }

  await renderLibrary();

  if (importedCount > 0) {
    showToast(
      importedCount === 1
        ? "📚 Livro adicionado à estante!"
        : `📚 ${importedCount} livros adicionados à estante!`
    );
  }
}

fileInput.addEventListener("change", (e) => handleImportedFiles(e.target.files));

// Suporte a Drag & Drop na tela da estante
let dragCounter = 0;
const viewLibraryEl = document.getElementById("view-library");

window.addEventListener("dragenter", (e) => {
  if (viewLibraryEl.classList.contains("hidden")) return;
  if (!e.dataTransfer?.types?.includes("Files")) return;
  e.preventDefault();
  dragCounter++;
  dropOverlay?.classList.remove("hidden");
});

window.addEventListener("dragover", (e) => {
  if (viewLibraryEl.classList.contains("hidden")) return;
  if (!e.dataTransfer?.types?.includes("Files")) return;
  e.preventDefault();
});

window.addEventListener("dragleave", () => {
  if (viewLibraryEl.classList.contains("hidden")) return;
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) dropOverlay?.classList.add("hidden");
});

window.addEventListener("drop", (e) => {
  if (viewLibraryEl.classList.contains("hidden")) return;
  e.preventDefault();
  dragCounter = 0;
  dropOverlay?.classList.add("hidden");
  if (e.dataTransfer?.files?.length) {
    handleImportedFiles(e.dataTransfer.files);
  }
});

/** Lê o arquivo escolhido, extrai metadados/capa e grava no IndexedDB. */
async function importFile(file) {
  const ext = file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "epub";

  const arrayBuffer = await file.arrayBuffer();

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
    title: title.trim(),
    author: author.trim(),
    cover: coverDataUrl,
    fileData: file,
    fileName: file.name,
    addedAt: Date.now(),
    progress: { location: null, percent: 0, page: 0, totalPages: 0 },
    prefs: { theme: "claro", font: "sans", fontSize: 18, pdfZoom: 1.5 },
  };

  await saveBook(book);
}

/** Extrai título, autor e capa (se existir) de um EPUB usando JSZip. */
async function extractEpubMetadata(arrayBuffer) {
  try {
    const zip = await JSZip.loadAsync(arrayBuffer);

    const containerFile = findZipFile(zip, "META-INF/container.xml");
    if (!containerFile) return {};

    const containerXmlText = await containerFile.async("text");
    const containerDoc = new DOMParser().parseFromString(containerXmlText, "text/xml");
    const rootfileEl = containerDoc.querySelector("rootfile");
    const rootfilePath = rootfileEl?.getAttribute("full-path");
    if (!rootfilePath) return {};

    const rootDir = rootfilePath.includes("/")
      ? rootfilePath.substring(0, rootfilePath.lastIndexOf("/") + 1)
      : "";

    const opfFile = findZipFile(zip, rootfilePath);
    if (!opfFile) return {};

    const opfText = await opfFile.async("text");
    const opfDoc = new DOMParser().parseFromString(opfText, "text/xml");

    const title =
      opfDoc.querySelector("title")?.textContent ||
      opfDoc.getElementsByTagName("dc:title")[0]?.textContent ||
      "";
    const author =
      opfDoc.querySelector("creator")?.textContent ||
      opfDoc.getElementsByTagName("dc:creator")[0]?.textContent ||
      "";

    const manifestItems = {};
    opfDoc.querySelectorAll("manifest > item").forEach((item) => {
      const id = item.getAttribute("id");
      const href = item.getAttribute("href");
      const mediaType = item.getAttribute("media-type") || "";
      const properties = item.getAttribute("properties") || "";
      manifestItems[id] = {
        id,
        href,
        absPath: resolveZipPath(rootDir, href),
        mediaType,
        properties,
      };
    });

    // 1. EPUB 3: properties="cover-image"
    let coverItem = Object.values(manifestItems).find((i) =>
      i.properties.split(/\s+/).includes("cover-image")
    );

    // 2. EPUB 2: <meta name="cover" content="id" />
    if (!coverItem) {
      const coverMeta = opfDoc.querySelector("meta[name='cover']");
      const coverId = coverMeta?.getAttribute("content");
      if (coverId && manifestItems[coverId]) {
        coverItem = manifestItems[coverId];
      }
    }

    // 3. Fallback: item de imagem cujo id ou href contenha "cover" ou "capa"
    if (!coverItem) {
      coverItem = Object.values(manifestItems).find(
        (i) =>
          i.mediaType.startsWith("image/") &&
          (/(cover|capa)/i.test(i.id || "") || /(cover|capa)/i.test(i.href || ""))
      );
    }

    let cover = null;
    if (coverItem && coverItem.mediaType.startsWith("image/")) {
      const coverFile = findZipFile(zip, coverItem.absPath);
      if (coverFile) {
        const base64 = await coverFile.async("base64");
        const mime = coverItem.mediaType || "image/jpeg";
        cover = `data:${mime};base64,${base64}`;
      }
    }

    return { title, author, cover };
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

    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 0.45 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

    const cover = canvas.toDataURL("image/jpeg", 0.78);
    pdf.destroy();

    return {
      title: meta?.info?.Title || null,
      author: meta?.info?.Author || null,
      cover,
    };
  } catch (err) {
    console.warn("Não foi possível ler metadados do PDF:", err);
    return {};
  }
}

/* --------------------------------------------------------------------
   Renderização da galeria ("Estante")
   -------------------------------------------------------------------- */

const SPINE_PALETTE = ["#6FA089", "#C6A15B", "#8A6FA0", "#A0716F", "#6F8FA0", "#A0946F"];
function spineColorFor(title) {
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = title.charCodeAt(i) + ((hash << 5) - hash);
  return SPINE_PALETTE[Math.abs(hash) % SPINE_PALETTE.length];
}

function renderBookCards(books, query = "") {
  libraryGrid.innerHTML = "";

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? books.filter(
        (b) =>
          (b.title || "").toLowerCase().includes(normalizedQuery) ||
          (b.author || "").toLowerCase().includes(normalizedQuery)
      )
    : books;

  if (filtered.length === 0) {
    emptyState.classList.remove("hidden");
    emptyState.classList.add("flex");
    if (normalizedQuery && books.length > 0) {
      emptyStateTitle.textContent = "Nenhum livro encontrado";
      emptyStateDesc.textContent = `Não encontramos resultados para "${query}".`;
    } else {
      emptyStateTitle.textContent = "Sua estante está vazia";
      emptyStateDesc.textContent =
        "Importe ou arraste um arquivo .epub ou .pdf para começar a ler. Tudo fica salvo apenas no seu dispositivo.";
    }
    return;
  }

  emptyState.classList.add("hidden");
  emptyState.classList.remove("flex");

  for (const book of filtered) {
    const card = document.createElement("div");
    card.className =
      "focus-ring group relative text-left rounded-lg overflow-hidden bg-[var(--ink-soft)] border border-white/5 hover:border-[var(--verdigris)]/60 transition-colors";

    const spine = spineColorFor(book.title || "");
    const safeTitle = escapeHtml(book.title);
    const safeAuthor = escapeHtml(book.author || (book.type === "pdf" ? "PDF" : "EPUB"));

    const coverInner = book.cover
      ? `<img src="${book.cover}" alt="" loading="lazy" class="w-full h-44 object-cover" />`
      : `<div class="cover-fallback w-full h-44 flex items-end p-3" style="--cover-a:${spine}55;--cover-b:#1B2129">
           <p class="font-display text-sm leading-snug text-white/90 line-clamp-4">${safeTitle}</p>
         </div>`;

    const pct = Math.min(100, Math.max(0, Math.round(book.progress?.percent || 0)));

    card.innerHTML = `
      <button class="btn-open-book w-full text-left" aria-label="Abrir ${safeTitle}">
        <div class="book-spine" style="--spine-color:${spine}">
          ${coverInner}
        </div>
        <div class="p-2.5 pr-9">
          <p class="text-xs font-medium truncate">${safeTitle}</p>
          <p class="text-[11px] text-white/45 truncate">${safeAuthor}</p>
          ${pct > 0 ? `
            <div class="h-1 mt-2 rounded-full bg-white/10 overflow-hidden">
              <div class="h-full bg-[var(--verdigris)]" style="width:${pct}%"></div>
            </div>` : ""}
        </div>
      </button>
      <button class="btn-delete-book absolute bottom-2 right-2 p-1.5 rounded-full bg-black/45 hover:bg-red-500/85 text-white/80 hover:text-white opacity-90 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 transition-all" title="Excluir livro" aria-label="Excluir ${safeTitle}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
      </button>
    `;

    card.querySelector(".btn-open-book").addEventListener("click", () => openReader(book.id));

    card.querySelector(".btn-delete-book").addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmDelete = confirm(`Deseja mesmo excluir "${book.title}" da sua estante?`);
      if (confirmDelete) {
        await deleteBook(book.id);
        showToast("Livro removido da estante.");
        await renderLibrary();
      }
    });

    libraryGrid.appendChild(card);
  }
}

async function renderLibrary() {
  try {
    allLibraryBooks = await getAllBooks();
    allLibraryBooks.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    renderBookCards(allLibraryBooks, librarySearch?.value || "");
  } catch (err) {
    console.error("Erro ao carregar biblioteca do IndexedDB:", err);
    allLibraryBooks = [];
    renderBookCards([], "");
    showToast("Não foi possível acessar o armazenamento local do navegador.", 4000);
  }
}

if (librarySearch) {
  librarySearch.addEventListener("input", () => {
    renderBookCards(allLibraryBooks, librarySearch.value);
  });
}

/* --------------------------------------------------------------------
   Inicialização + registro do Service Worker (PWA)
   -------------------------------------------------------------------- */

function bootEstante() {
  renderLibrary();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("service-worker.js")
      .then((reg) => {
        reg.update().catch(() => {});
      })
      .catch((err) => {
        console.warn("Service worker não registrado:", err);
      });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootEstante);
} else {
  bootEstante();
}

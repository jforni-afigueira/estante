# Estante — Leitor Digital (E-Reader PWA)

Leitor de **EPUB** e **PDF** com narração por voz (TTS híbrido em pt-BR: vozes do navegador + **Piper Neural Offline**), 100% local, gratuito e instalável como app (PWA). Não usa build step ou servidor próprio — apenas HTML, CSS (Tailwind via CDN) e JavaScript puro.

## Recursos principais

- **Leitor EPUB nativo (`JSZip` + `DOMParser`)**: sem iframes, com índice de capítulos instantâneo (EPUB 3 `nav` / EPUB 2 `ncx`), imagens locais via Blob URLs, links internos e temas nativos (*Claro*, *Sépia*, *Escuro*).
- **Leitor PDF híbrido (`pdf.js`)**: renderização visual HiDPI com zoom e filtros de tema (incluindo PDFs escaneados/imagem) + extração de texto com TTS.
- **TTS híbrido em pt-BR**:
  - **Modo Navegador (0 MB)**: fatiado por frase (sem cortes), destaque palavra-a-palavra, priorização automática das melhores vozes neurais nativas e seletor de voz.
  - **Modo Neural Offline (Piper ONNX/WASM)**: baixa o modelo `pt_BR-faber-medium` uma única vez para o cache local (OPFS) e narra 100% offline com pré-síntese da próxima frase.
- **Experiência diária**: clique na palavra para ler (*Click-to-Read*), salto por parágrafo, velocidade de `0.5x` a `3.0x`, marcador exato (EPUB e PDF), busca no texto, busca e Drag & Drop na estante, Media Session (tela de bloqueio / fone Bluetooth), Wake Lock, temporizador de sono e gestos/atalhos de teclado.

## Rodando localmente

Como o app usa `IndexedDB`, `OPFS` e Service Worker, precisa ser servido via `http://`:

```bash
npm start
# ou: python3 -m http.server 8000
# depois acesse http://localhost:8000
```

## Publicando no GitHub Pages (grátis)

Este repositório inclui o workflow `.github/workflows/deploy.yml`, que publica automaticamente a cada `push` na branch `main`.

1. Vá em **Settings → Pages** no repositório do GitHub.
2. Em **Build and deployment → Source**, selecione **GitHub Actions**.
3. Aguarde o workflow rodar (aba **Actions**) — o link ficará disponível em `https://<seu-usuario>.github.io/estante/`.

## Estrutura

```
index.html         → estrutura da estante, leitor e modais
app.js             → IndexedDB (estante-db + estante-files-db), importação, busca, galeria
reader.js          → motor EPUB nativo, PDF HiDPI, TTS híbrido, Media Session, busca
tts-neural.js      → ponte ES Module para o motor neural Piper pt-BR (ONNX/WASM)
manifest.json      → configuração de instalação (PWA)
service-worker.js  → cache v2 do app shell (uso offline)
icon-192.png / icon-512.png → ícones do app
```

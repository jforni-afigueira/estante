# Estante — Leitor Digital (E-Reader PWA)

Leitor de **EPUB** e **PDF** com narração por voz (TTS em pt-BR), 100% local,
gratuito e instalável como app (PWA). Não usa build step, Node.js ou servidor
próprio — apenas HTML, CSS (Tailwind via CDN) e JavaScript puro.

## Rodando localmente

Como o app usa `IndexedDB` e Service Worker, ele precisa ser servido via
`http://` (não abra o `index.html` direto com duplo clique). Qualquer
servidor estático simples resolve:

```bash
python3 -m http.server 8000
# depois acesse http://localhost:8000
```

## Publicando no GitHub Pages (grátis)

Este repositório já inclui o workflow `.github/workflows/deploy.yml`, que
publica o conteúdo automaticamente a cada `push` na branch `main`.

1. Depois do primeiro `git push`, vá em **Settings → Pages** do repositório
   no GitHub.
2. Em **Build and deployment → Source**, selecione **GitHub Actions**.
3. Aguarde o workflow rodar (aba **Actions**) — o link ficará disponível em
   `https://<seu-usuario>.github.io/estante/`.

## Estrutura

```
index.html         → estrutura da estante e do leitor
app.js              → IndexedDB, importação de arquivos, galeria
reader.js           → epub.js / pdf.js, temas, fonte, TTS
manifest.json       → configuração de instalação (PWA)
service-worker.js   → cache do app shell (uso offline)
icon-192.png / icon-512.png → ícones do app
```

## Observações

- Os livros importados (EPUB/PDF) ficam salvos apenas no `IndexedDB` do
  navegador de quem usa o app — nada é enviado a nenhum servidor.
- As bibliotecas `epub.js`, `pdf.js` e `Tailwind` vêm de CDN e são
  cacheadas pelo Service Worker após o primeiro acesso online.

# UPSC Notes

A free, offline-first markdown notes app for UPSC Civil Services preparation — GS I–IV,
Essay, current affairs and optionals. Live at **https://upscnotes.hashin.me**.

- **Everything runs in the browser.** Notes are stored in IndexedDB and work fully offline (PWA).
- **Backed up to the student's own Google Drive** — a plain `UPSC Notes/` folder of `.md`
  files they own. The app writes to Drive directly from the browser; no server touches a note.
- **Publish** selected notes at `upscnotes.hashin.me/<username>`, rendered from the student's
  public Drive files.
- **Costs nothing to operate at any scale.** See "How it stays free" below.

## Stack

| Layer | Tech |
|---|---|
| App | Vanilla TS + Vite, CodeMirror 6, markdown-it, KaTeX, Mermaid, highlight.js |
| Local store | IndexedDB (`idb`), MiniSearch for full-text search |
| Auth | Google Identity Services (client-side); ID token + `drive.file` OAuth token |
| Sync | Drive REST v3, called straight from the browser |
| Hosting | Cloudflare Pages (static, unlimited bandwidth) |
| Backend | One Cloudflare Pages Function + D1 + R2 — **username registry only** |

## How it stays free

1. Static hosting: Cloudflare Pages free plan = unlimited requests + bandwidth.
2. Note create/edit/render/search + all Drive I/O: 100% in the browser, on the student's own
   Google quota.
3. Public profile view: browser reads a tiny pointer JSON from **R2 (edge-cached)** then
   fetches note bodies straight from **Google's CDN**. The Worker is not involved.
4. The Worker/Function runs only on **username claim / rename** — a handful of D1 writes per
   student, ever. D1 free tier is 100k writes *per day*.

If a free limit were ever hit, only *new* public-profile resolution pauses until 00:00 UTC;
every signed-in student keeps editing locally and syncing to their own Drive.

## Develop

```bash
npm install
npm run dev          # http://localhost:5173  — works in local-only mode with no config
npm run build        # -> dist/
npm run typecheck
```

Local-only mode (no `GOOGLE_CLIENT_ID`) gives you the full editor, offline storage,
templates, search and export. Sign-in, Drive sync and publishing need the setup below.

## Deploy

The static app auto-deploys to GitHub Pages on every push to `master`
(`.github/workflows/deploy.yml`). See [docs/SETUP.md](docs/SETUP.md): add one Spaceship
DNS record to go live; Google OAuth + a Cloudflare Worker (both optional) enable sign-in,
Drive backup and publishing.

## License

MIT. Your data lives only in your browser and your own Google Drive.

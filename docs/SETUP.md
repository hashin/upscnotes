# Setup — going live at upscnotes.hashin.me

The static app is already deployed to **GitHub Pages** from this repo (see
`.github/workflows/deploy.yml`, which runs on every push to `master`). What's left:

1. **DNS** — one record at Spaceship. Makes the site reachable. *(required)*
2. **Google OAuth + Cloudflare Worker** — enables sign-in, Drive backup and publishing.
   *(optional; the notes editor, offline storage, templates and export all work without it)*

---

## 1. DNS at Spaceship  (required, ~2 min + propagation)

In the Spaceship dashboard → **hashin.me → Advanced DNS / DNS records → add record**:

| Type  | Host / Name | Value / Target      | TTL     |
|-------|-------------|---------------------|---------|
| CNAME | `upscnotes` | `hashin.github.io`  | default |

This is exactly the same shape as the existing `blog` → `hashin.github.io` record.

After it propagates (minutes), GitHub auto-provisions an HTTPS certificate for
`upscnotes.hashin.me` (can take up to an hour). Then `https://upscnotes.hashin.me` is live.

Check progress:

```bash
dig +short upscnotes.hashin.me            # should return hashin.github.io.
gh api repos/hashin/upscnotes/pages --jq '.https_certificate.state'   # -> "approved"
```

The repo already has `public/CNAME` = `upscnotes.hashin.me`, so nothing else is needed.

---

## 2. Google OAuth  (optional — turns on sign-in / Drive / publishing)

1. <https://console.cloud.google.com/> → **New Project** → `upsc-notes`.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **OAuth consent screen** → External → fill app name `UPSC Notes` + your emails →
   add scopes `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`,
   `.../auth/drive.file` → **Publish app** (`drive.file` is non-sensitive: no verification,
   no user cap).
4. **Credentials → Create → OAuth client ID → Web application**:
   - Authorized JavaScript origins: `http://localhost:5173` and `https://upscnotes.hashin.me`
   - Copy the **Client ID** (`…apps.googleusercontent.com`).
5. **Credentials → Create → API key** → copy it → **Edit**:
   - Application restrictions → **Websites**: `https://upscnotes.hashin.me/*`, `http://localhost:5173/*`
   - API restrictions → **Google Drive API** only.
   - (Only used to read public note files on the public profile pages.)

---

## 3. Cloudflare Worker + D1 + R2  (optional — the username registry)

```bash
npm i -g wrangler
wrangler login

wrangler d1 create upscnotes
#   -> paste database_id into worker/wrangler.toml
wrangler d1 execute upscnotes --remote --file=schema.sql

wrangler r2 bucket create upscnotes-registry

cd worker
#   set the OAuth client id (not a secret, but this keeps it out of git):
wrangler secret put GOOGLE_CLIENT_ID       # paste the Client ID from step 2.4
wrangler deploy
#   -> note the deployed URL, e.g. https://upscnotes-api.<account>.workers.dev
```

Make the R2 bucket public on a subdomain: **Cloudflare dashboard → R2 →
upscnotes-registry → Settings → Public access → Connect custom domain** →
`registry.upscnotes.hashin.me`. Cloudflare will show a CNAME target — add it at Spaceship:

| Type  | Host / Name | Value / Target                    |
|-------|-------------|-----------------------------------|
| CNAME | `registry`  | *(target Cloudflare shows)*        |

(This needs hashin.me to be reachable by Cloudflare for the cert — a Spaceship CNAME to an
`*.r2.dev` style hostname works; follow the dashboard's exact instructions.)

---

## 4. Wire the client to the backend

Edit `src/config.ts`:

```ts
GOOGLE_CLIENT_ID: '….apps.googleusercontent.com',
GOOGLE_API_KEY:   'AIza…',
API_BASE:         'https://upscnotes-api.<account>.workers.dev',
REGISTRY_BASE:    'https://registry.upscnotes.hashin.me',
SITE_URL:         'https://upscnotes.hashin.me',
```

```bash
git commit -am "Wire Google + Cloudflare backend" && git push
```

The GitHub Action redeploys automatically.

---

## Verify

| Check | Expected |
|---|---|
| `https://upscnotes.hashin.me` loads, works offline after first visit | ✅ static app |
| `/about` and `/<name>` deep links load on refresh | ✅ SPA 404 fallback |
| Account → Sign in → Connect Drive | `UPSC Notes/` folder of `.md` files appears in Drive |
| Claim username `hashin`, mark a note Public, open `/hashin` in incognito | note renders logged-out |
| DevTools Network on `/hashin` repeat load | pointer from `registry.…`, body from `googleapis.com`, **no `/api/*`** |
| `wrangler tail` (in `worker/`) during a claim | one `POST /claim`; `wrangler d1 execute upscnotes --remote --command "SELECT * FROM users"` shows the row |

## Operating notes

- **Free-tier headroom:** GitHub Pages soft-limits static bandwidth at ~100 GB/mo; the
  Worker free tier is 100k req/day and D1 is 100k writes/day. The read path (profile views)
  is served from R2 edge cache + Google's CDN, so the Worker is hit only on username
  claims/renames. If you outgrow GitHub Pages, move the static host to Cloudflare Pages —
  same repo, `public/_redirects` is already there.
- **Backups vs publishing:** every synced note is a private `.md` in the student's Drive.
  Publishing flips that one file (+ its images) to anyone-with-link and lists it in the
  public `profile.json`. Un-publishing reverts the sharing.
- **Abuse:** `worker/src/index.ts` rate-limits claims per Google account; add Cloudflare
  Turnstile in front of `/claim` if you see scripted signups.

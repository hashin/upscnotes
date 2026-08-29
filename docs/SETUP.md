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

## 3. Cloudflare Worker + D1  (optional — the username registry)

No R2, no extra DNS. The Worker runs on its own `*.workers.dev` domain and serves both the
username claim/check and the public `username -> profile` lookup (`GET /u/<name>`,
edge-cached; a cache hit does zero DB work, a miss is one indexed D1 read).

```bash
npm i -g wrangler
wrangler login

wrangler d1 create upscnotes
#   -> paste database_id into worker/wrangler.toml

cd worker
wrangler d1 execute upscnotes --remote --file=../schema.sql
wrangler secret put GOOGLE_CLIENT_ID       # paste the Client ID from step 2.4
wrangler deploy
#   -> note the deployed URL, e.g. https://upscnotes-api.<account>.workers.dev
```

---

## 4. Wire the client to the backend

Edit `src/config.ts`:

```ts
GOOGLE_CLIENT_ID: '….apps.googleusercontent.com',
GOOGLE_API_KEY:   'AIza…',
API_BASE:         'https://upscnotes-api.<account>.workers.dev',
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
| DevTools Network on `/hashin` repeat load | `GET /u/<name>` + body from `googleapis.com`; repeat views are edge-cached |
| `wrangler tail` (in `worker/`) during a claim | one `POST /claim`; `wrangler d1 execute upscnotes --remote --command "SELECT * FROM users"` shows the row |

## Operating notes

- **Free-tier headroom:** GitHub Pages soft-limits static bandwidth at ~100 GB/mo; the
  Worker free tier is 100k req/day and D1 is 5M reads / 100k writes per day. Note bodies are
  fetched straight from Google's CDN, and profile lookups are edge-cached, so the Worker is
  hit mainly on username claims/renames and cache-miss lookups. If you outgrow GitHub Pages,
  move the static host to Cloudflare Pages — same repo, `public/_redirects` is already there.
- **Backups vs publishing:** every synced note is a private `.md` in the student's Drive.
  Publishing flips that one file (+ its images) to anyone-with-link and lists it in the
  public `profile.json` in their Drive. Un-publishing reverts the sharing.
- **Abuse:** `worker/src/index.ts` rate-limits claims per Google account; add Cloudflare
  Turnstile in front of `/claim` if you see scripted signups.

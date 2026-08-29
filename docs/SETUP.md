# Setup — going live at upscnotes.hashin.me

About 20 minutes. Everything below is free. None of the values you paste into `src/config.ts`
are secret (they are all public client identifiers).

Order: **1) GitHub → 2) Google Cloud → 3) Cloudflare → 4) DNS → 5) config + deploy.**

---

## 1. GitHub

```bash
cd /Users/hashin/Documents/GitHub/upscnotes
git add -A && git commit -m "Initial UPSC Notes app"
gh repo create hashin/upscnotes --public --source=. --push
```

---

## 2. Google Cloud — OAuth for sign-in + Drive

1. <https://console.cloud.google.com/> → **New Project** → name `upsc-notes`.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External** → Create.
   - App name `UPSC Notes`, support email your address, developer email your address.
   - **Scopes**: add `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `openid`, and
     `.../auth/drive.file`. `drive.file` is **non-sensitive** — no Google verification/audit,
     no user cap.
   - Save, then **Publish app** (moves it out of "Testing" so any Google user can sign in).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Type **Web application**, name `upscnotes-web`.
   - **Authorized JavaScript origins**:
     - `http://localhost:5173`
     - `https://upscnotes.hashin.me`
   - Create → copy the **Client ID** (`…apps.googleusercontent.com`).
5. **Create credentials → API key**:
   - Copy the key.
   - **Edit** it → *Application restrictions* → **Websites**, add
     `https://upscnotes.hashin.me/*` and `http://localhost:5173/*`.
   - *API restrictions* → restrict to **Google Drive API**.
   - This key only reads public, anyone-with-link note files on the public profile pages.

---

## 3. Cloudflare — Pages + D1 + R2

```bash
npm i -g wrangler
wrangler login

# D1 (username registry)
wrangler d1 create upscnotes
#   -> copy the printed database_id into wrangler.toml  ([[d1_databases]].database_id)
wrangler d1 execute upscnotes --remote --file=schema.sql

# R2 (edge-cached username -> profile pointer objects)
wrangler r2 bucket create upscnotes-registry
```

Then in the **Cloudflare dashboard**:

1. **Workers & Pages → Create → Pages → Connect to Git** → pick `hashin/upscnotes`.
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Save and deploy.
2. Pages project → **Settings → Functions → D1 database bindings**: add
   `DB` → `upscnotes`.
3. **Settings → Functions → R2 bucket bindings**: add `REGISTRY` → `upscnotes-registry`.
4. **Settings → Environment variables** (Production *and* Preview): add
   `GOOGLE_CLIENT_ID` = the client ID from step 2.4.
5. **Settings → Custom domains**: add `upscnotes.hashin.me`.
6. Make the R2 bucket publicly readable on a subdomain: **R2 → upscnotes-registry →
   Settings → Public access → Connect a custom domain** → `registry.upscnotes.hashin.me`.

---

## 4. DNS (wherever hashin.me is managed)

| Type | Name | Value |
|---|---|---|
| CNAME | `upscnotes` | `<your-pages-project>.pages.dev` |
| CNAME | `registry` | (the target Cloudflare shows for the R2 custom domain) |

If hashin.me is already on Cloudflare, adding the custom domains in steps 3.5 / 3.6 creates
these records for you.

---

## 5. config + deploy

Edit `src/config.ts`:

```ts
GOOGLE_CLIENT_ID: '1234-abc.apps.googleusercontent.com',
GOOGLE_API_KEY:   'AIza...',
API_BASE:         '',                                  // same origin — leave empty
REGISTRY_BASE:    'https://registry.upscnotes.hashin.me',
SITE_URL:         'https://upscnotes.hashin.me',
```

```bash
git commit -am "Configure Google + Cloudflare" && git push
```

Cloudflare Pages redeploys on push. Done.

---

## Verify

1. Open `https://upscnotes.hashin.me` → create notes, go offline (DevTools) → reload → still works.
2. **Account → Sign in** with Google → **Connect Google Drive** → a `UPSC Notes/` folder of
   `.md` files appears in your Drive.
3. **Account → claim a username** (e.g. `hashin`).
4. Toggle **Public** on a note → open `https://upscnotes.hashin.me/hashin` in an incognito
   window → the note renders while logged out.
5. DevTools → Network on that page: the pointer comes from `registry.upscnotes.hashin.me`
   and the note body from `googleapis.com`/`googleusercontent.com` — **no request to
   `/api/*`** on a repeat load.
6. `wrangler pages deployment tail` while claiming a username → exactly one `POST /api/claim`;
   `wrangler d1 execute upscnotes --remote --command "SELECT * FROM users"` shows the row.

## Notes

- **Backups vs. publishing.** Every synced note is a private `.md` in the student's Drive.
  Publishing only flips that one file (and its images) to anyone-with-link and lists it in
  the public `profile.json`. Un-publishing reverts the sharing.
- **Deleting the R2 pointer** (via `DELETE /api/account`, exposed in a future settings action)
  removes a username from routing; the student's Drive files are untouched.
- **Abuse control.** `functions/api/[[route]].ts` rate-limits claims per Google account.
  Add Cloudflare Turnstile in front of `/api/claim` if you see scripted signups.

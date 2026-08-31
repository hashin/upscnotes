/**
 * Cloudflare Worker — the ONLY server-side code in this project.
 *
 * The app is hosted as a static site on GitHub Pages; this Worker is deployed separately
 * (e.g. upscnotes-api.<account>.workers.dev) and does only:
 *   1. the OAuth code<->token exchange + refresh (holds the client secret)
 *   2. verify the caller's Google access token (tokeninfo)
 *   3. keep the `username -> profile pointer` registry unique (D1), and serve public
 *      username -> profile lookups (`GET /u/<name>`, edge-cached via the Cache API)
 *
 * Notes never pass through here — they live in each student's Google Drive and are read by
 * the browser directly from Google's CDN.
 */

export interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  /** OAuth client secret — Worker secret, only used for the redirect (auth-code) flow. */
  GOOGLE_CLIENT_SECRET: string;
  /** Browser API key for reading public Drive files (used to build note body URLs). */
  GOOGLE_API_KEY?: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;
const RESERVED = new Set([
  'api', 'app', 'about', 'admin', 'assets', 'auth', 'blog', 'docs', 'help', 'login', 'logout',
  'me', 'new', 'note', 'notes', 'privacy', 'profile', 'public', 'registry', 'settings', 'signin',
  'signup', 'static', 'support', 'terms', 'u', 'user', 'users', 'www',
]);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-max-age': '86400',
};

const json = (data: unknown, status = 200, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';
    try {
      if (request.method === 'GET' && path === '/') return json({ ok: true, service: 'upscnotes-api' });
      if (request.method === 'POST' && path === '/oauth/exchange') return await oauthExchange(request, env);
      if (request.method === 'POST' && path === '/oauth/refresh') return await oauthRefresh(request, env);
      if (request.method === 'GET' && path === '/me') return await me(request, env);
      if (request.method === 'GET' && path === '/check') return await check(env, url);
      if (request.method === 'GET' && path.startsWith('/u/')) return await resolveProfile(env, ctx, request, decodeURIComponent(path.slice(3)));
      if (request.method === 'POST' && path === '/claim') return await claim(request, env);
      if (request.method === 'POST' && path === '/profile') return await updateProfile(request, env);
      if (request.method === 'POST' && path === '/publish') return await publishNote(request, env);
      if (request.method === 'DELETE' && path === '/publish') return await unpublishNote(request, env, url);
      if (request.method === 'DELETE' && path === '/account') return await deleteAccount(request, env);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      if (e instanceof Response) return e;
      return json({ error: (e as Error).message ?? 'server error' }, 500);
    }
  },
};

/* ---------------- OAuth redirect (auth-code) flow ---------------- */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

async function oauthExchange(request: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_CLIENT_SECRET) return json({ error: 'server missing GOOGLE_CLIENT_SECRET' }, 500);
  const { code, redirect_uri, code_verifier } = await request.json<{
    code?: string;
    redirect_uri?: string;
    code_verifier?: string;
  }>();
  if (!code || !redirect_uri || !code_verifier) return json({ error: 'missing code / redirect_uri / verifier' }, 400);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri,
    code_verifier,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = (await res.json()) as any;
  if (!res.ok) return json({ error: data.error_description ?? data.error ?? 'token exchange failed' }, 400);
  return json({
    access_token: data.access_token,
    expires_in: data.expires_in,
    refresh_token: data.refresh_token ?? null,
    id_token: data.id_token ?? null,
    scope: data.scope,
  });
}

async function oauthRefresh(request: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_CLIENT_SECRET) return json({ error: 'server missing GOOGLE_CLIENT_SECRET' }, 500);
  const { refresh_token } = await request.json<{ refresh_token?: string }>();
  if (!refresh_token) return json({ error: 'missing refresh_token' }, 400);

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = (await res.json()) as any;
  if (!res.ok) {
    // invalid_grant => the refresh token was revoked or expired; tell the client to re-auth.
    return json({ error: data.error ?? 'refresh failed', reauth: data.error === 'invalid_grant' }, 401);
  }
  return json({ access_token: data.access_token, expires_in: data.expires_in, id_token: data.id_token ?? null });
}

function bodyUrl(env: Env, driveFileId: string): string {
  const key = env.GOOGLE_API_KEY ? `&key=${env.GOOGLE_API_KEY}` : '';
  return `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media${key}`;
}

interface PubNoteRow {
  slug: string;
  title: string;
  tags: string | null;
  syllabus: string | null;
  drive_file_id: string;
  words: number | null;
  updated_at: number;
}

/**
 * Public: the full profile + published-note index for a username, straight from D1 (the
 * single source of truth). Edge-cached 60s. Note *bodies* are still fetched by the browser
 * directly from Google's CDN.
 */
async function resolveProfile(env: Env, ctx: ExecutionContext, request: Request, username: string): Promise<Response> {
  const name = username.toLowerCase().replace(/\.json$/, '');
  if (!USERNAME_RE.test(name)) return json({ error: 'invalid username' }, 404);

  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).origin + '/u/' + name);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const profile = await env.DB.prepare(
    'SELECT p.sub AS sub, p.display_name AS displayName, p.bio AS bio, p.avatar_url AS avatar FROM profiles p JOIN users u ON u.sub = p.sub WHERE u.username = ?',
  ).bind(name).first<{ sub: string; displayName: string | null; bio: string | null; avatar: string | null }>();
  if (!profile) return json({ error: 'not found' }, 404, { 'cache-control': 'public, max-age=30' });

  const notes = await env.DB.prepare(
    'SELECT slug, title, tags, syllabus, drive_file_id, words, updated_at FROM pub_notes WHERE sub = ? ORDER BY updated_at DESC',
  ).bind(profile.sub).all<PubNoteRow>();

  const payload = {
    v: 2,
    username: name,
    displayName: profile.displayName || name,
    bio: profile.bio || '',
    avatar: profile.avatar || '',
    updatedAt: (notes.results ?? []).reduce((m, n) => Math.max(m, n.updated_at), 0),
    notes: (notes.results ?? []).map((n) => ({
      slug: n.slug,
      title: n.title,
      tags: n.tags ? JSON.parse(n.tags) : [],
      syllabus: n.syllabus ? JSON.parse(n.syllabus) : [],
      updatedAt: n.updated_at,
      words: n.words ?? 0,
      url: bodyUrl(env, n.drive_file_id),
    })),
  };

  const res = json(payload, 200, { 'cache-control': 'public, max-age=60, s-maxage=60' });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

/* ---------------- handlers ---------------- */

function validateName(name: string): string | null {
  if (!USERNAME_RE.test(name)) return 'invalid username format';
  if (RESERVED.has(name)) return 'reserved username';
  return null;
}

/** The caller's own record — username, profile fields, and the set of note ids they publish. */
async function me(request: Request, env: Env): Promise<Response> {
  const caller = await verifyCaller(request, env);
  const user = await env.DB.prepare('SELECT username FROM users WHERE sub = ?').bind(caller.sub).first<{ username: string }>();
  if (!user) return json({ username: null }, 200, { 'cache-control': 'no-store' });

  const profile = await env.DB.prepare('SELECT display_name, bio, avatar_url FROM profiles WHERE sub = ?')
    .bind(caller.sub)
    .first<{ display_name: string | null; bio: string | null; avatar_url: string | null }>();
  const notes = await env.DB.prepare('SELECT note_id, slug FROM pub_notes WHERE sub = ?')
    .bind(caller.sub)
    .all<{ note_id: string; slug: string }>();

  return json(
    {
      username: user.username,
      displayName: profile?.display_name ?? null,
      bio: profile?.bio ?? null,
      avatar: profile?.avatar_url ?? null,
      published: (notes.results ?? []).map((n) => ({ noteId: n.note_id, slug: n.slug })),
    },
    200,
    { 'cache-control': 'no-store' },
  );
}

async function bustProfileCache(ctxUrlOrigin: string, username: string): Promise<void> {
  await caches.default.delete(new Request(ctxUrlOrigin + '/u/' + username)).catch(() => {});
}

async function check(env: Env, url: URL): Promise<Response> {
  const name = (url.searchParams.get('username') ?? '').toLowerCase();
  const bad = validateName(name);
  if (bad) return json({ available: false, reason: bad });
  const row = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(name).first();
  return json({ available: !row, reason: row ? 'taken' : undefined }, 200, { 'cache-control': 'public, max-age=20' });
}

async function claim(request: Request, env: Env): Promise<Response> {
  const claims = await verifyCaller(request, env);
  const body = await request.json<{ username?: string; displayName?: string; avatar?: string }>();
  const name = (body.username ?? '').toLowerCase().trim();
  const bad = validateName(name);
  if (bad) return json({ error: bad }, 400);

  await rateLimit(env, `claim:${claims.sub}`, 20, 3600);

  const existing = await env.DB.prepare('SELECT username FROM users WHERE sub = ?').bind(claims.sub).first<{ username: string }>();
  const taken = await env.DB.prepare('SELECT sub FROM users WHERE username = ?').bind(name).first<{ sub: string }>();
  if (taken && taken.sub !== claims.sub) return json({ error: 'That username is taken.' }, 409);

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (sub, username, email, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT(sub) DO UPDATE SET username = ?2, email = ?3, updated_at = ?4`,
    ).bind(claims.sub, name, claims.email ?? '', now),
    env.DB.prepare(
      `INSERT INTO profiles (sub, username, display_name, avatar_url, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(sub) DO UPDATE SET username = ?2,
         display_name = COALESCE(NULLIF(?3,''), display_name),
         avatar_url = COALESCE(NULLIF(?4,''), avatar_url),
         updated_at = ?5`,
    ).bind(claims.sub, name, body.displayName ?? '', body.avatar ?? '', now),
  ]);
  if (existing && existing.username !== name) await bustProfileCache(new URL(request.url).origin, existing.username);
  await bustProfileCache(new URL(request.url).origin, name);
  return json({ ok: true, username: name });
}

async function updateProfile(request: Request, env: Env): Promise<Response> {
  const claims = await verifyCaller(request, env);
  const body = await request.json<{ displayName?: string; bio?: string; avatar?: string }>();
  const row = await env.DB.prepare('SELECT username FROM users WHERE sub = ?').bind(claims.sub).first<{ username: string }>();
  if (!row) return json({ error: 'no username claimed' }, 404);
  await env.DB.prepare(
    `UPDATE profiles SET display_name = ?, bio = ?, avatar_url = COALESCE(NULLIF(?,''), avatar_url), updated_at = ?
     WHERE sub = ?`,
  ).bind(body.displayName ?? row.username, body.bio ?? '', body.avatar ?? '', Date.now(), claims.sub).run();
  await bustProfileCache(new URL(request.url).origin, row.username);
  return json({ ok: true });
}

async function publishNote(request: Request, env: Env): Promise<Response> {
  const claims = await verifyCaller(request, env);
  const b = await request.json<{
    noteId?: string; slug?: string; title?: string; tags?: string[]; syllabus?: string[];
    driveFileId?: string; words?: number; updatedAt?: number;
  }>();
  if (!b.noteId || !b.driveFileId || !b.slug || !b.title) return json({ error: 'missing fields' }, 400);
  const slug = b.slug.toLowerCase();
  if (!SLUG_RE.test(slug)) return json({ error: 'bad slug' }, 400);

  const user = await env.DB.prepare('SELECT username FROM users WHERE sub = ?').bind(claims.sub).first<{ username: string }>();
  if (!user) return json({ error: 'claim a username first' }, 409);

  // Slug must be unique within this user's published set.
  const clash = await env.DB.prepare('SELECT note_id FROM pub_notes WHERE sub = ? AND slug = ? AND note_id != ?')
    .bind(claims.sub, slug, b.noteId)
    .first<{ note_id: string }>();
  if (clash) return json({ error: 'slug-taken' }, 409);

  await env.DB.prepare(
    `INSERT INTO pub_notes (sub, note_id, slug, title, tags, syllabus, drive_file_id, words, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
     ON CONFLICT(sub, note_id) DO UPDATE SET
       slug=?3, title=?4, tags=?5, syllabus=?6, drive_file_id=?7, words=?8, updated_at=?9`,
  ).bind(
    claims.sub, b.noteId, slug, b.title,
    JSON.stringify(b.tags ?? []), JSON.stringify(b.syllabus ?? []),
    b.driveFileId, b.words ?? 0, b.updatedAt ?? Date.now(),
  ).run();

  await bustProfileCache(new URL(request.url).origin, user.username);
  return json({ ok: true, slug });
}

async function unpublishNote(request: Request, env: Env, url: URL): Promise<Response> {
  const claims = await verifyCaller(request, env);
  const noteId = url.searchParams.get('noteId');
  if (!noteId) return json({ error: 'missing noteId' }, 400);
  const user = await env.DB.prepare('SELECT username FROM users WHERE sub = ?').bind(claims.sub).first<{ username: string }>();
  await env.DB.prepare('DELETE FROM pub_notes WHERE sub = ? AND note_id = ?').bind(claims.sub, noteId).run();
  if (user) await bustProfileCache(url.origin, user.username);
  return json({ ok: true });
}

async function deleteAccount(request: Request, env: Env): Promise<Response> {
  const claims = await verifyCaller(request, env);
  const row = await env.DB.prepare('SELECT username FROM users WHERE sub = ?').bind(claims.sub).first<{ username: string }>();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pub_notes WHERE sub = ?').bind(claims.sub),
    env.DB.prepare('DELETE FROM profiles WHERE sub = ?').bind(claims.sub),
    env.DB.prepare('DELETE FROM users WHERE sub = ?').bind(claims.sub),
  ]);
  if (row) await bustProfileCache(new URL(request.url).origin, row.username);
  return json({ ok: true });
}

/* ---------------- caller identity ---------------- */

interface Caller {
  sub: string;
  email?: string;
}

/**
 * Verify the Bearer *access token* the client sent by asking Google's tokeninfo endpoint.
 * Confirms the token was minted for THIS OAuth client (aud) and pulls the stable user id.
 */
async function verifyCaller(request: Request, env: Env): Promise<Caller> {
  if (!env.GOOGLE_CLIENT_ID) throw unauthorized('server missing GOOGLE_CLIENT_ID');
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw unauthorized('missing token');

  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  const info = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw unauthorized('invalid token');
  if (info.aud !== env.GOOGLE_CLIENT_ID && info.azp !== env.GOOGLE_CLIENT_ID) throw unauthorized('token not for this app');
  if (!info.sub) throw unauthorized('no subject');
  return { sub: info.sub, email: info.email };
}

function errResponse(msg: string, status: number): Error {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  }) as unknown as Error;
}
const unauthorized = (msg = 'unauthorized') => errResponse(msg, 401);

/* ---------------- rate limiting (D1) ---------------- */

async function rateLimit(env: Env, key: string, max: number, windowSec: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / windowSec);
  const id = `${key}:${bucket}`;
  const row = await env.DB.prepare('SELECT n FROM rate_limits WHERE id = ?').bind(id).first<{ n: number }>();
  const n = (row?.n ?? 0) + 1;
  await env.DB.prepare(
    'INSERT INTO rate_limits (id, n, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET n = ?2',
  ).bind(id, n, (bucket + 1) * windowSec).run();
  if (n > max) throw errResponse('rate limited, try later', 429);
}

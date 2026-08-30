/**
 * Cloudflare Worker — the ONLY server-side code in this project.
 *
 * The app is hosted as a static site on GitHub Pages; this Worker is deployed separately
 * (e.g. upscnotes-api.<account>.workers.dev) and does only:
 *   1. verify a Google ID token
 *   2. keep the `username -> profile pointer` registry unique (D1), and serve public
 *      username -> profile lookups (`GET /u/<name>`, edge-cached via the Cache API)
 *
 * Notes never pass through here — they live in each student's Google Drive and are read by
 * the browser directly from Google's CDN.
 */

export interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
}

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
      if (request.method === 'GET' && path === '/check') return await check(env, url);
      if (request.method === 'GET' && path.startsWith('/u/')) return await resolveProfile(env, ctx, request, decodeURIComponent(path.slice(3)));
      if (request.method === 'POST' && path === '/claim') return await claim(request, env);
      if (request.method === 'POST' && path === '/profile') return await updateProfile(request, env);
      if (request.method === 'DELETE' && path === '/account') return await deleteAccount(request, env);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      if (e instanceof Response) return e;
      return json({ error: (e as Error).message ?? 'server error' }, 500);
    }
  },
};

/**
 * Public: username -> profile pointer. Edge-cached so repeat profile views cost ~nothing.
 * A cache hit still counts as one Worker request but does zero DB work; a miss does a
 * single indexed D1 read.
 */
async function resolveProfile(env: Env, ctx: ExecutionContext, request: Request, username: string): Promise<Response> {
  const name = username.toLowerCase().replace(/\.json$/, '');
  if (!USERNAME_RE.test(name)) return json({ error: 'invalid username' }, 404);

  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).origin + '/u/' + name, request);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const row = await env.DB.prepare('SELECT profile_url, updated_at FROM profiles WHERE username = ?')
    .bind(name)
    .first<{ profile_url: string; updated_at: number }>();
  if (!row) return json({ error: 'not found' }, 404, { 'cache-control': 'public, max-age=30' });

  const res = json(
    { username: name, profileUrl: row.profile_url, updatedAt: row.updated_at },
    200,
    { 'cache-control': 'public, max-age=300, s-maxage=300' },
  );
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

/* ---------------- handlers ---------------- */

function validateName(name: string): string | null {
  if (!USERNAME_RE.test(name)) return 'invalid username format';
  if (RESERVED.has(name)) return 'reserved username';
  return null;
}

async function check(env: Env, url: URL): Promise<Response> {
  const name = (url.searchParams.get('username') ?? '').toLowerCase();
  const bad = validateName(name);
  if (bad) return json({ available: false, reason: bad });
  const row = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(name).first();
  return json({ available: !row, reason: row ? 'taken' : undefined }, 200, { 'cache-control': 'public, max-age=20' });
}

async function claim(request: Request, env: Env): Promise<Response> {
  const claims = await verifyGoogleToken(request, env.GOOGLE_CLIENT_ID);
  const body = await request.json<{ username?: string; profileUrl?: string; profileFileId?: string }>();
  const name = (body.username ?? '').toLowerCase().trim();
  const bad = validateName(name);
  if (bad) return json({ error: bad }, 400);
  if (!body.profileUrl || !body.profileFileId) return json({ error: 'missing profile pointer' }, 400);

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
      `INSERT INTO profiles (username, sub, profile_url, profile_file_id, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(username) DO UPDATE SET profile_url = ?3, profile_file_id = ?4, updated_at = ?5`,
    ).bind(name, claims.sub, body.profileUrl, body.profileFileId, now),
  ]);

  if (existing && existing.username !== name) {
    await env.DB.prepare('DELETE FROM profiles WHERE username = ?').bind(existing.username).run();
  }

  return json({ ok: true, username: name });
}

async function updateProfile(request: Request, env: Env): Promise<Response> {
  const claims = await verifyGoogleToken(request, env.GOOGLE_CLIENT_ID);
  const body = await request.json<{ profileUrl?: string; profileFileId?: string }>();
  const row = await env.DB.prepare('SELECT username FROM users WHERE sub = ?').bind(claims.sub).first<{ username: string }>();
  if (!row) return json({ error: 'no username claimed' }, 404);
  if (!body.profileUrl || !body.profileFileId) return json({ error: 'missing pointer' }, 400);
  const now = Date.now();
  await env.DB.prepare('UPDATE profiles SET profile_url = ?, profile_file_id = ?, updated_at = ? WHERE username = ?')
    .bind(body.profileUrl, body.profileFileId, now, row.username)
    .run();
  return json({ ok: true });
}

async function deleteAccount(request: Request, env: Env): Promise<Response> {
  const claims = await verifyGoogleToken(request, env.GOOGLE_CLIENT_ID);
  const row = await env.DB.prepare('SELECT username FROM users WHERE sub = ?').bind(claims.sub).first<{ username: string }>();
  if (row) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM profiles WHERE sub = ?').bind(claims.sub),
      env.DB.prepare('DELETE FROM users WHERE sub = ?').bind(claims.sub),
    ]);
    void row;
  }
  return json({ ok: true });
}

/* ---------------- Google ID token verification ---------------- */

interface GoogleClaims {
  sub: string;
  email?: string;
  aud: string;
  iss: string;
  exp: number;
}

let jwksCache: { keys: JsonWebKey[]; fetchedAt: number } | null = null;

async function getJwks(): Promise<any[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < 3_600_000) return jwksCache.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs', { cf: { cacheTtl: 3600, cacheEverything: true } });
  const data = (await res.json()) as { keys: JsonWebKey[] };
  jwksCache = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyGoogleToken(request: Request, clientId: string): Promise<GoogleClaims> {
  if (!clientId) throw unauthorized('server missing GOOGLE_CLIENT_ID');
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw unauthorized('missing token');

  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw unauthorized('malformed token');
  let header: { kid?: string };
  let payload: GoogleClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as GoogleClaims;
  } catch {
    throw unauthorized('malformed token');
  }

  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') throw unauthorized('bad issuer');
  if (payload.aud !== clientId) throw unauthorized('bad audience');
  if (payload.exp * 1000 < Date.now()) throw unauthorized('token expired');

  const jwk = (await getJwks()).find((k) => (k as any).kid === header.kid);
  if (!jwk) throw unauthorized('unknown key');

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw unauthorized('bad signature');
  return payload;
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

/**
 * Cloudflare Pages Function — the ONLY server-side code in this project.
 *
 * It does two things and nothing else:
 *   1. verify a Google ID token
 *   2. keep the `username -> public profile pointer` registry unique (D1) and publish a
 *      static, edge-cacheable pointer object (R2)
 *
 * Notes themselves never pass through here — they live in each student's Google Drive and
 * are read by the browser directly from Google's CDN.
 */

export interface Env {
  DB: D1Database;
  REGISTRY: R2Bucket;
  GOOGLE_CLIENT_ID: string;
}

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;
const RESERVED = new Set([
  'api', 'app', 'about', 'admin', 'assets', 'auth', 'blog', 'docs', 'help', 'login', 'logout',
  'me', 'new', 'note', 'notes', 'privacy', 'profile', 'public', 'registry', 'settings', 'signin',
  'signup', 'static', 'support', 'terms', 'u', 'user', 'users', 'www', 'hashin',
]);

const json = (data: unknown, status = 200, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...extra },
  });

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-max-age': '86400',
    },
  });

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const path = url.pathname.replace(/^\/api/, '');
  try {
    if (ctx.request.method === 'GET' && path === '/check') return check(ctx.env, url);
    if (ctx.request.method === 'POST' && path === '/claim') return claim(ctx);
    if (ctx.request.method === 'POST' && path === '/profile') return updateProfile(ctx);
    if (ctx.request.method === 'DELETE' && path === '/account') return deleteAccount(ctx);
    return json({ error: 'not found' }, 404);
  } catch (e) {
    if (e instanceof Response) return e;
    return json({ error: (e as Error).message ?? 'server error' }, 500);
  }
};

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
  return json(
    { available: !row, reason: row ? 'taken' : undefined },
    200,
    { 'cache-control': 'public, max-age=20' },
  );
}

async function claim(ctx: Parameters<PagesFunction<Env>>[0]): Promise<Response> {
  const { env, request } = ctx;
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

  // Free the old name's pointer object if the user renamed.
  if (existing && existing.username !== name) {
    await env.DB.prepare('DELETE FROM profiles WHERE username = ?').bind(existing.username).run();
    await env.REGISTRY.delete(registryKey(existing.username)).catch(() => {});
  }

  await writePointer(env, name, claims.sub, body.profileUrl, body.profileFileId, now);
  return json({ ok: true, username: name });
}

async function updateProfile(ctx: Parameters<PagesFunction<Env>>[0]): Promise<Response> {
  const { env, request } = ctx;
  const claims = await verifyGoogleToken(request, env.GOOGLE_CLIENT_ID);
  const body = await request.json<{ profileUrl?: string; profileFileId?: string }>();
  const row = await env.DB.prepare('SELECT username FROM users WHERE sub = ?').bind(claims.sub).first<{ username: string }>();
  if (!row) return json({ error: 'no username claimed' }, 404);
  if (!body.profileUrl || !body.profileFileId) return json({ error: 'missing pointer' }, 400);
  const now = Date.now();
  await env.DB.prepare('UPDATE profiles SET profile_url = ?, profile_file_id = ?, updated_at = ? WHERE username = ?')
    .bind(body.profileUrl, body.profileFileId, now, row.username)
    .run();
  await writePointer(env, row.username, claims.sub, body.profileUrl, body.profileFileId, now);
  return json({ ok: true });
}

async function deleteAccount(ctx: Parameters<PagesFunction<Env>>[0]): Promise<Response> {
  const { env, request } = ctx;
  const claims = await verifyGoogleToken(request, env.GOOGLE_CLIENT_ID);
  const row = await env.DB.prepare('SELECT username FROM users WHERE sub = ?').bind(claims.sub).first<{ username: string }>();
  if (row) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM profiles WHERE sub = ?').bind(claims.sub),
      env.DB.prepare('DELETE FROM users WHERE sub = ?').bind(claims.sub),
    ]);
    await env.REGISTRY.delete(registryKey(row.username)).catch(() => {});
  }
  return json({ ok: true });
}

/* ---------------- registry object (R2) ---------------- */

function registryKey(username: string): string {
  const u = username.toLowerCase();
  const prefix = u.slice(0, 2).padEnd(2, '_').replace(/[^a-z0-9]/g, '_');
  return `u/${prefix}/${u}.json`;
}

async function writePointer(env: Env, username: string, sub: string, profileUrl: string, profileFileId: string, updatedAt: number) {
  const payload = JSON.stringify({ username, profileUrl, profileFileId, updatedAt });
  await env.REGISTRY.put(registryKey(username), payload, {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'public, max-age=300, s-maxage=3600',
    },
    customMetadata: { sub },
  });
}

/* ---------------- Google ID token verification ---------------- */

interface GoogleClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  aud: string;
  iss: string;
  exp: number;
}

let jwksCache: { keys: any[]; fetchedAt: number } | null = null;

async function getJwks(): Promise<any[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < 3600_000) return jwksCache.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs', { cf: { cacheTtl: 3600, cacheEverything: true } });
  const data = await res.json<{ keys: any[] }>();
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
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw unauthorized('missing token');

  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw unauthorized();
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as GoogleClaims;

  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') throw unauthorized('bad issuer');
  if (payload.aud !== clientId) throw unauthorized('bad audience');
  if (payload.exp * 1000 < Date.now()) throw unauthorized('token expired');

  const jwk = (await getJwks()).find((k) => k.kid === header.kid);
  if (!jwk) throw unauthorized('unknown key');

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw unauthorized('bad signature');
  return payload;
}

function unauthorized(msg = 'unauthorized'): Error {
  return new Response(JSON.stringify({ error: msg }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  }) as unknown as Error;
}

function rateLimitError(): Error {
  return new Response(JSON.stringify({ error: 'rate limited, try later' }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  }) as unknown as Error;
}

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
  if (n > max) throw rateLimitError();
}

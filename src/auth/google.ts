import { apiUrl, cloudEnabled, config } from '../config';
import { metaGet, metaSet } from '../store/db';
import type { UserProfile } from '../store/models';
import { bus, toast } from '../util/misc';

/**
 * Google auth via the OAuth 2.0 authorization-code flow with a full-page redirect.
 *
 * No popups, no hidden iframes, no FedCM — so it behaves identically in Chrome, Firefox
 * (Total Cookie Protection), Safari, and locked-down browsers. One redirect grants both
 * identity (id_token) and Drive access (drive.file). The Cloudflare Worker holds the client
 * secret and does the code/refresh exchange; the long-lived refresh token is stored in this
 * browser's IndexedDB (same trust boundary as the notes themselves), so sync resumes with
 * no user action on every later visit.
 */

interface TokenState {
  access_token: string;
  expires_at: number;
}

const SCOPE = ['openid', 'email', 'profile', config.DRIVE_SCOPE].join(' ');
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const redirectUri = () => `${location.origin}/oauth2`;

let idToken: string | null = null;
let tokenState: TokenState | null = null;
let currentUser: UserProfile | null = null;
let refreshInFlight: Promise<string> | null = null;

export const getUser = () => currentUser;
export const isSignedIn = () => !!currentUser;
export const getIdToken = () => idToken;
export const isDriveConnected = () => !!tokenState && tokenState.expires_at > Date.now();
export const invalidateDriveToken = () => {
  tokenState = null;
};

function decodeJwt(jwt: string): any {
  const [, payload] = jwt.split('.');
  return JSON.parse(decodeURIComponent(escape(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))));
}

/* ---------- PKCE helpers ---------- */

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomToken(bytes = 48): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url(a);
}
async function s256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return b64url(new Uint8Array(digest));
}

/* ---------- lifecycle ---------- */

/** Restore the cached session at startup. The redirect callback is handled by the router. */
export async function initAuth(): Promise<void> {
  if (!cloudEnabled()) return;
  currentUser = await metaGet<UserProfile | null>('user', null);
  bus.emit('auth', currentUser);
}

/** Start the redirect flow. Navigates away and returns to /oauth2?code=… */
export async function signIn(): Promise<void> {
  if (!cloudEnabled()) {
    toast('Google sign-in is not configured yet.', 'error');
    return;
  }
  const verifier = randomToken(48);
  const state = randomToken(16);
  sessionStorage.setItem('oauth_verifier', verifier);
  sessionStorage.setItem('oauth_state', state);

  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
    code_challenge: await s256(verifier),
    code_challenge_method: 'S256',
  });
  location.assign(`${AUTH_ENDPOINT}?${params}`);
}

/** GIS button is gone; the account modal renders its own button. Kept for call sites. */
export function renderSignInButton(_el: HTMLElement): void {}

/** Called by the router when the browser lands on /oauth2 after the Google redirect. */
export async function handleOAuthCallback(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  const state = q.get('state');
  const error = q.get('error');
  const savedState = sessionStorage.getItem('oauth_state');
  const verifier = sessionStorage.getItem('oauth_verifier');
  sessionStorage.removeItem('oauth_state');
  sessionStorage.removeItem('oauth_verifier');
  history.replaceState(null, '', '/');

  if (error) {
    toast(error === 'access_denied' ? 'Sign-in cancelled.' : `Sign-in failed: ${error}`, 'error');
    return;
  }
  if (!code || !verifier || state !== savedState) {
    toast('Sign-in could not be verified — please try again.', 'error');
    return;
  }

  try {
    const res = await fetch(apiUrl('/oauth/exchange'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: redirectUri(), code_verifier: verifier }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `exchange failed (${res.status})`);
    await applyTokens(data);
    toast(`Signed in as ${currentUser?.name ?? 'you'}`, 'success');
  } catch (e) {
    toast('Could not complete sign-in: ' + (e as Error).message, 'error');
  }
}

async function applyTokens(data: {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string | null;
  id_token?: string | null;
}): Promise<void> {
  if (data.access_token) {
    tokenState = { access_token: data.access_token, expires_at: Date.now() + (Number(data.expires_in ?? 3600) - 120) * 1000 };
  }
  if (data.refresh_token) await metaSet('refreshToken', data.refresh_token);
  if (data.id_token) {
    idToken = data.id_token;
    const c = decodeJwt(data.id_token);
    const existing = await metaGet<UserProfile | null>('user', null);
    const same = !existing || existing.sub === c.sub;
    currentUser = {
      ...(same ? existing ?? {} : {}),
      sub: c.sub,
      email: c.email,
      name: c.name ?? c.email,
      picture: c.picture ?? '',
    };
    await metaSet('user', currentUser);
  }
  await metaSet('driveGranted', true);
  bus.emit('auth', currentUser);
  bus.emit('drive-connected');
}

export async function signOut(): Promise<void> {
  const rt = await metaGet<string>('refreshToken', '');
  if (rt) {
    // Best-effort revoke; ignore CORS / network failures.
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(rt)}`, { method: 'POST', mode: 'no-cors' }).catch(() => {});
  }
  idToken = null;
  tokenState = null;
  currentUser = null;
  refreshInFlight = null;
  await metaSet('user', null);
  await metaSet('refreshToken', '');
  await metaSet('driveGranted', false);
  bus.emit('auth', null);
}

/* ---------- token access ---------- */

/**
 * Resolve a valid Drive access token.
 * @param silent  true = never navigate away; rejects if a fresh sign-in is required.
 */
export async function getDriveToken(silent = false): Promise<string> {
  if (tokenState && tokenState.expires_at > Date.now()) return tokenState.access_token;

  const rt = await metaGet<string>('refreshToken', '');
  if (!rt) {
    if (silent) throw new Error('needs-consent');
    await signIn(); // navigates away
    return new Promise<string>(() => {});
  }

  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const res = await fetch(apiUrl('/oauth/refresh'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.reauth) {
        await metaSet('refreshToken', '');
        bus.emit('drive-needs-reconnect');
        if (!silent) {
          await signIn();
          return new Promise<string>(() => {});
        }
      }
      throw new Error(data.error ?? `refresh failed (${res.status})`);
    }
    tokenState = { access_token: data.access_token, expires_at: Date.now() + (Number(data.expires_in ?? 3600) - 120) * 1000 };
    if (data.id_token) idToken = data.id_token;
    bus.emit('drive-connected');
    return data.access_token as string;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** Startup: silently mint an access token from the stored refresh token, if any. */
export async function restoreDriveSession(): Promise<void> {
  if (!cloudEnabled() || !currentUser) return;
  try {
    await getDriveToken(true);
  } catch {
    if (await metaGet('driveGranted', false)) bus.emit('drive-needs-reconnect');
  }
}

export async function updateStoredUser(patch: Partial<UserProfile>): Promise<void> {
  if (!currentUser) return;
  currentUser = { ...currentUser, ...patch };
  await metaSet('user', currentUser);
  bus.emit('auth', currentUser);
}

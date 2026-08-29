import { config, cloudEnabled } from '../config';
import { metaGet, metaSet } from '../store/db';
import type { UserProfile } from '../store/models';
import { bus, toast } from '../util/misc';

/* Minimal typings for the Google Identity Services global. */
declare global {
  interface Window {
    google?: any;
    __gisReady?: boolean;
  }
}

interface TokenState {
  access_token: string;
  expires_at: number;
}

let idToken: string | null = null;
let tokenState: TokenState | null = null;
let tokenClient: any = null;
let currentUser: UserProfile | null = null;

export const getUser = () => currentUser;
export const isSignedIn = () => !!currentUser;
export const getIdToken = () => idToken;

function decodeJwt(jwt: string): any {
  const [, payload] = jwt.split('.');
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
}

async function waitForGis(timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!window.google?.accounts?.id) {
    if (Date.now() - start > timeoutMs) throw new Error('Google sign-in failed to load (offline?)');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Called once at startup. Restores a cached session and wires the ID callback. */
export async function initAuth(): Promise<void> {
  if (!cloudEnabled()) return;
  currentUser = await metaGet<UserProfile | null>('user', null);
  bus.emit('auth', currentUser);
  try {
    await waitForGis();
  } catch {
    return; // offline — keep cached user, cloud actions will retry
  }
  window.google.accounts.id.initialize({
    client_id: config.GOOGLE_CLIENT_ID,
    callback: onCredential,
    auto_select: true,
    use_fedcm_for_prompt: true,
  });
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: config.GOOGLE_CLIENT_ID,
    scope: config.DRIVE_SCOPE,
    callback: (resp: any) => {
      if (resp.error) {
        bus.emit('drive-token-error', resp);
        return;
      }
      tokenState = { access_token: resp.access_token, expires_at: Date.now() + (resp.expires_in - 60) * 1000 };
      bus.emit('drive-connected');
    },
  });
}

async function onCredential(resp: { credential: string }) {
  idToken = resp.credential;
  const claims = decodeJwt(resp.credential);
  const existing = await metaGet<UserProfile | null>('user', null);
  currentUser = {
    ...(existing ?? {}),
    sub: claims.sub,
    email: claims.email,
    name: claims.name ?? claims.email,
    picture: claims.picture ?? '',
  };
  await metaSet('user', currentUser);
  bus.emit('auth', currentUser);
  toast(`Signed in as ${currentUser.name}`, 'success');
}

/** Trigger the Google sign-in prompt (One Tap, falling back to a popup button flow). */
export async function signIn(): Promise<void> {
  if (!cloudEnabled()) {
    toast('Google sign-in is not configured yet. See docs/SETUP.md', 'error');
    return;
  }
  await waitForGis();
  window.google.accounts.id.prompt();
}

export function renderSignInButton(el: HTMLElement): void {
  if (!cloudEnabled() || !window.google?.accounts?.id) return;
  window.google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill' });
}

export async function signOut(): Promise<void> {
  if (currentUser && window.google?.accounts?.id) window.google.accounts.id.disableAutoSelect();
  idToken = null;
  tokenState = null;
  currentUser = null;
  await metaSet('user', null);
  bus.emit('auth', null);
}

/** Get a valid Drive access token, prompting for consent the first time. */
export function getDriveToken(interactive = true): Promise<string> {
  return new Promise((resolve, reject) => {
    if (tokenState && tokenState.expires_at > Date.now()) return resolve(tokenState.access_token);
    if (!tokenClient) return reject(new Error('Auth not initialised'));
    const off = bus.on('drive-connected', () => {
      off();
      offErr();
      resolve(tokenState!.access_token);
    });
    const offErr = bus.on('drive-token-error', (e: any) => {
      off();
      offErr();
      reject(new Error(e.error ?? 'Drive authorization failed'));
    });
    tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
  });
}

export const isDriveConnected = () => !!tokenState && tokenState.expires_at > Date.now();

export async function updateStoredUser(patch: Partial<UserProfile>): Promise<void> {
  if (!currentUser) return;
  currentUser = { ...currentUser, ...patch };
  await metaSet('user', currentUser);
  bus.emit('auth', currentUser);
}

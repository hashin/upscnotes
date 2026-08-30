import { config, cloudEnabled } from '../config';
import { metaGet, metaSet } from '../store/db';
import type { UserProfile } from '../store/models';
import { bus, toast } from '../util/misc';

/* Minimal typings for the Google Identity Services global. */
declare global {
  interface Window {
    google?: any;
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

// One in-flight token request at a time; concurrent callers share it.
let pending: { promise: Promise<string>; resolve: (t: string) => void; reject: (e: Error) => void } | null = null;

export const getUser = () => currentUser;
export const isSignedIn = () => !!currentUser;
export const getIdToken = () => idToken;
export const isDriveConnected = () => !!tokenState && tokenState.expires_at > Date.now();
/** Drop the cached access token so the next getDriveToken() fetches a fresh one. */
export const invalidateDriveToken = () => {
  tokenState = null;
};

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

/** Called once at startup. Restores the cached session and silently re-links Drive. */
export async function initAuth(): Promise<void> {
  if (!cloudEnabled()) return;
  currentUser = await metaGet<UserProfile | null>('user', null);
  bus.emit('auth', currentUser);
  try {
    await waitForGis();
  } catch {
    return; // offline — keep cached user, cloud actions retry later
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
    prompt: '',
    callback: (resp: any) => {
      if (resp.error) {
        const err = new Error(resp.error === 'interaction_required' ? 'needs-consent' : resp.error);
        bus.emit('drive-token-error', resp);
        pending?.reject(err);
        pending = null;
        return;
      }
      tokenState = {
        access_token: resp.access_token,
        expires_at: Date.now() + (Number(resp.expires_in ?? 3600) - 120) * 1000,
      };
      metaSet('driveGranted', true);
      bus.emit('drive-connected');
      pending?.resolve(resp.access_token);
      pending = null;
    },
  });

}

/**
 * Called by the sync layer after startup. Tries to get a Drive token with no UI — the
 * `drive.file` grant is per Google-account + client, so this succeeds on a new browser too
 * as long as the user authorized Drive once anywhere. Falls back to "Connect Drive".
 */
export async function restoreDriveSession(): Promise<void> {
  if (!cloudEnabled() || !currentUser || !tokenClient) return;
  try {
    await getDriveToken(true);
  } catch {
    if (await metaGet('driveGranted', false)) bus.emit('drive-needs-reconnect');
  }
}

async function onCredential(resp: { credential: string }) {
  idToken = resp.credential;
  const claims = decodeJwt(resp.credential);
  const existing = await metaGet<UserProfile | null>('user', null);
  const sameUser = !existing || existing.sub === claims.sub;
  currentUser = {
    ...(sameUser ? existing ?? {} : {}),
    sub: claims.sub,
    email: claims.email,
    name: claims.name ?? claims.email,
    picture: claims.picture ?? '',
  };
  await metaSet('user', currentUser);
  bus.emit('auth', currentUser);
  toast(`Signed in as ${currentUser.name}`, 'success');
  // Chain straight into a silent Drive token so backup starts without another click.
  getDriveToken(true).catch(() => {/* user can hit "Connect Drive" */});
}

export async function signIn(): Promise<void> {
  if (!cloudEnabled()) {
    toast('Google sign-in is not configured yet.', 'error');
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
  if (window.google?.accounts?.id) window.google.accounts.id.disableAutoSelect();
  if (tokenState && window.google?.accounts?.oauth2) {
    try {
      window.google.accounts.oauth2.revoke(tokenState.access_token, () => {});
    } catch { /* ignore */ }
  }
  idToken = null;
  tokenState = null;
  currentUser = null;
  pending = null;
  await metaSet('user', null);
  await metaSet('driveGranted', false);
  bus.emit('auth', null);
}

/**
 * Resolve a valid Drive access token.
 * @param silent  true = never show UI (throws if consent is required)
 */
export function getDriveToken(silent = false): Promise<string> {
  if (tokenState && tokenState.expires_at > Date.now()) return Promise.resolve(tokenState.access_token);
  if (!tokenClient) return Promise.reject(new Error('Auth not initialised'));
  if (pending) return pending.promise;

  let resolve!: (t: string) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  pending = { promise, resolve, reject };
  try {
    tokenClient.requestAccessToken({ prompt: silent ? 'none' : '' });
  } catch (e) {
    pending = null;
    return Promise.reject(e as Error);
  }
  return promise;
}

export async function updateStoredUser(patch: Partial<UserProfile>): Promise<void> {
  if (!currentUser) return;
  currentUser = { ...currentUser, ...patch };
  await metaSet('user', currentUser);
  bus.emit('auth', currentUser);
}

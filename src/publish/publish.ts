import { apiUrl, config } from '../config';
import { getDriveToken, getUser, updateStoredUser } from '../auth/google';
import { getNote } from '../store/db';
import type { Note } from '../store/models';
import { ensureSlug, saveNote } from '../store/workspace';
import { bus, countWords, debounce, toast } from '../util/misc';
import { makePrivate, makePublic } from '../sync/drive';
import { syncNow } from '../sync/sync';

export interface PublicProfile {
  v: number;
  username: string;
  displayName: string;
  bio: string;
  avatar: string;
  updatedAt: number;
  notes: {
    slug: string;
    title: string;
    tags: string[];
    syllabus: string[];
    updatedAt: number;
    url: string;
    words: number;
  }[];
}

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;
const RESERVED = new Set([
  'api', 'app', 'about', 'admin', 'assets', 'auth', 'blog', 'docs', 'help', 'login', 'logout',
  'me', 'new', 'note', 'notes', 'privacy', 'profile', 'public', 'registry', 'settings', 'signin',
  'signup', 'static', 'support', 'terms', 'u', 'user', 'users', 'www',
]);

export function validateUsername(name: string): string | null {
  if (!USERNAME_RE.test(name)) return '3–30 chars, lowercase letters, digits and hyphens; must start with a letter or digit.';
  if (RESERVED.has(name)) return 'That name is reserved.';
  return null;
}

async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getDriveToken(true).catch(() => getDriveToken(false));
  return fetch(apiUrl(path), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

export async function checkUsername(name: string): Promise<{ available: boolean; reason?: string }> {
  const err = validateUsername(name);
  if (err) return { available: false, reason: err };
  const res = await fetch(apiUrl(`/check?username=${encodeURIComponent(name)}`));
  if (!res.ok) return { available: false, reason: 'Could not reach the name server.' };
  return res.json();
}

export async function claimUsername(name: string): Promise<void> {
  const err = validateUsername(name);
  if (err) throw new Error(err);
  const user = getUser();
  const res = await authFetch('/claim', {
    method: 'POST',
    body: JSON.stringify({ username: name, displayName: user?.name ?? '', avatar: user?.picture ?? '' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Claim failed (${res.status})`);
  await updateStoredUser({ username: name });
  toast(`Username @${name} is yours. Your page: ${config.SITE_URL}/${name}`, 'success');
  // Re-publish anything already marked public locally.
  for (const n of await pendingPublishNotes()) await pushPublish(n).catch(() => {});
}

async function pendingPublishNotes(): Promise<Note[]> {
  const { allNotes } = await import('../store/db');
  return (await allNotes()).filter((n) => n.published && n.slug);
}

/* ---------------- per-note publish state (authoritative in D1) ---------------- */

async function pushPublish(note: Note): Promise<void> {
  if (!note.driveFileId || !note.slug) return;
  const res = await authFetch('/publish', {
    method: 'POST',
    body: JSON.stringify({
      noteId: note.id,
      slug: note.slug,
      title: note.title,
      tags: note.tags,
      syllabus: note.syllabus,
      driveFileId: note.driveFileId,
      words: countWords(note.markdown),
      updatedAt: note.updatedAt,
    }),
  });
  if (res.status === 409) {
    const d = await res.json().catch(() => ({}));
    if (d.error === 'slug-taken') {
      // pick a fresh slug and retry once
      const fresh = await ensureSlug({ ...note, slug: undefined });
      await saveNote(note.id, { slug: fresh });
      return pushPublish({ ...note, slug: fresh });
    }
    throw new Error(d.error ?? 'conflict');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `publish failed (${res.status})`);
}

export async function setPublished(noteId: string, published: boolean): Promise<void> {
  const note = await getNote(noteId);
  if (!note) return;
  if (published && !getUser()?.username) throw new Error('Pick a username first.');

  await getDriveToken(true).catch(() => getDriveToken(false));

  const slug = published ? await ensureSlug(note) : note.slug;
  await saveNote(noteId, { published, slug });

  // Make sure the note file exists on Drive and is / isn't link-shared.
  if (!note.driveFileId) await syncNow('publish');
  const fresh = await getNote(noteId);
  if (published && !fresh?.driveFileId) throw new Error('Could not back this note up to Drive — check your connection and retry.');

  if (published) {
    await makePublic(fresh!.driveFileId!);
    await pushPublish(fresh!);
    toast(`Published → ${config.SITE_URL}/${getUser()!.username}/${fresh!.slug}`, 'success');
  } else {
    await authFetch(`/publish?noteId=${encodeURIComponent(noteId)}`, { method: 'DELETE' }).catch(() => {});
    if (fresh?.driveFileId) await makePrivate(fresh.driveFileId).catch(() => {});
    toast('Unpublished.', 'success');
  }
}

export async function updateProfileMeta(patch: { displayName?: string; bio?: string }): Promise<void> {
  await updateStoredUser(patch);
  const user = getUser();
  const res = await authFetch('/profile', {
    method: 'POST',
    body: JSON.stringify({
      displayName: patch.displayName ?? user?.displayName ?? user?.name ?? '',
      bio: patch.bio ?? user?.bio ?? '',
      avatar: user?.picture ?? '',
    }),
  });
  if (!res.ok) toast('Could not save profile: ' + ((await res.json().catch(() => ({}))).error ?? res.status), 'error');
}

/* ---------------- keep D1 metadata fresh as published notes are edited ---------------- */

const refreshSoon = debounce(async (noteId: string) => {
  const n = await getNote(noteId);
  if (n?.published && n.slug && n.driveFileId && getUser()?.username) await pushPublish(n).catch(() => {});
}, 12_000);

/** Reconcile local published flags with the server's authoritative list on sign-in. */
export async function reconcilePublished(): Promise<void> {
  if (!getUser()?.username) return;
  try {
    const res = await authFetch('/me');
    if (!res.ok) return;
    const data = (await res.json()) as { published?: { noteId: string; slug: string }[] };
    const serverIds = new Set((data.published ?? []).map((p) => p.noteId));
    const { allNotes } = await import('../store/db');
    for (const n of await allNotes()) {
      if (serverIds.has(n.id) && !n.published) await saveNote(n.id, { published: true });
      else if (!serverIds.has(n.id) && n.published) await saveNote(n.id, { published: false });
      // Locally-published notes the server doesn't know yet -> push them up.
      if (n.published && !serverIds.has(n.id) && n.slug && n.driveFileId) await pushPublish(n).catch(() => {});
    }
  } catch {
    /* offline — retry next connect */
  }
}

export function watchPublishing(): void {
  bus.on('note-saved', (n: Note) => {
    if (n.published) refreshSoon(n.id);
  });
  bus.on('drive-connected', () => {
    void pullIdentity();
  });
}

/* ---------------- recover username on a new browser ---------------- */

let lastPull = 0;
export async function pullIdentity(force = false): Promise<void> {
  const user = getUser();
  if (!user) return;
  if (!force && Date.now() - lastPull < 30_000) return;
  lastPull = Date.now();
  try {
    const res = await authFetch('/me');
    if (!res.ok) return;
    const data = (await res.json()) as { username?: string | null; displayName?: string | null; bio?: string | null };
    if (!data.username) return;
    const patch: Record<string, string> = {};
    if (data.username !== user.username) patch.username = data.username;
    if (data.displayName && data.displayName !== user.displayName) patch.displayName = data.displayName;
    if (data.bio != null && data.bio !== user.bio) patch.bio = data.bio;
    if (Object.keys(patch).length) await updateStoredUser(patch);
    await reconcilePublished();
  } catch {
    /* offline */
  }
}

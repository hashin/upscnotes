import { apiUrl, config } from '../config';
import { getDriveToken, getIdToken, getUser, updateStoredUser } from '../auth/google';
import { allNotes, getNote, metaGet, metaSet } from '../store/db';
import type { Note } from '../store/models';
import { ensureSlug, saveNote } from '../store/workspace';
import { bus, toast } from '../util/misc';
import {
  createFile,
  ensureRootFolder,
  makePrivate,
  makePublic,
  publicContentUrl,
  updateFile,
} from '../sync/drive';
import { syncNow } from '../sync/sync';

export interface PublicProfile {
  v: 1;
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
    url: string; // public content URL of the .md
    words: number;
  }[];
}

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;
const RESERVED = new Set([
  'api', 'app', 'about', 'admin', 'assets', 'auth', 'blog', 'docs', 'help', 'login', 'logout',
  'me', 'new', 'note', 'notes', 'privacy', 'profile', 'public', 'registry', 'settings', 'signin',
  'signup', 'static', 'support', 'terms', 'u', 'user', 'users', 'www', 'hashin',
]);

export function validateUsername(name: string): string | null {
  if (!USERNAME_RE.test(name)) return '3–30 chars, lowercase letters, digits and hyphens; must start with a letter or digit.';
  if (RESERVED.has(name)) return 'That name is reserved.';
  return null;
}

export async function checkUsername(name: string): Promise<{ available: boolean; reason?: string }> {
  const err = validateUsername(name);
  if (err) return { available: false, reason: err };
  const res = await fetch(apiUrl(`/api/check?username=${encodeURIComponent(name)}`));
  if (!res.ok) return { available: false, reason: 'Could not reach the name server.' };
  return res.json();
}

export async function claimUsername(name: string): Promise<void> {
  const idToken = getIdToken();
  if (!idToken) throw new Error('Sign in first.');
  const err = validateUsername(name);
  if (err) throw new Error(err);

  // Make sure the Drive profile file exists and is public before we register the pointer.
  const profileFileId = await ensureProfileFile();
  const profileUrl = publicContentUrl(profileFileId);

  const res = await fetch(apiUrl('/api/claim'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ username: name, profileFileId, profileUrl }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Claim failed (${res.status})`);

  await updateStoredUser({ username: name, profileFileId, profileFileUrl: profileUrl });
  await metaSet('profileFileId', profileFileId);
  toast(`Username @${name} is yours. Your page: ${config.SITE_URL}/${name}`, 'success');
  await rebuildAndUploadProfile();
}

async function driveRoot(): Promise<string> {
  let id = await metaGet<string>('driveRootId', '');
  if (!id) {
    id = await ensureRootFolder();
    await metaSet('driveRootId', id);
  }
  return id;
}

async function ensureProfileFile(): Promise<string> {
  const existing = await metaGet<string>('profileFileId', getUser()?.profileFileId ?? '');
  if (existing) return existing;
  await getDriveToken();
  const root = await driveRoot();
  const file = await createFile(root, 'profile.json', JSON.stringify(emptyProfile(), null, 2), {
    'upscnotes-profile': '1',
  });
  const url = await makePublic(file.id);
  await metaSet('profileFileId', file.id);
  await updateStoredUser({ profileFileId: file.id, profileFileUrl: url });
  return file.id;
}

function emptyProfile(): PublicProfile {
  const u = getUser();
  return {
    v: 1,
    username: u?.username ?? '',
    displayName: u?.displayName ?? u?.name ?? '',
    bio: u?.bio ?? '',
    avatar: u?.picture ?? '',
    updatedAt: Date.now(),
    notes: [],
  };
}

function words(md: string): number {
  const m = md.replace(/[#>*_`~\-|[\]()!]/g, ' ').match(/\S+/g);
  return m ? m.length : 0;
}

export async function buildProfile(): Promise<PublicProfile> {
  const notes = (await allNotes()).filter((n) => n.published && n.slug && n.driveFileId);
  const p = emptyProfile();
  p.notes = notes
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((n) => ({
      slug: n.slug!,
      title: n.title,
      tags: n.tags,
      syllabus: n.syllabus,
      updatedAt: n.updatedAt,
      url: publicContentUrl(n.driveFileId!),
      words: words(n.markdown),
    }));
  return p;
}

let uploadT: ReturnType<typeof setTimeout> | null = null;
export function rebuildAndUploadProfileSoon() {
  if (uploadT) clearTimeout(uploadT);
  uploadT = setTimeout(() => void rebuildAndUploadProfile(), 3000);
}

export async function rebuildAndUploadProfile(): Promise<void> {
  const user = getUser();
  if (!user?.username) return;
  try {
    const fileId = await ensureProfileFile();
    const profile = await buildProfile();
    await updateFile(fileId, JSON.stringify(profile, null, 2));
    await metaSet('profilePublishedAt', Date.now());
    bus.emit('profile-updated', profile);
  } catch (e) {
    console.error('[profile]', e);
    toast('Could not update your public page: ' + (e as Error).message, 'error');
  }
}

export async function setPublished(noteId: string, published: boolean): Promise<void> {
  const note = await getNote(noteId);
  if (!note) return;
  if (published && !getUser()?.username) throw new Error('Pick a username first.');

  await getDriveToken();
  // Ensure it is synced so it has a Drive file id.
  if (!note.driveFileId) {
    await syncNow('pre-publish');
  }
  const fresh = await getNote(noteId);
  if (!fresh?.driveFileId) throw new Error('Sync the note to Drive first.');

  const slug = published ? await ensureSlug(fresh) : fresh.slug;
  await saveNote(noteId, { published, slug });

  if (published) await makePublic(fresh.driveFileId);
  else await makePrivate(fresh.driveFileId).catch(() => {});

  await rebuildAndUploadProfile();
  toast(published ? `Published → ${config.SITE_URL}/${getUser()!.username}/${slug}` : 'Unpublished.', 'success');
}

export async function updateProfileMeta(patch: { displayName?: string; bio?: string }): Promise<void> {
  await updateStoredUser(patch);
  await rebuildAndUploadProfile();
}

/** Wire background profile refresh when published notes change. */
export function watchPublishing(): void {
  bus.on('note-saved', (n: Note) => {
    if (n.published) rebuildAndUploadProfileSoon();
  });
}

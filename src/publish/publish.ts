import { apiUrl, config } from '../config';
import { getDriveToken, getUser, updateStoredUser } from '../auth/google';
import { getNote, metaGet, metaSet } from '../store/db';
import type { Note } from '../store/models';
import { ensureSlug, saveNote } from '../store/workspace';
import { bus, toast } from '../util/misc';
import {
  createFile,
  downloadFile,
  ensureRootFolder,
  findAppFile,
  listFiles,
  makePrivate,
  makePublic,
  publicContentUrl,
  updateFile,
} from '../sync/drive';
import { parseMarkdownFile } from '../sync/frontmatter';
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
  'signup', 'static', 'support', 'terms', 'u', 'user', 'users', 'www',
]);

export function validateUsername(name: string): string | null {
  if (!USERNAME_RE.test(name)) return '3–30 chars, lowercase letters, digits and hyphens; must start with a letter or digit.';
  if (RESERVED.has(name)) return 'That name is reserved.';
  return null;
}

export async function checkUsername(name: string): Promise<{ available: boolean; reason?: string }> {
  const err = validateUsername(name);
  if (err) return { available: false, reason: err };
  const res = await fetch(apiUrl(`/check?username=${encodeURIComponent(name)}`));
  if (!res.ok) return { available: false, reason: 'Could not reach the name server.' };
  return res.json();
}

export async function claimUsername(name: string): Promise<void> {
  if (!getUser()) throw new Error('Sign in first.');
  const err = validateUsername(name);
  if (err) throw new Error(err);

  const accessToken = await getDriveToken(false);

  // Make sure the Drive profile file exists and is public before we register the pointer.
  const profileFileId = await ensureProfileFile();
  const profileUrl = publicContentUrl(profileFileId);

  const res = await fetch(apiUrl('/claim'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
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
  const known = await metaGet<string>('profileFileId', getUser()?.profileFileId ?? '');
  if (known) return known;
  await getDriveToken();

  // A profile.json created on another device is visible here (drive.file is per app+user),
  // so adopt it rather than making a duplicate.
  const found = await findAppFile('upscnotes-profile', '1');
  if (found) {
    const url = await makePublic(found);
    await metaSet('profileFileId', found);
    await updateStoredUser({ profileFileId: found, profileFileUrl: url });
    return found;
  }

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
    updatedAt: 0, // set to max(note.updatedAt) in buildProfile so identical sets hash equal
    notes: [],
  };
}

function words(md: string): number {
  const m = md.replace(/[#>*_`~\-|[\]()!]/g, ' ').match(/\S+/g);
  return m ? m.length : 0;
}

/**
 * Build the public index from **Drive**, not this browser's IndexedDB — so it always
 * reflects every device's published notes. Two browsers publishing independently no longer
 * overwrite each other's entries.
 */
export async function buildProfile(): Promise<PublicProfile> {
  const p = emptyProfile();
  await getDriveToken(true);
  const rootId = await driveRoot();
  const files = await listFiles(rootId);
  const published = files.filter((f) => f.appProperties?.published === 'true' && f.appProperties?.slug);

  for (const f of published) {
    let meta: Record<string, any> = {};
    let body = '';
    try {
      ({ meta, body } = parseMarkdownFile(await downloadFile(f.id)));
    } catch {
      /* skip unreadable file */
      continue;
    }
    // Make sure the note file itself is link-shareable for the public page.
    await makePublic(f.id).catch(() => {});
    p.notes.push({
      slug: f.appProperties!.slug,
      title: meta.title || f.name.replace(/\.md$/, ''),
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      syllabus: Array.isArray(meta.syllabus) ? meta.syllabus : [],
      updatedAt: meta.updated ? Date.parse(meta.updated) : Date.parse(f.modifiedTime),
      url: publicContentUrl(f.id),
      words: words(body),
    });
  }
  p.notes.sort((a, b) => b.updatedAt - a.updatedAt);
  p.updatedAt = p.notes.reduce((m, n) => Math.max(m, n.updatedAt), 0);
  return p;
}

let uploadT: ReturnType<typeof setTimeout> | null = null;
export function rebuildAndUploadProfileSoon() {
  if (uploadT) clearTimeout(uploadT);
  uploadT = setTimeout(() => void rebuildAndUploadProfile(), 15_000);
}

let rebuilding: Promise<void> | null = null;
export function rebuildAndUploadProfile(): Promise<void> {
  if (rebuilding) return rebuilding;
  rebuilding = doRebuild().finally(() => {
    rebuilding = null;
  });
  return rebuilding;
}

async function doRebuild(): Promise<void> {
  const user = getUser();
  if (!user?.username) return;
  try {
    const fileId = await ensureProfileFile();
    const profile = await buildProfile();
    const json = JSON.stringify(profile, null, 2);
    if (json === (await metaGet<string>('lastProfileJson', ''))) return; // nothing changed
    await updateFile(fileId, json);
    await metaSet('lastProfileJson', json);
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

  await getDriveToken(true).catch(() => getDriveToken(false));

  const slug = published ? await ensureSlug(note) : note.slug;
  await saveNote(noteId, { published, slug });

  // Sync so this note — and anything published from other devices — is on Drive before
  // we regenerate the public index.
  await syncNow('publish');

  const fresh = await getNote(noteId);
  if (!fresh?.driveFileId) throw new Error('Could not back this note up to Drive — check your connection and retry.');

  if (published) await makePublic(fresh.driveFileId);
  else await makePrivate(fresh.driveFileId).catch(() => {});

  await rebuildAndUploadProfile();
  toast(published ? `Published → ${config.SITE_URL}/${getUser()!.username}/${slug}` : 'Unpublished.', 'success');
}

export async function updateProfileMeta(patch: { displayName?: string; bio?: string }): Promise<void> {
  await updateStoredUser(patch);
  await rebuildAndUploadProfile();
}

/**
 * Ask the Worker what username this Google account already owns and adopt it locally.
 * This is what makes a second browser / device point at the same public page: the
 * username registry lives in D1 keyed by the Google account, not in this browser.
 */
let lastIdentityPull = 0;
export async function pullIdentity(force = false): Promise<void> {
  const user = getUser();
  if (!user) return;
  if (!force && Date.now() - lastIdentityPull < 30_000) return;
  lastIdentityPull = Date.now();
  try {
    const token = await getDriveToken(true);
    const res = await fetch(apiUrl('/me'), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const data = (await res.json()) as { username?: string | null; profileFileId?: string | null; profileUrl?: string | null };
    if (!data.username) return;

    const patch: Record<string, string> = {};
    if (data.username !== user.username) patch.username = data.username;
    if (data.profileFileId && data.profileFileId !== user.profileFileId) patch.profileFileId = data.profileFileId;
    if (data.profileUrl && data.profileUrl !== user.profileFileUrl) patch.profileFileUrl = data.profileUrl;

    if (Object.keys(patch).length) {
      await updateStoredUser(patch);
      if (patch.profileFileId) await metaSet('profileFileId', patch.profileFileId);
      // A new browser just learned it owns a page — publish its current published set.
      if (patch.username) rebuildAndUploadProfileSoon();
    }
  } catch {
    /* offline / not connected — try again next time */
  }
}

/** Wire background profile refresh + identity recovery. */
export function watchPublishing(): void {
  bus.on('note-saved', (n: Note) => {
    if (n.published) rebuildAndUploadProfileSoon();
  });
  bus.on('drive-connected', () => void pullIdentity());
}

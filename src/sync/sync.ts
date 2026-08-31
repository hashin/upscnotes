import { isDriveConnected, isSignedIn, restoreDriveSession } from '../auth/google';
import {
  allFolders,
  allNotesIncludingTrash,
  deleteNoteHard,
  getNote,
  metaGet,
  metaSet,
  putFolder,
  putNote,
} from '../store/db';
import { ROOT, uid, type Folder, type Note } from '../store/models';
import { rebuildSearch } from '../store/workspace';
import { bus, sha256, toast } from '../util/misc';
import { createFile, downloadFile, ensureRootFolder, listFiles, trashFile, updateFile, type DriveFile } from './drive';
import { parseMarkdownFile, toMarkdownFile } from './frontmatter';

let syncing = false;
let queued = false;
let timer: ReturnType<typeof setInterval> | null = null;

export function startAutoSync(): void {
  bus.on('sync-request', () => scheduleSync());
  bus.on('drive-connected', () => syncNow('drive-connected'));
  bus.on('drive-needs-reconnect', () =>
    bus.emit('sync-state', { state: 'error', message: 'Reconnect Google Drive to resume backup' }),
  );
  window.addEventListener('online', () => syncNow('online'));

  document.addEventListener('visibilitychange', () => {
    syncNow(document.visibilityState === 'visible' ? 'focus' : 'hide');
  });
  window.addEventListener('focus', () => scheduleSync());

  if (timer) clearInterval(timer);
  timer = setInterval(() => syncNow('interval'), 20_000);

  void restoreDriveSession().then(() => {
    if (canSync()) syncNow('startup');
  });
}

let scheduleT: ReturnType<typeof setTimeout> | null = null;
function scheduleSync() {
  if (!canSync()) return;
  if (scheduleT) clearTimeout(scheduleT);
  scheduleT = setTimeout(() => syncNow('auto'), 2000);
}

function canSync(): boolean {
  return isSignedIn() && isDriveConnected() && navigator.onLine;
}

export async function syncNow(reason: string): Promise<void> {
  if (!canSync()) return;
  if (syncing) {
    queued = true;
    return;
  }
  syncing = true;
  bus.emit('sync-state', { state: 'syncing' });
  try {
    const rootId = await getRootFolder();
    const remote = await listFiles(rootId);
    const remoteById = new Map<string, DriveFile>();
    for (const f of remote) {
      const nid = f.appProperties?.noteId;
      if (nid) remoteById.set(nid, f);
    }

    await pull(remoteById);
    await applyRemoteDeletions(remoteById);
    await push(rootId, remoteById);

    await metaSet('lastSync', Date.now());
    bus.emit('sync-state', { state: 'idle', at: Date.now() });
    await rebuildSearch();
    bus.emit('tree-changed');
    bus.emit('sync-done');
  } catch (e) {
    console.error('[sync]', reason, e);
    bus.emit('sync-state', { state: 'error', message: (e as Error).message });
    if (String(e).includes('unauthorized')) toast('Drive session expired — reconnect from Account.', 'error');
  } finally {
    syncing = false;
    if (queued) {
      queued = false;
      setTimeout(() => syncNow('queued'), 500);
    }
  }
}

async function getRootFolder(): Promise<string> {
  let id = await metaGet<string>('driveRootId', '');
  if (!id) {
    id = await ensureRootFolder();
    await metaSet('driveRootId', id);
  }
  return id;
}

async function folderByName(name: string): Promise<Folder> {
  const folders = await allFolders();
  const found = folders.find((f) => f.name.toLowerCase() === (name || 'notes').toLowerCase());
  if (found) return found;
  const f: Folder = { id: uid(), parentId: ROOT, name: name || 'Notes', createdAt: Date.now(), order: folders.length };
  await putFolder(f);
  return f;
}

/** The exact bytes we would write to Drive for this note — the unit of change detection. */
async function fileHash(note: Note, folderName: string): Promise<string> {
  return sha256(toMarkdownFile(note, folderName));
}

function noteFromMeta(nid: string, meta: Record<string, any>, body: string, file: DriveFile, folderId: string): Note {
  return {
    id: nid,
    folderId,
    title: meta.title || file.name.replace(/\.md$/, ''),
    markdown: body,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    syllabus: Array.isArray(meta.syllabus) ? meta.syllabus : [],
    createdAt: meta.created ? Date.parse(meta.created) : Date.now(),
    updatedAt: meta.updated ? Date.parse(meta.updated) : Date.now(),
    published: !!meta.published,
    slug: meta.slug || undefined,
    driveFileId: file.id,
    driveModified: file.modifiedTime,
    order: 999,
  } as Note;
}

async function pull(remoteById: Map<string, DriveFile>): Promise<void> {
  const folders = await allFolders();
  const folderName = (id: string) => folders.find((f) => f.id === id)?.name ?? 'Notes';

  for (const [nid, file] of remoteById) {
    const local = await getNote(nid);
    if (local && local.driveModified === file.modifiedTime) continue; // remote unchanged since we last saw it

    const text = await downloadFile(file.id);
    const { meta, body } = parseMarkdownFile(text);
    const remoteFileHash = await sha256(text);

    if (!local) {
      const folder = await folderByName(meta.folder || 'Imported');
      const note = noteFromMeta(nid, meta, body, file, folder.id);
      note.syncedHash = remoteFileHash;
      await putNote(note);
      continue;
    }

    const localDirty = local.syncedHash !== (await fileHash(local, folderName(local.folderId)));

    if (!localDirty) {
      const folder = await folderByName(meta.folder || folderName(local.folderId));
      await putNote({
        ...local,
        folderId: folder.id,
        title: meta.title || local.title,
        markdown: body,
        tags: Array.isArray(meta.tags) ? meta.tags : local.tags,
        syllabus: Array.isArray(meta.syllabus) ? meta.syllabus : local.syllabus,
        published: !!meta.published,
        slug: meta.slug || local.slug,
        driveModified: file.modifiedTime,
        syncedHash: remoteFileHash,
        updatedAt: meta.updated ? Date.parse(meta.updated) : Date.now(),
      });
      bus.emit('note-external-update', nid);
      continue;
    }

    // Both sides changed since the last sync — newer timestamp wins; keep both only when
    // the two edits are genuinely concurrent (< 90s apart).
    const remoteUpdated = meta.updated ? Date.parse(meta.updated) : 0;
    const localUpdated = local.updatedAt ?? 0;
    const concurrent = Math.abs(remoteUpdated - localUpdated) < 90_000;

    if (remoteUpdated > localUpdated && !concurrent) {
      const folder = await folderByName(meta.folder || folderName(local.folderId));
      await putNote({
        ...local,
        folderId: folder.id,
        title: meta.title || local.title,
        markdown: body,
        tags: Array.isArray(meta.tags) ? meta.tags : local.tags,
        syllabus: Array.isArray(meta.syllabus) ? meta.syllabus : local.syllabus,
        published: !!meta.published,
        slug: meta.slug || local.slug,
        driveModified: file.modifiedTime,
        syncedHash: remoteFileHash,
        updatedAt: remoteUpdated,
      });
      bus.emit('note-external-update', nid);
    } else if (localUpdated > remoteUpdated && !concurrent) {
      await putNote({ ...local, driveModified: file.modifiedTime }); // keep local; push() uploads it
    } else {
      await putNote({
        id: uid(),
        folderId: local.folderId,
        title: `${meta.title || local.title} (conflicted copy)`,
        markdown: body,
        tags: local.tags,
        syllabus: local.syllabus,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        published: false,
        order: 999,
      } as Note);
      await putNote({ ...local, driveModified: file.modifiedTime });
      toast(`"${local.title}" was edited on two devices at once — kept both copies.`, 'error');
    }
  }
}

/** A local note that has a Drive id but is gone from the remote listing was deleted elsewhere. */
async function applyRemoteDeletions(remoteById: Map<string, DriveFile>): Promise<void> {
  const folders = await allFolders();
  const folderName = (id: string) => folders.find((f) => f.id === id)?.name ?? 'Notes';
  for (const note of await allNotesIncludingTrash()) {
    if (note.trashed || !note.driveFileId || remoteById.has(note.id)) continue;
    const clean = note.syncedHash === (await fileHash(note, folderName(note.folderId)));
    if (clean) {
      await deleteNoteHard(note.id);
      bus.emit('note-external-update', note.id);
    } else {
      // Unsynced local edits beat the remote delete — recreate as a new file on push.
      await putNote({ ...note, driveFileId: undefined, driveModified: undefined, syncedHash: undefined });
    }
  }
}

async function push(rootId: string, remoteById: Map<string, DriveFile>): Promise<void> {
  const folders = await allFolders();
  const folderName = (id: string) => folders.find((f) => f.id === id)?.name ?? 'Notes';

  for (const note of await allNotesIncludingTrash()) {
    if (note.trashed) {
      const remote = note.driveFileId ? remoteById.get(note.id) : undefined;
      if (remote) await trashFile(remote.id).catch(() => {});
      await deleteNoteHard(note.id);
      continue;
    }

    const fname = folderName(note.folderId);
    const hash = await fileHash(note, fname);
    if (note.driveFileId && note.syncedHash === hash) continue; // clean

    const fileText = toMarkdownFile(note, fname);
    const fileName = `${note.title.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 80) || 'Untitled'}.md`;
    const props = { noteId: note.id, slug: note.slug ?? '', published: String(note.published) };

    try {
      const saved = note.driveFileId
        ? await updateFile(note.driveFileId, fileText, props, fileName)
        : await createFile(rootId, fileName, fileText, props);
      const current = await getNote(note.id);
      if (!current) continue;
      // The note may have been edited while we were uploading — only mark it clean if it
      // still serializes to exactly what we just pushed.
      const stillSame = (await fileHash(current, folderName(current.folderId))) === hash;
      await putNote({
        ...current,
        driveFileId: saved.id,
        driveModified: saved.modifiedTime,
        syncedHash: stillSame ? hash : current.syncedHash,
      });
    } catch (e) {
      console.error('[push]', note.title, e);
    }
  }
}

export async function fullResync(): Promise<void> {
  await metaSet('driveRootId', '');
  // Force every note to be re-evaluated against Drive.
  for (const n of await allNotesIncludingTrash()) {
    if (!n.trashed) await putNote({ ...n, syncedHash: undefined });
  }
  await syncNow('manual-full');
}

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
import {
  createFile,
  downloadFile,
  ensureRootFolder,
  listFiles,
  trashFile,
  updateFile,
  type DriveFile,
} from './drive';
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

  // Pull when the tab regains focus (see other devices' latest); push when it hides.
  document.addEventListener('visibilitychange', () => {
    syncNow(document.visibilityState === 'visible' ? 'focus' : 'hide');
  });
  window.addEventListener('focus', () => scheduleSync());

  if (timer) clearInterval(timer);
  timer = setInterval(() => syncNow('interval'), 30_000);

  // Re-link Drive with no UI (if previously granted), then do a first sync.
  void restoreDriveSession().then(() => {
    if (canSync()) syncNow('startup');
  });
}

let scheduleT: ReturnType<typeof setTimeout> | null = null;
function scheduleSync() {
  if (!canSync()) return;
  if (scheduleT) clearTimeout(scheduleT);
  scheduleT = setTimeout(() => syncNow('auto'), 2500);
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
    await push(rootId, remoteById);

    await metaSet('lastSync', Date.now());
    bus.emit('sync-state', { state: 'idle', at: Date.now() });
    await rebuildSearch();
    bus.emit('tree-changed');
  } catch (e) {
    console.error('[sync]', reason, e);
    bus.emit('sync-state', { state: 'error', message: (e as Error).message });
    if (String(e).includes('unauthorized')) toast('Drive session expired — reconnect from the sidebar.', 'error');
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
  const found = folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (found) return found;
  const f: Folder = { id: uid(), parentId: ROOT, name: name || 'Imported', createdAt: Date.now(), order: folders.length };
  await putFolder(f);
  return f;
}

async function pull(remoteById: Map<string, DriveFile>): Promise<void> {
  for (const [nid, file] of remoteById) {
    const local = await getNote(nid);
    if (local && local.driveModified === file.modifiedTime) continue; // up to date

    const text = await downloadFile(file.id);
    const { meta, body } = parseMarkdownFile(text);
    const remoteHash = await sha256(body);

    if (!local) {
      const folder = await folderByName(meta.folder || 'Imported');
      const note: Note = {
        id: nid,
        folderId: folder.id,
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
        syncedHash: remoteHash,
        order: 999,
      };
      await putNote(note);
      continue;
    }

    const localHash = await sha256(local.markdown);
    const localDirty = local.syncedHash !== localHash;

    if (!localDirty) {
      // Fast-forward to remote.
      await putNote({
        ...local,
        title: meta.title || local.title,
        markdown: body,
        tags: Array.isArray(meta.tags) ? meta.tags : local.tags,
        syllabus: Array.isArray(meta.syllabus) ? meta.syllabus : local.syllabus,
        published: !!meta.published,
        slug: meta.slug || local.slug,
        driveModified: file.modifiedTime,
        syncedHash: remoteHash,
        updatedAt: meta.updated ? Date.parse(meta.updated) : Date.now(),
      });
      bus.emit('note-external-update', nid);
    } else if (localHash !== remoteHash) {
      // Both sides changed since last sync. Prefer the newer edit by timestamp so the user
      // sees a single version across devices; only keep a conflict copy when the two edits
      // are genuinely concurrent (within 90s) to avoid silent data loss.
      const remoteUpdated = meta.updated ? Date.parse(meta.updated) : 0;
      const localUpdated = local.updatedAt ?? 0;
      const concurrent = Math.abs(remoteUpdated - localUpdated) < 90_000;

      if (remoteUpdated > localUpdated && !concurrent) {
        // Remote is clearly newer — take it.
        await putNote({
          ...local,
          title: meta.title || local.title,
          markdown: body,
          tags: Array.isArray(meta.tags) ? meta.tags : local.tags,
          syllabus: Array.isArray(meta.syllabus) ? meta.syllabus : local.syllabus,
          published: !!meta.published,
          slug: meta.slug || local.slug,
          driveModified: file.modifiedTime,
          syncedHash: remoteHash,
          updatedAt: remoteUpdated,
        });
        bus.emit('note-external-update', nid);
      } else if (localUpdated > remoteUpdated && !concurrent) {
        // Local is clearly newer — keep it; push() will upload it.
        await putNote({ ...local, driveModified: file.modifiedTime });
      } else {
        // Genuine concurrent edit — keep both, side by side in the same folder.
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
        });
        await putNote({ ...local, driveModified: file.modifiedTime });
        toast(`"${local.title}" was edited on two devices at once — kept both copies.`, 'error');
      }
    }
  }
}

async function push(rootId: string, remoteById: Map<string, DriveFile>): Promise<void> {
  const folders = await allFolders();
  const folderName = (id: string) => folders.find((f) => f.id === id)?.name ?? 'Notes';
  const notes = await allNotesIncludingTrash();

  for (const note of notes) {
    const remote = note.driveFileId ? remoteById.get(note.id) : undefined;

    if (note.trashed) {
      if (remote) await trashFile(remote.id).catch(() => {});
      await deleteNoteHard(note.id);
      continue;
    }

    const localHash = await sha256(note.markdown);
    if (note.driveFileId && note.syncedHash === localHash) continue; // clean

    const fileText = toMarkdownFile(note, folderName(note.folderId));
    const fileName = `${note.title.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 80) || 'Untitled'}.md`;
    const props = { noteId: note.id, slug: note.slug ?? '', published: String(note.published) };

    try {
      let saved: DriveFile;
      if (note.driveFileId) saved = await updateFile(note.driveFileId, fileText, props, fileName);
      else saved = await createFile(rootId, fileName, fileText, props);
      await putNote({
        ...(await getNote(note.id))!,
        driveFileId: saved.id,
        driveModified: saved.modifiedTime,
        syncedHash: localHash,
      });
    } catch (e) {
      console.error('[push]', note.title, e);
    }
  }
}

export async function fullResync(): Promise<void> {
  await metaSet('driveRootId', '');
  await syncNow('manual-full');
}

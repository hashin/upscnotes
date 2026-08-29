import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Asset, Folder, Meta, Note, Snapshot } from './models';

interface UpscDB extends DBSchema {
  notes: { key: string; value: Note; indexes: { byFolder: string; byUpdated: number } };
  folders: { key: string; value: Folder; indexes: { byParent: string } };
  assets: { key: string; value: Asset; indexes: { byNote: string } };
  snapshots: { key: string; value: Snapshot; indexes: { byNote: string } };
  meta: { key: string; value: Meta };
}

let dbp: Promise<IDBPDatabase<UpscDB>> | null = null;

export function db(): Promise<IDBPDatabase<UpscDB>> {
  if (!dbp) {
    dbp = openDB<UpscDB>('upscnotes', 1, {
      upgrade(d) {
        const notes = d.createObjectStore('notes', { keyPath: 'id' });
        notes.createIndex('byFolder', 'folderId');
        notes.createIndex('byUpdated', 'updatedAt');
        const folders = d.createObjectStore('folders', { keyPath: 'id' });
        folders.createIndex('byParent', 'parentId');
        const assets = d.createObjectStore('assets', { keyPath: 'id' });
        assets.createIndex('byNote', 'noteId');
        const snaps = d.createObjectStore('snapshots', { keyPath: 'id' });
        snaps.createIndex('byNote', 'noteId');
        d.createObjectStore('meta', { keyPath: 'key' });
      },
    });
  }
  return dbp;
}

/* ---------- meta helpers ---------- */

export async function metaGet<T = unknown>(key: string, fallback: T): Promise<T> {
  const row = await (await db()).get('meta', key);
  return row ? (row.value as T) : fallback;
}
export async function metaSet(key: string, value: unknown): Promise<void> {
  await (await db()).put('meta', { key, value });
}

/* ---------- notes ---------- */

export async function allNotes(): Promise<Note[]> {
  return (await (await db()).getAll('notes')).filter((n) => !n.trashed);
}
export async function allNotesIncludingTrash(): Promise<Note[]> {
  return (await db()).getAll('notes');
}
export async function getNote(id: string): Promise<Note | undefined> {
  return (await db()).get('notes', id);
}
export async function putNote(n: Note): Promise<void> {
  await (await db()).put('notes', n);
}
export async function deleteNoteHard(id: string): Promise<void> {
  const d = await db();
  await d.delete('notes', id);
  const tx = d.transaction(['assets', 'snapshots'], 'readwrite');
  for (const a of await tx.objectStore('assets').index('byNote').getAllKeys(id))
    await tx.objectStore('assets').delete(a);
  for (const s of await tx.objectStore('snapshots').index('byNote').getAllKeys(id))
    await tx.objectStore('snapshots').delete(s);
  await tx.done;
}

/* ---------- folders ---------- */

export async function allFolders(): Promise<Folder[]> {
  return (await db()).getAll('folders');
}
export async function putFolder(f: Folder): Promise<void> {
  await (await db()).put('folders', f);
}
export async function deleteFolder(id: string): Promise<void> {
  await (await db()).delete('folders', id);
}

/* ---------- assets ---------- */

export async function putAsset(a: Asset): Promise<void> {
  await (await db()).put('assets', a);
}
export async function getAsset(id: string): Promise<Asset | undefined> {
  return (await db()).get('assets', id);
}
export async function assetsForNote(noteId: string): Promise<Asset[]> {
  return (await db()).getAllFromIndex('assets', 'byNote', noteId);
}

/* ---------- snapshots (local version history) ---------- */

const MAX_SNAPSHOTS = 40;

export async function pushSnapshot(s: Snapshot): Promise<void> {
  const d = await db();
  await d.put('snapshots', s);
  const keys = await d.getAllFromIndex('snapshots', 'byNote', s.noteId);
  keys.sort((a, b) => b.at - a.at);
  for (const old of keys.slice(MAX_SNAPSHOTS)) await d.delete('snapshots', old.id);
}
export async function snapshotsForNote(noteId: string): Promise<Snapshot[]> {
  const rows = await (await db()).getAllFromIndex('snapshots', 'byNote', noteId);
  return rows.sort((a, b) => b.at - a.at);
}

export async function wipeAll(): Promise<void> {
  const d = await db();
  for (const s of ['notes', 'folders', 'assets', 'snapshots', 'meta'] as const)
    await d.clear(s);
}

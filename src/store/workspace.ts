import MiniSearch from 'minisearch';
import { SECTIONS } from '../upsc/syllabus';
import { bus } from '../util/misc';
import { sha256, slugify } from '../util/misc';
import {
  allFolders,
  allNotes,
  deleteNoteHard,
  getNote,
  metaGet,
  metaSet,
  putFolder,
  putNote,
  pushSnapshot,
} from './db';
import { ROOT, uid, type Folder, type Note } from './models';

let search: MiniSearch<Note> | null = null;

/** Seed the built-in UPSC folder structure the first time the app runs. */
export async function bootstrapWorkspace(): Promise<void> {
  if (await metaGet('seeded', false)) return;
  let order = 0;
  for (const section of SECTIONS) {
    const f: Folder = {
      id: uid(),
      parentId: ROOT,
      name: section.label.split('—')[0].trim(),
      section: section.code,
      createdAt: Date.now(),
      order: order++,
      collapsed: true,
    };
    await putFolder(f);
  }
  const welcome: Note = {
    id: uid(),
    folderId: ROOT,
    title: 'Welcome to UPSC Notes',
    markdown: WELCOME_MD,
    tags: ['meta'],
    syllabus: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    published: false,
    order: 0,
  };
  await putNote(welcome);
  await metaSet('seeded', true);
  await metaSet('openNoteId', welcome.id);
}

export async function rebuildSearch(): Promise<void> {
  const notes = await allNotes();
  search = new MiniSearch<Note>({
    fields: ['title', 'markdown', 'tags', 'syllabus'],
    storeFields: ['title', 'folderId', 'updatedAt', 'published'],
    searchOptions: { boost: { title: 3, tags: 2 }, fuzzy: 0.2, prefix: true },
    extractField: (doc, field) =>
      Array.isArray((doc as any)[field]) ? (doc as any)[field].join(' ') : String((doc as any)[field] ?? ''),
  });
  search.addAll(notes);
}

export function queryNotes(q: string): { id: string; title: string; folderId: string }[] {
  if (!search || !q.trim()) return [];
  return search.search(q).slice(0, 40).map((r) => ({ id: r.id as string, title: r.title, folderId: r.folderId }));
}

export async function tree(): Promise<{ folders: Folder[]; notes: Note[] }> {
  const [folders, notes] = await Promise.all([allFolders(), allNotes()]);
  folders.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  notes.sort((a, b) => a.order - b.order || b.updatedAt - a.updatedAt);
  return { folders, notes };
}

export async function createNote(folderId: string, title: string, markdown: string): Promise<Note> {
  const now = Date.now();
  const siblings = (await allNotes()).filter((n) => n.folderId === folderId);
  const note: Note = {
    id: uid(),
    folderId,
    title: title || 'Untitled',
    markdown,
    tags: [],
    syllabus: [],
    createdAt: now,
    updatedAt: now,
    published: false,
    order: siblings.length,
  };
  await putNote(note);
  await rebuildSearch();
  bus.emit('tree-changed');
  bus.emit('sync-request');
  return note;
}

let lastSnapshotAt = 0;

export async function saveNote(id: string, patch: Partial<Note>): Promise<Note | undefined> {
  const note = await getNote(id);
  if (!note) return;
  const next: Note = { ...note, ...patch, updatedAt: Date.now() };
  if (patch.title != null) next.title = patch.title || 'Untitled';
  await putNote(next);

  // Local version history — at most one snapshot per 90s of active editing.
  if (patch.markdown != null && Date.now() - lastSnapshotAt > 90_000 && patch.markdown !== note.markdown) {
    lastSnapshotAt = Date.now();
    await pushSnapshot({ id: uid(), noteId: id, markdown: note.markdown, title: note.title, at: note.updatedAt });
  }

  await rebuildSearch();
  bus.emit('note-saved', next);
  if (patch.title != null || patch.folderId != null) bus.emit('tree-changed');
  bus.emit('sync-request');
  return next;
}

export async function trashNote(id: string): Promise<void> {
  const note = await getNote(id);
  if (!note) return;
  if (note.driveFileId) {
    await putNote({ ...note, trashed: true, updatedAt: Date.now() });
    bus.emit('sync-request');
  } else {
    await deleteNoteHard(id);
  }
  await rebuildSearch();
  bus.emit('tree-changed');
}

export async function createFolder(parentId: string, name: string): Promise<Folder> {
  const siblings = (await allFolders()).filter((f) => f.parentId === parentId);
  const folder: Folder = {
    id: uid(),
    parentId,
    name: name || 'New folder',
    createdAt: Date.now(),
    order: siblings.length,
  };
  await putFolder(folder);
  bus.emit('tree-changed');
  return folder;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const folders = await allFolders();
  const f = folders.find((x) => x.id === id);
  if (!f) return;
  await putFolder({ ...f, name });
  bus.emit('tree-changed');
}

export async function toggleFolder(id: string): Promise<void> {
  const folders = await allFolders();
  const f = folders.find((x) => x.id === id);
  if (!f) return;
  await putFolder({ ...f, collapsed: !f.collapsed });
  bus.emit('tree-changed');
}

/** Slug that is unique within the user's published set. */
export async function ensureSlug(note: Note): Promise<string> {
  if (note.slug) return note.slug;
  const base = slugify(note.title);
  const taken = new Set((await allNotes()).filter((n) => n.id !== note.id && n.slug).map((n) => n.slug!));
  let slug = base;
  let i = 2;
  while (taken.has(slug)) slug = `${base}-${i++}`;
  return slug;
}

export async function allTags(): Promise<string[]> {
  const set = new Set<string>();
  for (const n of await allNotes()) n.tags.forEach((t) => set.add(t));
  return [...set].sort();
}

export async function contentHash(md: string): Promise<string> {
  return sha256(md);
}

const WELCOME_MD = `This is a **free, offline-first** place to build your preparation notes — GS1–4, Essay,
current affairs and your optional. Everything works in the browser, even with no network.

## How it works

- Your notes live **in this browser** first (IndexedDB). Nothing is lost if you go offline.
- Sign in with Google to **back everything up to your own Google Drive** — a folder called
  \`UPSC Notes\` full of plain \`.md\` files you fully own.
- Pick a username to **publish** chosen notes at \`upscnotes.hashin.me/your-name\`.

## Markdown you can use

- Headings, **bold**, _italic_, lists, > quotes, \`code\`, tables
- Math: $E = mc^2$ and $$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$$
- Diagrams:

\`\`\`mermaid
flowchart LR
  Read --> Note --> Revise --> Answer
\`\`\`

- Task lists:
  - [ ] Finish Polity notes
  - [x] Set up UPSC Notes

## Templates

Use **New note ▸ from template** for answer-writing frames, PYQ logs, current-affairs
cards and more.

Delete this note whenever you like.
`;

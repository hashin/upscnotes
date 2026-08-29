import { allFolders, allNotes } from '../store/db';
import { createNote, createFolder, rebuildSearch } from '../store/workspace';
import { parseMarkdownFile } from '../sync/frontmatter';
import { render } from '../render/markdown';
import { bus, slugify, toast } from '../util/misc';
import type { Note } from '../store/models';

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportMarkdown(note: Note) {
  download(`${slugify(note.title)}.md`, `# ${note.title}\n\n${note.markdown}`, 'text/markdown');
}

export function exportHtml(note: Note) {
  const html = `<!doctype html><meta charset="utf-8"><title>${note.title}</title>
<style>body{max-width:44rem;margin:3rem auto;padding:0 1rem;font:17px/1.7 Georgia,serif;color:#222}
pre{background:#f4f2ee;padding:1rem;overflow:auto;border-radius:8px}code{font-family:ui-monospace,monospace}
blockquote{border-left:3px solid #ccc;margin:0;padding-left:1rem;color:#555}
table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:.4rem .6rem}img{max-width:100%}</style>
<h1>${note.title}</h1>
${render(note.markdown)}`;
  download(`${slugify(note.title)}.html`, html, 'text/html');
}

export function printNote() {
  window.print();
}

export async function exportWorkspaceZip() {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const [notes, folders] = await Promise.all([allNotes(), allFolders()]);
  const folderName = (id: string) => folders.find((f) => f.id === id)?.name ?? 'Notes';
  const used = new Set<string>();
  for (const n of notes) {
    let base = `${folderName(n.folderId)}/${slugify(n.title)}`;
    let path = `${base}.md`;
    let i = 2;
    while (used.has(path)) path = `${base}-${i++}.md`;
    used.add(path);
    const fm = `---\ntitle: ${JSON.stringify(n.title)}\ntags: [${n.tags.join(', ')}]\nsyllabus: [${n.syllabus.join(', ')}]\nupdated: ${new Date(n.updatedAt).toISOString()}\n---\n\n`;
    zip.file(path, fm + n.markdown);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  download(`upsc-notes-${new Date().toISOString().slice(0, 10)}.zip`, blob, 'application/zip');
  toast(`Exported ${notes.length} notes.`, 'success');
}

export async function importFiles(files: FileList) {
  let count = 0;
  const zips = [...files].filter((f) => f.name.endsWith('.zip'));
  const mds = [...files].filter((f) => /\.(md|markdown|txt)$/i.test(f.name));

  const targetFolder = await createFolder('root', `Imported ${new Date().toLocaleDateString()}`);

  for (const f of mds) {
    const text = await f.text();
    const { meta, body } = parseMarkdownFile(text);
    const title = meta.title || f.name.replace(/\.(md|markdown|txt)$/i, '');
    await createNote(targetFolder.id, title, body || text);
    count++;
  }

  for (const zf of zips) {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(zf);
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || !/\.(md|markdown|txt)$/i.test(entry.name)) continue;
      const text = await entry.async('string');
      const { meta, body } = parseMarkdownFile(text);
      const title = meta.title || entry.name.split('/').pop()!.replace(/\.(md|markdown|txt)$/i, '');
      await createNote(targetFolder.id, title, body || text);
      count++;
    }
  }

  await rebuildSearch();
  bus.emit('tree-changed');
  toast(count ? `Imported ${count} notes.` : 'No markdown files found.', count ? 'success' : 'error');
}

export function pickAndImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.md,.markdown,.txt,.zip';
  input.onchange = () => input.files && importFiles(input.files);
  input.click();
}

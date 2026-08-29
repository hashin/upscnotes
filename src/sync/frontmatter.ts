import type { Note } from '../store/models';

/** Serialize a note to a portable .md file: YAML front-matter + body. */
export function toMarkdownFile(note: Note, folderName: string): string {
  const fm: Record<string, unknown> = {
    id: note.id,
    title: note.title,
    folder: folderName,
    tags: note.tags,
    syllabus: note.syllabus,
    published: note.published,
    slug: note.slug ?? '',
    created: new Date(note.createdAt).toISOString(),
    updated: new Date(note.updatedAt).toISOString(),
  };
  const yaml = Object.entries(fm)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.map((x) => JSON.stringify(String(x))).join(', ')}]`;
      if (typeof v === 'boolean' || typeof v === 'number') return `${k}: ${v}`;
      return `${k}: ${JSON.stringify(String(v))}`;
    })
    .join('\n');
  return `---\n${yaml}\n---\n\n${note.markdown.replace(/^﻿/, '')}`;
}

export interface ParsedFile {
  meta: Record<string, any>;
  body: string;
}

export function parseMarkdownFile(text: string): ParsedFile {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, any> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawRaw] = kv;
    const raw = rawRaw.trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1).trim();
      meta[key] = inner ? inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')) : [];
    } else if (raw === 'true' || raw === 'false') {
      meta[key] = raw === 'true';
    } else {
      meta[key] = raw.replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body: text.slice(m[0].length).replace(/^\r?\n/, '') };
}

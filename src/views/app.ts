import { cloudEnabled } from '../config';
import { getUser } from '../auth/google';
import { Editor } from '../editor/editor';
import { Preview } from '../render/preview';
import { outline } from '../render/markdown';
import { getNote, metaGet, metaSet } from '../store/db';
import type { Note } from '../store/models';
import {
  createFolder,
  createNote,
  renameFolder,
  saveNote,
  toggleFolder,
  trashNote,
  tree,
} from '../store/workspace';
import { setPublished } from '../publish/publish';
import { openAccountModal } from '../ui/account';
import { exportHtml, exportMarkdown, exportWorkspaceZip, pickAndImport, printNote } from '../ui/exporter';
import { openPalette, type Command } from '../ui/palette';
import { confirmModal, modal } from '../ui/modal';
import { applySettings, cycleTheme, settings } from '../ui/settings';
import { openSyllabusPicker } from '../ui/syllabusPicker';
import { TEMPLATES, templateById } from '../upsc/templates';
import { syllabusLabel } from '../upsc/syllabus';
import { bus, countWords, debounce, h, relativeTime, toast } from '../util/misc';

const READING_WPM = 150;

export class WorkspaceView {
  private root: HTMLElement;
  private editor: Editor | null = null;
  private preview!: Preview;
  private current: Note | null = null;
  private els: Record<string, HTMLElement> = {};
  private suppressScroll = false;
  private editorFocused = true;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async mount() {
    this.root.innerHTML = '';
    this.root.removeAttribute('aria-busy');
    this.root.className = 'workspace';
    this.root.append(this.topbar(), this.sidebar(), this.editorColumn(), this.previewColumn());

    bus.on('tree-changed', () => this.renderTree());
    bus.on('auth', () => this.renderAccountButton());
    bus.on('sync-state', (s: any) => this.renderSyncState(s));
    bus.on('note-external-update', (id: string) => {
      if (this.current?.id === id) this.openNote(id);
    });
    bus.on('open-note', (id: string) => this.openNote(id));
    bus.on('close-modals', () => document.querySelectorAll('.modal-overlay,.palette-overlay').forEach((n) => n.remove()));

    document.addEventListener('keydown', (e) => this.onKey(e), true);

    await this.renderTree();
    this.renderAccountButton();
    const openId = await metaGet<string>('openNoteId', '');
    const first = (await tree()).notes[0];
    await this.openNote(openId || first?.id || '');
  }

  /* ---------------- topbar ---------------- */

  private topbar(): HTMLElement {
    const sync = h('button', { class: 'sync-chip', title: 'Sync status', onclick: () => bus.emit('sync-request') }, ['·']);
    this.els.sync = sync;

    const account = h('button', { class: 'btn btn-sm account-btn', onclick: () => openAccountModal() }, ['Account']);
    this.els.account = account;

    const bar = h('header', { class: 'topbar' }, [
      h('div', { class: 'brand' }, [
        h('button', { class: 'icon-btn menu-toggle', 'aria-label': 'Toggle sidebar', onclick: () => this.root.classList.toggle('sidebar-open') }, ['☰']),
        h('span', { class: 'brand-mark' }, ['UPSC Notes']),
      ]),
      h('div', { class: 'topbar-actions' }, [
        h('button', { class: 'btn btn-sm', title: 'Command palette (⌘/Ctrl-K)', onclick: () => this.palette() }, ['⌘K']),
        h('button', { class: 'btn btn-sm', title: 'Cycle theme', onclick: () => cycleTheme() }, ['◑']),
        h('button', { class: 'btn btn-sm view-toggle', title: 'View mode', onclick: () => this.cycleView() }, ['⇹']),
        sync,
        account,
      ]),
    ]);
    return bar;
  }

  private renderAccountButton() {
    const u = getUser();
    this.els.account.textContent = u ? '@' + (u.username ?? u.name.split(' ')[0]) : cloudEnabled() ? 'Sign in' : 'Account';
  }

  private renderSyncState(s: { state: string; at?: number; message?: string }) {
    const chip = this.els.sync;
    chip.classList.remove('syncing', 'error', 'ok');
    if (s.state === 'syncing') { chip.classList.add('syncing'); chip.textContent = '⟳'; chip.title = 'Syncing…'; }
    else if (s.state === 'error') { chip.classList.add('error'); chip.textContent = '!'; chip.title = s.message ?? 'Sync error'; }
    else { chip.classList.add('ok'); chip.textContent = '✓'; chip.title = s.at ? `Synced ${relativeTime(s.at)}` : 'Synced'; }
  }

  private cycleView() {
    const order = ['split', 'editor', 'preview'] as const;
    const next = order[(order.indexOf(settings().view) + 1) % order.length];
    applySettings({ view: next });
    toast(`View: ${next}`);
    if (this.current) this.preview.updateNow(this.current.markdown);
  }

  /* ---------------- sidebar ---------------- */

  private sidebar(): HTMLElement {
    const searchInput = h('input', {
      class: 'sidebar-search',
      placeholder: 'Search notes…',
      oninput: () => this.renderTree(),
    }) as HTMLInputElement;
    this.els.search = searchInput;

    const treeHost = h('div', { class: 'tree', role: 'tree' });
    this.els.tree = treeHost;

    const newNote = h('button', { class: 'btn btn-primary btn-block', onclick: () => this.newNoteFlow('root') }, ['+ New note']);
    const newFolder = h('button', { class: 'btn btn-sm', onclick: () => this.newFolderFlow('root') }, ['+ Folder']);
    const importBtn = h('button', { class: 'btn btn-sm', onclick: () => pickAndImport() }, ['Import']);
    const exportBtn = h('button', { class: 'btn btn-sm', onclick: () => exportWorkspaceZip() }, ['Export all']);

    return h('nav', { class: 'sidebar' }, [
      h('div', { class: 'sidebar-top' }, [newNote, h('div', { class: 'sidebar-row' }, [newFolder, importBtn, exportBtn])]),
      searchInput,
      treeHost,
      h('footer', { class: 'sidebar-foot' }, [
        h('a', { href: '/about', class: 'muted', onclick: (e: Event) => { e.preventDefault(); bus.emit('navigate', '/about'); } }, ['About']),
        h('span', { class: 'muted' }, [' · offline-ready']),
      ]),
    ]);
  }

  private async renderTree() {
    const host = this.els.tree;
    if (!host) return;
    const q = (this.els.search as HTMLInputElement).value.trim().toLowerCase();
    const { folders, notes } = await tree();
    host.innerHTML = '';

    const matches = (n: Note) =>
      !q || n.title.toLowerCase().includes(q) || n.tags.some((t) => t.includes(q)) || n.markdown.toLowerCase().includes(q);

    const renderNoteRow = (n: Note) => {
      const row = h(
        'div',
        {
          class: 'tree-note' + (this.current?.id === n.id ? ' active' : ''),
          role: 'treeitem',
          tabindex: '0',
          onclick: () => this.openNote(n.id),
          onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && this.openNote(n.id),
        },
        [
          h('span', { class: 'tree-note-title' }, [n.title || 'Untitled']),
          n.published ? h('span', { class: 'dot-pub', title: 'Published' }, ['●']) : document.createComment(''),
        ],
      );
      return row;
    };

    const rootNotes = notes.filter((n) => n.folderId === 'root' && matches(n));
    for (const n of rootNotes) host.append(renderNoteRow(n));

    for (const f of folders.filter((x) => x.parentId === 'root')) {
      const childNotes = notes.filter((n) => n.folderId === f.id && matches(n));
      if (q && childNotes.length === 0) continue;
      const collapsed = q ? false : f.collapsed;
      const header = h('div', { class: 'tree-folder' }, [
        h('button', { class: 'tree-caret', onclick: () => toggleFolder(f.id) }, [collapsed ? '▸' : '▾']),
        h('span', {
          class: 'tree-folder-name',
          ondblclick: () => this.renameFolderFlow(f.id, f.name),
          onclick: () => toggleFolder(f.id),
        }, [f.name]),
        h('span', { class: 'tree-count' }, [String(childNotes.length)]),
        h('button', { class: 'tree-add', title: 'New note here', onclick: () => this.newNoteFlow(f.id) }, ['+']),
      ]);
      host.append(header);
      if (!collapsed) {
        const kids = h('div', { class: 'tree-children' });
        for (const n of childNotes) kids.append(renderNoteRow(n));
        host.append(kids);
      }
    }

    if (!host.children.length) host.append(h('p', { class: 'tree-empty muted' }, [q ? 'No matches.' : 'No notes yet.']));
  }

  /* ---------------- editor column ---------------- */

  private editorColumn(): HTMLElement {
    const titleInput = h('input', {
      class: 'note-title',
      placeholder: 'Note title',
      oninput: () => this.onTitleInput(),
    }) as HTMLInputElement;
    this.els.title = titleInput;

    const tagsInput = h('input', {
      class: 'note-tags',
      placeholder: 'tags, comma separated',
      onchange: () => this.onTagsChange(),
    }) as HTMLInputElement;
    this.els.tags = tagsInput;

    const sylBtn = h('button', { class: 'chip-btn', onclick: () => this.pickSyllabus() }, ['+ syllabus']);
    this.els.syl = sylBtn;

    const pubToggle = h('label', { class: 'pub-toggle', title: 'Publish to your public page' }, [
      (() => {
        const cb = h('input', { type: 'checkbox', onchange: (e: Event) => this.onPublishToggle((e.target as HTMLInputElement).checked) }) as HTMLInputElement;
        this.els.pub = cb;
        return cb;
      })(),
      h('span', {}, ['Public']),
    ]);

    const metaBar = h('div', { class: 'note-meta' }, [
      h('div', { class: 'note-meta-tags' }, [tagsInput, sylBtn]),
      pubToggle,
    ]);
    this.els.sylChips = h('div', { class: 'syl-chips' });

    const toolbar = this.toolbar();
    const cmHost = h('div', { class: 'cm-host' });
    this.els.cmHost = cmHost;

    const footer = h('div', { class: 'editor-foot' }, [
      (this.els.stats = h('span', { class: 'muted' }, ['—'])),
      (this.els.saved = h('span', { class: 'muted' }, [''])),
    ]);

    return h('main', { class: 'editor-col' }, [
      h('div', { class: 'note-head' }, [titleInput, metaBar, this.els.sylChips]),
      toolbar,
      cmHost,
      footer,
    ]);
  }

  private toolbar(): HTMLElement {
    const b = (label: string, title: string, fn: () => void) =>
      h('button', { class: 'tb-btn', title, onmousedown: (e: Event) => e.preventDefault(), onclick: fn }, [label]);
    const e = () => this.editor!;
    return h('div', { class: 'toolbar', role: 'toolbar' }, [
      b('H1', 'Heading 1', () => e().heading(1)),
      b('H2', 'Heading 2', () => e().heading(2)),
      b('H3', 'Heading 3', () => e().heading(3)),
      h('span', { class: 'tb-sep' }, []),
      b('B', 'Bold (⌘/Ctrl-B)', () => e().wrap('**')),
      b('I', 'Italic (⌘/Ctrl-I)', () => e().wrap('_')),
      b('S', 'Strikethrough', () => e().wrap('~~')),
      b('‹›', 'Inline code', () => e().wrap('`')),
      h('span', { class: 'tb-sep' }, []),
      b('•', 'Bullet list', () => e().prefixLines('- ')),
      b('1.', 'Numbered list', () => e().prefixLines('1. ')),
      b('☐', 'Task', () => e().prefixLines('- [ ] ')),
      b('❝', 'Quote', () => e().prefixLines('> ')),
      h('span', { class: 'tb-sep' }, []),
      b('🔗', 'Link', () => e().link()),
      b('▦', 'Table', () => e().table()),
      b('∑', 'Math block', () => e().insert('\n$$\n\n$$\n', 4)),
      b('❈', 'Diagram', () => e().insert('\n```mermaid\nflowchart LR\n  A --> B\n```\n', 12)),
      h('span', { class: 'tb-sep' }, []),
      b('⤓', 'Export this note', () => this.current && this.exportMenu()),
    ]);
  }

  /* ---------------- preview column ---------------- */

  private previewColumn(): HTMLElement {
    const scroller = h('div', { class: 'preview-scroll' });
    this.els.previewScroll = scroller;
    this.preview = new Preview(scroller);

    scroller.addEventListener('scroll', debounce(() => {
      if (this.suppressScroll || this.editorFocused || settings().view !== 'split') return;
      const denom = scroller.scrollHeight - scroller.clientHeight;
      if (denom > 0 && this.editor) this.editor.scrollToFraction(scroller.scrollTop / denom);
    }, 60));

    const outlineHost = h('div', { class: 'outline' });
    this.els.outline = outlineHost;

    return h('aside', { class: 'preview-col' }, [
      h('div', { class: 'preview-tabs' }, [
        h('button', { class: 'ptab active', onclick: (ev: Event) => this.showPane('preview', ev) }, ['Preview']),
        h('button', { class: 'ptab', onclick: (ev: Event) => this.showPane('outline', ev) }, ['Outline']),
      ]),
      scroller,
      outlineHost,
    ]);
  }

  private showPane(which: 'preview' | 'outline', ev: Event) {
    this.els.previewScroll.style.display = which === 'preview' ? '' : 'none';
    this.els.outline.style.display = which === 'outline' ? 'block' : 'none';
    (ev.currentTarget as HTMLElement).parentElement!.querySelectorAll('.ptab').forEach((t) => t.classList.remove('active'));
    (ev.currentTarget as HTMLElement).classList.add('active');
  }

  private renderOutline() {
    const host = this.els.outline;
    host.innerHTML = '';
    if (!this.current) return;
    const heads = outline(this.current.markdown);
    if (!heads.length) {
      host.append(h('p', { class: 'muted', style: 'padding:1rem' }, ['Headings appear here.']));
      return;
    }
    for (const hd of heads) {
      host.append(
        h('button', {
          class: `outline-item lvl-${hd.level}`,
          onclick: () => {
            this.preview.scrollToSlug(hd.slug);
            this.editor?.scrollToLine(hd.line + 1);
          },
        }, [hd.text || '—']),
      );
    }
  }

  /* ---------------- note lifecycle ---------------- */

  async openNote(id: string) {
    const note = id ? await getNote(id) : undefined;
    if (!note) {
      this.current = null;
      (this.els.title as HTMLInputElement).value = '';
      this.els.cmHost.innerHTML = '';
      this.preview.updateNow('_Select or create a note._');
      return;
    }
    this.current = note;
    await metaSet('openNoteId', id);

    (this.els.title as HTMLInputElement).value = note.title === 'Untitled' ? '' : note.title;
    this.preview.title = note.title;
    (this.els.tags as HTMLInputElement).value = note.tags.join(', ');
    (this.els.pub as HTMLInputElement).checked = note.published;
    this.renderSylChips();

    this.editor?.destroy();
    this.els.cmHost.innerHTML = '';
    this.editor = new Editor(
      this.els.cmHost,
      note.markdown,
      {
        onChange: (doc) => this.onDocChange(doc),
        onScroll: (f) => {
          if (this.suppressScroll || settings().view !== 'split') return;
          this.editorFocused = true;
          this.preview.syncToFraction(f);
        },
        onCursorLine: (line) => {
          if (settings().view === 'split') this.preview.syncToLine(line);
        },
      },
      { lineNumbers: settings().lineNumbers },
    );
    this.editor.view.contentDOM.spellcheck = settings().spellcheck;
    this.editor.view.contentDOM.addEventListener('focus', () => (this.editorFocused = true));
    this.els.previewScroll.addEventListener('mouseenter', () => (this.editorFocused = false));

    this.preview.updateNow(note.markdown);
    this.renderOutline();
    this.updateStats();
    this.renderTree();
  }

  private onDocChange = (() => {
    const persist = debounce(async (doc: string) => {
      if (!this.current) return;
      const saved = await saveNote(this.current.id, { markdown: doc });
      if (saved) this.current = saved;
      (this.els.saved as HTMLElement).textContent = 'saved ' + new Date().toLocaleTimeString();
    }, 600);
    return (doc: string) => {
      if (!this.current) return;
      this.current.markdown = doc;
      this.preview.update(doc);
      this.updateStats();
      this.renderOutline();
      persist(doc);
    };
  })();

  private onTitleInput = (() => {
    const persist = debounce(async (title: string) => {
      if (!this.current) return;
      const saved = await saveNote(this.current.id, { title });
      if (saved) this.current = saved;
    }, 400);
    return () => {
      const title = (this.els.title as HTMLInputElement).value.trim();
      this.preview.title = title;
      if (this.current) this.preview.update(this.current.markdown);
      persist(title);
    };
  })();

  private async onTagsChange() {
    if (!this.current) return;
    const tags = (this.els.tags as HTMLInputElement).value
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const saved = await saveNote(this.current.id, { tags });
    if (saved) this.current = saved;
  }

  private renderSylChips() {
    const host = this.els.sylChips;
    host.innerHTML = '';
    if (!this.current) return;
    for (const code of this.current.syllabus) {
      host.append(
        h('span', { class: 'syl-chip', title: syllabusLabel(code) }, [
          code,
          h('button', {
            class: 'syl-chip-x',
            onclick: async () => {
              const saved = await saveNote(this.current!.id, { syllabus: this.current!.syllabus.filter((c) => c !== code) });
              if (saved) this.current = saved;
              this.renderSylChips();
            },
          }, ['✕']),
        ]),
      );
    }
  }

  private pickSyllabus() {
    if (!this.current) return;
    openSyllabusPicker(this.current.syllabus, async (codes) => {
      const saved = await saveNote(this.current!.id, { syllabus: codes });
      if (saved) this.current = saved;
      this.renderSylChips();
    });
  }

  private async onPublishToggle(on: boolean) {
    if (!this.current) return;
    try {
      await setPublished(this.current.id, on);
      this.current = (await getNote(this.current.id)) ?? this.current;
    } catch (e) {
      toast((e as Error).message, 'error');
      (this.els.pub as HTMLInputElement).checked = !on;
      if ((e as Error).message.includes('username')) openAccountModal();
    }
    this.renderTree();
  }

  private updateStats() {
    if (!this.current) return;
    const w = countWords(this.current.markdown);
    const mins = Math.max(1, Math.round(w / READING_WPM));
    (this.els.stats as HTMLElement).textContent = `${w} words · ${mins} min read`;
  }

  /* ---------------- flows ---------------- */

  private async newNoteFlow(folderId: string) {
    const pick = await this.chooseTemplate();
    if (pick === null) return;
    const tmpl = templateById(pick);
    const note = await createNote(folderId, '', tmpl.build());
    await this.openNote(note.id);
    (this.els.title as HTMLInputElement).focus();
  }

  private chooseTemplate(): Promise<string | null> {
    return new Promise((resolve) => {
      const list = h('div', { class: 'template-list' });
      let resolved = false;
      const done = (v: string | null) => { if (!resolved) { resolved = true; close(); resolve(v); } };
      for (const t of TEMPLATES) {
        list.append(
          h('button', { class: 'template-item', onclick: () => done(t.id) }, [
            h('strong', {}, [t.name]),
            h('span', { class: 'muted' }, [t.hint]),
          ]),
        );
      }
      const close = modal('New note', list, [h('button', { class: 'btn', onclick: () => done(null) }, ['Cancel'])]);
    });
  }

  private async newFolderFlow(parentId: string) {
    const name = prompt('Folder name');
    if (name) await createFolder(parentId, name.trim());
  }

  private async renameFolderFlow(id: string, currentName: string) {
    const name = prompt('Rename folder', currentName);
    if (name && name.trim() !== currentName) await renameFolder(id, name.trim());
  }

  private exportMenu() {
    if (!this.current) return;
    const n = this.current;
    const body = h('div', { class: 'template-list' }, [
      h('button', { class: 'template-item', onclick: () => { exportMarkdown(n); close(); } }, [h('strong', {}, ['Markdown (.md)'])]),
      h('button', { class: 'template-item', onclick: () => { exportHtml(n); close(); } }, [h('strong', {}, ['Styled HTML'])]),
      h('button', { class: 'template-item', onclick: () => { printNote(); close(); } }, [h('strong', {}, ['Print / Save as PDF'])]),
    ]);
    const close = modal(`Export "${n.title}"`, body);
  }

  /* ---------------- keyboard + palette ---------------- */

  private onKey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); this.palette(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); bus.emit('sync-request'); toast('Saved & syncing'); }
    else if (mod && e.key.toLowerCase() === 'b' && this.editor) { e.preventDefault(); this.editor.wrap('**'); }
    else if (mod && e.key.toLowerCase() === 'i' && this.editor) { e.preventDefault(); this.editor.wrap('_'); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); this.palette(); }
  }

  private palette() {
    const cmds: Command[] = [
      { id: 'new', label: 'New note', hint: '⌘N', run: () => this.newNoteFlow('root') },
      { id: 'new-folder', label: 'New folder', run: () => this.newFolderFlow('root') },
      { id: 'sync', label: 'Sync now', run: () => bus.emit('sync-request') },
      { id: 'account', label: 'Account & publishing', run: () => openAccountModal() },
      { id: 'theme', label: 'Cycle theme (light / sepia / dark)', run: () => cycleTheme() },
      { id: 'view', label: 'Cycle view (split / editor / preview)', run: () => this.cycleView() },
      { id: 'ln', label: 'Toggle line numbers', run: () => { applySettings({ lineNumbers: !settings().lineNumbers }); this.editor?.toggleLineNumbers(settings().lineNumbers); } },
      { id: 'font', label: 'Toggle reading font (serif / sans)', run: () => applySettings({ font: settings().font === 'serif' ? 'sans' : 'serif' }) },
      { id: 'bigger', label: 'Increase font size', run: () => applySettings({ fontSize: Math.min(24, settings().fontSize + 1) }) },
      { id: 'smaller', label: 'Decrease font size', run: () => applySettings({ fontSize: Math.max(13, settings().fontSize - 1) }) },
      { id: 'wider', label: 'Wider text column', run: () => applySettings({ measure: Math.min(70, settings().measure + 3) }) },
      { id: 'narrower', label: 'Narrower text column', run: () => applySettings({ measure: Math.max(32, settings().measure - 3) }) },
      { id: 'export-md', label: 'Export note as Markdown', run: () => this.current && exportMarkdown(this.current) },
      { id: 'export-pdf', label: 'Print / Save note as PDF', run: () => printNote() },
      { id: 'export-zip', label: 'Export whole workspace (.zip)', run: () => exportWorkspaceZip() },
      { id: 'import', label: 'Import markdown / zip', run: () => pickAndImport() },
      { id: 'publish', label: 'Publish / unpublish current note', run: () => this.current && this.onPublishToggle(!this.current.published) },
      { id: 'delete', label: 'Delete current note', run: () => this.deleteCurrent() },
    ];
    openPalette(cmds, (id) => this.openNote(id));
  }

  private async deleteCurrent() {
    if (!this.current) return;
    if (await confirmModal('Delete note', `Delete "${this.current.title}"? This also removes it from Drive on next sync.`, 'Delete')) {
      const id = this.current.id;
      await trashNote(id);
      this.current = null;
      const next = (await tree()).notes[0];
      await this.openNote(next?.id ?? '');
    }
  }
}

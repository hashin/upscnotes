import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.5em', fontWeight: '700', color: 'var(--accent)' },
  { tag: t.heading2, fontSize: '1.3em', fontWeight: '700', color: 'var(--accent)' },
  { tag: t.heading3, fontSize: '1.13em', fontWeight: '600', color: 'var(--accent)' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '600', color: 'var(--accent)' },
  { tag: t.strong, fontWeight: '700', color: 'var(--fg)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--link)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [t.monospace], fontFamily: 'var(--mono)', color: 'var(--code-fg)' },
  { tag: t.list, color: 'var(--accent)' },
  { tag: t.contentSeparator, color: 'var(--muted)' },
  { tag: t.processingInstruction, color: 'var(--muted)' },
]);

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-size, 16px)', color: 'var(--fg)', backgroundColor: 'transparent' },
  '.cm-scroller': {
    fontFamily: 'var(--reading-font, "Newsreader", Georgia, serif)',
    lineHeight: '1.7',
    padding: '1.5rem clamp(1rem, 4vw, 3rem) 40vh',
  },
  '.cm-content': { maxWidth: 'var(--measure, 46rem)', margin: '0 auto', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--faint)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
});

export interface EditorHooks {
  onChange: (doc: string) => void;
  onScroll: (fraction: number) => void;
  onCursorLine: (line: number) => void;
}

export class Editor {
  view: EditorView;
  private themeC = new Compartment();
  private lineNoC = new Compartment();
  private hooks: EditorHooks;

  constructor(parent: HTMLElement, doc: string, hooks: EditorHooks, opts: { lineNumbers: boolean }) {
    this.hooks = hooks;
    const extensions: Extension[] = [
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      this.lineNoC.of(opts.lineNumbers ? lineNumbers() : []),
      markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
      syntaxHighlighting(mdHighlight),
      EditorView.lineWrapping,
      placeholder('Start writing… ⌘/Ctrl-K for commands'),
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      this.themeC.of(baseTheme),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) this.hooks.onChange(u.state.doc.toString());
        if (u.selectionSet || u.docChanged) {
          const line = u.state.doc.lineAt(u.state.selection.main.head).number;
          this.hooks.onCursorLine(line);
        }
      }),
      EditorView.domEventHandlers({
        scroll: (_e, view) => {
          const s = view.scrollDOM;
          const denom = s.scrollHeight - s.clientHeight;
          if (denom > 0) this.hooks.onScroll(s.scrollTop / denom);
        },
      }),
    ];
    this.view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
  }

  get doc(): string {
    return this.view.state.doc.toString();
  }

  setDoc(doc: string) {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: doc },
      selection: { anchor: 0 },
    });
  }

  setTheme(ext: Extension) {
    this.view.dispatch({ effects: this.themeC.reconfigure([baseTheme, ext]) });
  }

  toggleLineNumbers(on: boolean) {
    this.view.dispatch({ effects: this.lineNoC.reconfigure(on ? lineNumbers() : []) });
  }

  focus() {
    this.view.focus();
  }

  scrollToFraction(fraction: number) {
    const s = this.view.scrollDOM;
    s.scrollTop = fraction * (s.scrollHeight - s.clientHeight);
  }

  scrollToLine(line: number) {
    const info = this.view.state.doc;
    if (line < 1 || line > info.lines) return;
    const pos = info.line(line).from;
    this.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 40 }) });
  }

  destroy() {
    this.view.destroy();
  }

  /* ---------- formatting actions used by the toolbar ---------- */

  private replaceSelection(fn: (sel: string) => { text: string; select?: [number, number] }) {
    const { from, to } = this.view.state.selection.main;
    const sel = this.view.state.sliceDoc(from, to);
    const { text, select } = fn(sel);
    const anchor = select ? from + select[0] : from + text.length;
    const head = select ? from + select[1] : anchor;
    this.view.dispatch({ changes: { from, to, insert: text }, selection: { anchor, head } });
    this.view.focus();
  }

  wrap(marker: string, placeholderText = 'text') {
    this.replaceSelection((sel) => {
      if (sel.startsWith(marker) && sel.endsWith(marker) && sel.length >= marker.length * 2)
        return { text: sel.slice(marker.length, -marker.length) };
      const body = sel || placeholderText;
      return { text: `${marker}${body}${marker}`, select: [marker.length, marker.length + body.length] };
    });
  }

  prefixLines(prefix: string) {
    const { from, to } = this.view.state.selection.main;
    const startLine = this.view.state.doc.lineAt(from);
    const endLine = this.view.state.doc.lineAt(to);
    const changes = [];
    for (let n = startLine.number; n <= endLine.number; n++) {
      const line = this.view.state.doc.line(n);
      changes.push({ from: line.from, insert: line.text.startsWith(prefix) ? '' : prefix });
    }
    this.view.dispatch({ changes });
    this.view.focus();
  }

  heading(level: number) {
    const line = this.view.state.doc.lineAt(this.view.state.selection.main.head);
    const stripped = line.text.replace(/^#{1,6}\s+/, '');
    const prefix = '#'.repeat(level) + ' ';
    this.view.dispatch({
      changes: { from: line.from, to: line.to, insert: prefix + stripped },
    });
    this.view.focus();
  }

  insert(text: string, cursorOffset?: number) {
    const { from, to } = this.view.state.selection.main;
    const anchor = from + (cursorOffset ?? text.length);
    this.view.dispatch({ changes: { from, to, insert: text }, selection: { anchor } });
    this.view.focus();
  }

  link() {
    this.replaceSelection((sel) => {
      const label = sel || 'link text';
      return { text: `[${label}](url)`, select: [label.length + 3, label.length + 6] };
    });
  }

  table() {
    this.insert(
      '\n| Column | Column |\n|---|---|\n| Cell | Cell |\n| Cell | Cell |\n\n',
    );
  }
}

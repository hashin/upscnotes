import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import deflist from 'markdown-it-deflist';
import taskLists from 'markdown-it-task-lists';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import { slugify } from '../util/misc';

/* ---------- inline + block math ($ … $, $$ … $$) ---------- */

function mathPlugin(md: MarkdownIt) {
  md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    const start = state.pos;
    if (state.src[start] !== '$') return false;
    if (state.src[start - 1] === '\\') return false;

    // $$ ... $$  (display math, possibly mid-line)
    if (state.src.startsWith('$$', start)) {
      const end = state.src.indexOf('$$', start + 2);
      if (end === -1) return false;
      const content = state.src.slice(start + 2, end).trim();
      if (!content) return false;
      if (!silent) state.push('math_block', 'math', 0).content = content;
      state.pos = end + 2;
      return true;
    }

    // $ ... $  (inline math)
    const end = state.src.indexOf('$', start + 1);
    if (end === -1 || end === start + 1) return false;
    const content = state.src.slice(start + 1, end);
    if (/^\s|\s$/.test(content) || /^\d/.test(state.src.slice(end + 1))) return false;
    if (!silent) state.push('math_inline', 'math', 0).content = content;
    state.pos = end + 1;
    return true;
  });

  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    const startPos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (startPos + 2 > max || state.src.slice(startPos, startPos + 2) !== '$$') return false;
    let nextLine = startLine;
    let found = false;
    let content = '';
    const firstRest = state.src.slice(startPos + 2, max).trim();
    if (firstRest.endsWith('$$') && firstRest.length > 2) {
      content = firstRest.slice(0, -2);
      found = true;
    } else {
      content = firstRest ? firstRest + '\n' : '';
      while (!found) {
        nextLine++;
        if (nextLine >= endLine) break;
        const from = state.bMarks[nextLine] + state.tShift[nextLine];
        const to = state.eMarks[nextLine];
        const line = state.src.slice(from, to);
        if (line.trim().endsWith('$$')) {
          content += line.slice(0, line.lastIndexOf('$$'));
          found = true;
        } else {
          content += line + '\n';
        }
      }
    }
    if (!found) return false;
    if (silent) return true;
    state.line = nextLine + 1;
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.content = content.trim();
    token.map = [startLine, state.line];
    return true;
  });

  const renderMath = (content: string, display: boolean) => {
    try {
      return katex.renderToString(content, { displayMode: display, throwOnError: false, output: 'html' });
    } catch {
      return `<code class="math-error">${md.utils.escapeHtml(content)}</code>`;
    }
  };
  md.renderer.rules.math_inline = (t, i) => renderMath(t[i].content, false);
  md.renderer.rules.math_block = (t, i) => `<span class="math-block">${renderMath(t[i].content, true)}</span>`;
}

/* ---------- source-line mapping for scroll sync ---------- */

function sourceLinePlugin(md: MarkdownIt) {
  const inject = (tokens: any[], idx: number, options: any, _env: any, self: any) => {
    const token = tokens[idx];
    if (token.map && token.level === 0) token.attrSet('data-source-line', String(token.map[0]));
    return self.renderToken(tokens, idx, options);
  };
  for (const rule of ['paragraph_open', 'heading_open', 'blockquote_open', 'list_item_open', 'table_open', 'hr'])
    md.renderer.rules[rule] = inject;
}

/* ---------- build ---------- */

export const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: true,
  highlight(code, lang) {
    if (lang === 'mermaid') return `<pre class="mermaid">${md.utils.escapeHtml(code)}</pre>`;
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang }).value}</code></pre>`;
      } catch { /* fall through */ }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`;
  },
})
  .use(footnote)
  .use(deflist)
  .use(taskLists, { label: true })
  .use(anchor, { slugify, permalink: anchor.permalink.headerLink({ safariReaderFix: true }) })
  .use(mathPlugin)
  .use(sourceLinePlugin);

// Open external links in a new tab.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href') ?? '';
  if (/^https?:\/\//.test(href)) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener nofollow');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function render(markdown: string): string {
  return md.render(markdown);
}

/** Extract a heading tree for the outline panel. */
export interface Heading {
  level: number;
  text: string;
  slug: string;
  line: number;
}
export function outline(markdown: string): Heading[] {
  const tokens = md.parse(markdown, {});
  const out: Heading[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'heading_open') {
      const inline = tokens[i + 1];
      const text = inline?.content ?? '';
      out.push({ level: Number(t.tag.slice(1)), text, slug: slugify(text), line: t.map?.[0] ?? 0 });
    }
  }
  return out;
}

let mermaidReady = false;
export async function renderMermaid(container: HTMLElement, dark: boolean): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>('pre.mermaid');
  if (!blocks.length) return;
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? 'dark' : 'neutral',
    securityLevel: 'strict',
    fontFamily: 'inherit',
  });
  mermaidReady = true;
  let n = 0;
  for (const block of blocks) {
    if (block.dataset.processed) continue;
    const code = block.textContent ?? '';
    try {
      const { svg } = await mermaid.render(`mmd-${Date.now()}-${n++}`, code);
      block.innerHTML = svg;
      block.dataset.processed = '1';
    } catch (e) {
      block.innerHTML = `<code class="math-error">Mermaid error: ${(e as Error).message}</code>`;
      block.dataset.processed = '1';
    }
  }
}
export const isMermaidReady = () => mermaidReady;

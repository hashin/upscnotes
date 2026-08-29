import { render, renderMermaid } from './markdown';
import { settings } from '../ui/settings';
import { debounce } from '../util/misc';

export class Preview {
  el: HTMLElement;
  private scroller: HTMLElement;
  private lineEls: { line: number; el: HTMLElement }[] = [];

  title = '';

  constructor(scroller: HTMLElement) {
    this.scroller = scroller;
    this.el = document.createElement('article');
    this.el.className = 'preview-body markdown';
    scroller.append(this.el);
  }

  private renderRaw(md: string) {
    const heading = this.title.trim() && this.title !== 'Untitled'
      ? `<h1 class="doc-title">${this.title.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))}</h1>`
      : '';
    this.el.innerHTML = heading + render(md);
    this.lineEls = [...this.el.querySelectorAll<HTMLElement>('[data-source-line]')].map((el) => ({
      line: Number(el.dataset.sourceLine),
      el,
    }));
    void renderMermaid(this.el, settings().theme === 'dark');
    this.el.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((c) => (c.disabled = true));
  }

  update = debounce((md: string) => this.renderRaw(md), 120);
  updateNow(md: string) {
    this.renderRaw(md);
  }

  /** Scroll preview so the given editor source line sits near the top. */
  syncToLine(line: number) {
    if (!this.lineEls.length) return;
    let target = this.lineEls[0];
    for (const entry of this.lineEls) {
      if (entry.line <= line) target = entry;
      else break;
    }
    const top = target.el.offsetTop - 12;
    this.scroller.scrollTo({ top, behavior: 'auto' });
  }

  syncToFraction(fraction: number) {
    const denom = this.scroller.scrollHeight - this.scroller.clientHeight;
    this.scroller.scrollTop = fraction * denom;
  }

  scrollToSlug(slug: string) {
    const target = this.el.querySelector<HTMLElement>(`#${CSS.escape(slug)}`);
    if (target) this.scroller.scrollTo({ top: target.offsetTop - 12, behavior: 'smooth' });
  }
}

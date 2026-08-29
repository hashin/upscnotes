export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | undefined;
  return ((...args: any[]) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}

export function throttle<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let last = 0;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  return ((...args: any[]) => {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else if (!scheduled) {
      scheduled = setTimeout(() => {
        last = Date.now();
        scheduled = undefined;
        fn(...args);
      }, remaining);
    }
  }) as T;
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function countWords(md: string): number {
  const text = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[#>*_~\-\|\[\]\(\)!]/g, ' ');
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

/** Small typed pub/sub bus for cross-component updates. */
type Handler = (...args: any[]) => void;
const listeners = new Map<string, Set<Handler>>();
export const bus = {
  on(evt: string, fn: Handler) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt)!.add(fn);
    return () => listeners.get(evt)!.delete(fn);
  },
  emit(evt: string, ...args: any[]) {
    listeners.get(evt)?.forEach((fn) => {
      try {
        fn(...args);
      } catch (e) {
        console.error(`[bus:${evt}]`, e);
      }
    });
  },
};

export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info') {
  bus.emit('toast', { message, kind });
}

type Attr = string | boolean | number | ((e: any) => void) | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, Attr> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) el.append(c);
  return el;
}

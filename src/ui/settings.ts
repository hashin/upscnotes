import { bus } from '../util/misc';

export type ThemeName = 'light' | 'sepia' | 'dark';
export type ViewMode = 'split' | 'editor' | 'preview';
export type ReadingFont = 'serif' | 'sans';

export interface Settings {
  theme: ThemeName;
  view: ViewMode;
  font: ReadingFont;
  fontSize: number; // px, editor + preview base
  measure: number; // rem, max line width
  lineNumbers: boolean;
  spellcheck: boolean;
}

const DEFAULTS: Settings = {
  theme: 'sepia',
  view: 'split',
  font: 'serif',
  fontSize: 17,
  measure: 46,
  lineNumbers: false,
  spellcheck: true,
};

const KEY = 'upscnotes:settings';

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

let current = loadSettings();
export const settings = () => current;

export function applySettings(next: Partial<Settings>): void {
  current = { ...current, ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch { /* private mode */ }
  reflect();
  bus.emit('settings-changed', current);
}

export function reflect(): void {
  const root = document.documentElement;
  root.dataset.theme = current.theme;
  root.dataset.view = current.view;
  root.style.setProperty('--editor-size', current.fontSize + 'px');
  root.style.setProperty('--reading-size', current.fontSize + 'px');
  root.style.setProperty('--measure', current.measure + 'rem');
  root.style.setProperty(
    '--reading-font',
    current.font === 'serif'
      ? '"Newsreader", Georgia, "Times New Roman", serif'
      : '"Inter", system-ui, -apple-system, sans-serif',
  );
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', current.theme === 'dark' ? '#12100e' : '#0b3d2e');
}

export function cycleTheme(): void {
  const order: ThemeName[] = ['light', 'sepia', 'dark'];
  applySettings({ theme: order[(order.indexOf(current.theme) + 1) % order.length] });
}

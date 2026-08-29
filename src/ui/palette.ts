import { h } from '../util/misc';
import { queryNotes } from '../store/workspace';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function openPalette(commands: Command[], onOpenNote: (id: string) => void): void {
  const input = h('input', {
    class: 'palette-input',
    placeholder: 'Type a command, or search notes…',
    autocapitalize: 'none',
    spellcheck: 'false',
  }) as HTMLInputElement;
  const list = h('ul', { class: 'palette-list', role: 'listbox' });
  const card = h('div', { class: 'palette-card' }, [input, list]);
  const overlay = h('div', { class: 'palette-overlay', onclick: (e) => e.target === overlay && close() }, [card]);
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('in'));

  let items: { label: string; hint?: string; act: () => void }[] = [];
  let active = 0;

  function refresh() {
    const q = input.value.trim().toLowerCase();
    const cmds = commands
      .filter((c) => !q || c.label.toLowerCase().includes(q))
      .map((c) => ({ label: c.label, hint: c.hint, act: () => { close(); c.run(); } }));
    const notes = (q ? queryNotes(q) : []).map((n) => ({
      label: n.title,
      hint: 'note',
      act: () => { close(); onOpenNote(n.id); },
    }));
    items = [...cmds, ...notes].slice(0, 40);
    active = 0;
    paint();
  }

  function paint() {
    list.innerHTML = '';
    items.forEach((it, i) => {
      const li = h(
        'li',
        {
          class: 'palette-item' + (i === active ? ' active' : ''),
          role: 'option',
          onclick: () => it.act(),
          onmouseenter: () => { active = i; paint(); },
        },
        [h('span', {}, [it.label]), it.hint ? h('span', { class: 'palette-hint' }, [it.hint]) : document.createComment('')],
      );
      list.append(li);
    });
  }

  function close() {
    overlay.classList.remove('in');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', onKey, true);
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); paint(); scroll(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); scroll(); }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.act(); }
  };
  const scroll = () => list.children[active]?.scrollIntoView({ block: 'nearest' });

  input.addEventListener('input', refresh);
  document.addEventListener('keydown', onKey, true);
  refresh();
  input.focus();
}

import { SECTIONS } from '../upsc/syllabus';
import { h } from '../util/misc';
import { modal } from './modal';

export function openSyllabusPicker(selected: string[], onSave: (codes: string[]) => void): void {
  const chosen = new Set(selected);
  const body = h('div', { class: 'syllabus-picker' });

  for (const section of SECTIONS) {
    const group = h('details', { class: 'syl-group' });
    const summary = h('summary', {}, [section.label]);
    group.append(summary);
    for (const child of [{ code: section.code, label: `${section.label} (whole paper)` }, ...(section.children ?? [])]) {
      const id = 'syl-' + child.code.replace(/\W/g, '-');
      const cb = h('input', { type: 'checkbox', id }) as HTMLInputElement;
      cb.checked = chosen.has(child.code);
      cb.addEventListener('change', () => (cb.checked ? chosen.add(child.code) : chosen.delete(child.code)));
      group.append(h('label', { class: 'syl-item', for: id }, [cb, h('span', {}, [child.label])]));
    }
    if ((section.children ?? []).some((c) => chosen.has(c.code)) || chosen.has(section.code)) group.setAttribute('open', '');
    body.append(group);
  }

  const close = modal('Link to syllabus', body, [
    h('button', { class: 'btn', onclick: () => close() }, ['Cancel']),
    h('button', {
      class: 'btn btn-primary',
      onclick: () => {
        onSave([...chosen]);
        close();
      },
    }, ['Save tags']),
  ]);
}

import { bus, h } from '../util/misc';

export function mountToasts(): void {
  const host = h('div', { class: 'toast-host', 'aria-live': 'polite' });
  document.body.append(host);
  bus.on('toast', ({ message, kind }: { message: string; kind: string }) => {
    const el = h('div', { class: `toast toast-${kind}`, role: 'status' }, [message]);
    host.append(el);
    requestAnimationFrame(() => el.classList.add('in'));
    const life = kind === 'error' ? 6500 : 3800;
    setTimeout(() => {
      el.classList.remove('in');
      setTimeout(() => el.remove(), 300);
    }, life);
    el.addEventListener('click', () => el.remove());
  });
}

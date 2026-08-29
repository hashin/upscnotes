import { h } from '../util/misc';

export function modal(title: string, body: HTMLElement, actions: HTMLElement[] = []): () => void {
  const close = () => {
    overlay.classList.remove('in');
    setTimeout(() => overlay.remove(), 200);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const card = h('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
    h('header', { class: 'modal-head' }, [
      h('h2', {}, [title]),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, ['✕']),
    ]),
    h('div', { class: 'modal-body' }, [body]),
    actions.length ? h('footer', { class: 'modal-foot' }, actions) : document.createComment(''),
  ]);
  const overlay = h('div', { class: 'modal-overlay', onclick: (e) => e.target === overlay && close() }, [card]);
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('in'));
  document.addEventListener('keydown', onKey);
  const focusable = card.querySelector<HTMLElement>('input, button, textarea, select');
  focusable?.focus();
  return close;
}

export function confirmModal(title: string, message: string, confirmLabel = 'Confirm'): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    const close = modal(
      title,
      h('p', { class: 'modal-message' }, [message]),
      [
        h('button', { class: 'btn', onclick: () => finish(false) }, ['Cancel']),
        h('button', { class: 'btn btn-danger', onclick: () => finish(true) }, [confirmLabel]),
      ],
    );
  });
}

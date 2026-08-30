import { config } from '../config';
import { render, renderMermaid } from '../render/markdown';
import { parseMarkdownFile } from '../sync/frontmatter';
import { registryUrl, type RegistryRecord } from '../publish/registry';
import type { PublicProfile } from '../publish/publish';
import { syllabusLabel } from '../upsc/syllabus';
import { h, relativeTime } from '../util/misc';
import { cycleTheme, settings, applySettings } from '../ui/settings';

const cache = new Map<string, PublicProfile>();

export async function renderPublicProfile(root: HTMLElement, username: string, slug?: string): Promise<void> {
  root.className = 'public';
  root.removeAttribute('aria-busy');
  root.innerHTML = '';
  root.append(shell(loading()));

  let profile = cache.get(username);
  try {
    if (!profile) {
      const rec: RegistryRecord = await fetchJson(registryUrl(username));
      // Always fetch a fresh profile.json (it's tiny) so newly published notes show up.
      const sep = rec.profileUrl.includes('?') ? '&' : '?';
      profile = await fetchJson<PublicProfile>(rec.profileUrl + sep + '_=' + Date.now());
      cache.set(username, profile);
    }
  } catch (e) {
    root.innerHTML = '';
    root.append(shell(notFound(username, (e as Error).message)));
    document.title = `@${username} — not found · UPSC Notes`;
    return;
  }

  if (slug) {
    const meta = profile.notes.find((n) => n.slug === slug);
    if (!meta) {
      root.innerHTML = '';
      root.append(shell(notFound(`${username}/${slug}`, 'That note is not published.')));
      return;
    }
    await renderSingleNote(root, profile, meta);
  } else {
    renderIndex(root, profile);
  }
}

/* ---------- pieces ---------- */

async function fetchJson<T = any>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function readingControls(): HTMLElement {
  return h('div', { class: 'reading-controls' }, [
    h('button', { class: 'btn btn-sm', title: 'Theme', onclick: () => cycleTheme() }, ['◑']),
    h('button', { class: 'btn btn-sm', onclick: () => applySettings({ fontSize: Math.max(14, settings().fontSize - 1) }) }, ['A−']),
    h('button', { class: 'btn btn-sm', onclick: () => applySettings({ fontSize: Math.min(24, settings().fontSize + 1) }) }, ['A+']),
  ]);
}

function shell(inner: Node): HTMLElement {
  return h('div', { class: 'public-shell' }, [
    h('header', { class: 'public-top' }, [
      h('a', { href: '/', class: 'brand-mark' }, ['UPSC Notes']),
      h('div', { class: 'public-top-actions' }, [
        readingControls(),
        h('a', { href: '/', class: 'btn btn-sm btn-primary' }, ['Make your own']),
      ]),
    ]),
    inner,
    h('footer', { class: 'public-foot muted' }, [
      'Published with ',
      h('a', { href: config.SITE_URL }, ['UPSC Notes']),
      ' · free & offline-first',
    ]),
  ]);
}

function loading(): HTMLElement {
  return h('div', { class: 'public-loading' }, ['Loading…']);
}

function notFound(what: string, detail: string): HTMLElement {
  return h('div', { class: 'public-empty' }, [
    h('h1', {}, ['Nothing here yet']),
    h('p', {}, [`We couldn't find published notes for ${what}.`]),
    h('p', { class: 'muted' }, [detail]),
    h('a', { href: '/', class: 'btn btn-primary' }, ['Start your own notes']),
  ]);
}

function renderIndex(root: HTMLElement, profile: PublicProfile) {
  const name = profile.displayName || '@' + profile.username;
  document.title = `${name} · UPSC Notes`;
  setMeta('description', profile.bio || `${name}'s UPSC preparation notes.`);

  const groups = new Map<string, typeof profile.notes>();
  for (const n of profile.notes) {
    const key = n.syllabus[0]?.split('/')[0] ?? 'Notes';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }

  const body = h('main', { class: 'profile' }, [
    h('div', { class: 'profile-head' }, [
      profile.avatar ? h('img', { src: profile.avatar, alt: '', class: 'avatar-lg', referrerpolicy: 'no-referrer' }) : document.createComment(''),
      h('div', {}, [
        h('h1', {}, [name]),
        profile.bio ? h('p', { class: 'profile-bio' }, [profile.bio]) : document.createComment(''),
        h('p', { class: 'muted' }, [`${profile.notes.length} public note${profile.notes.length === 1 ? '' : 's'} · @${profile.username}`]),
      ]),
    ]),
  ]);

  if (!profile.notes.length) {
    body.append(h('p', { class: 'muted' }, ['No published notes yet.']));
  }

  for (const [section, notes] of groups) {
    const list = h('ul', { class: 'note-index' });
    for (const n of notes.sort((a, b) => b.updatedAt - a.updatedAt)) {
      list.append(
        h('li', {}, [
          h('a', { href: `/${profile.username}/${n.slug}`, class: 'note-index-link', onclick: navHandler(`/${profile.username}/${n.slug}`) }, [
            h('span', { class: 'note-index-title' }, [n.title]),
            h('span', { class: 'note-index-meta muted' }, [`${n.words} words · ${relativeTime(n.updatedAt)}`]),
          ]),
          n.tags.length ? h('div', { class: 'note-index-tags' }, n.tags.map((t) => h('span', { class: 'tag' }, ['#' + t]))) : document.createComment(''),
        ]),
      );
    }
    body.append(h('section', {}, [h('h2', { class: 'section-h' }, [section]), list]));
  }

  root.innerHTML = '';
  root.append(shell(body));
}

async function renderSingleNote(root: HTMLElement, profile: PublicProfile, meta: PublicProfile['notes'][number]) {
  const name = profile.displayName || '@' + profile.username;
  document.title = `${meta.title} — ${name} · UPSC Notes`;
  setMeta('description', `${meta.title} — UPSC notes by ${name}.`);

  const article = h('article', { class: 'markdown reading' });
  const body = h('main', { class: 'note-view' }, [
    h('nav', { class: 'crumb' }, [
      h('a', { href: `/${profile.username}`, onclick: navHandler(`/${profile.username}`) }, [name]),
      h('span', { class: 'muted' }, [' / ']),
      h('span', {}, [meta.title]),
    ]),
    article,
    h('div', { class: 'note-view-meta muted' }, [
      meta.syllabus.map((c) => h('span', { class: 'tag', title: syllabusLabel(c) }, [c])),
      h('span', {}, [` Updated ${relativeTime(meta.updatedAt)}`]),
    ].flat() as Node[]),
  ]);

  root.innerHTML = '';
  root.append(shell(body));

  try {
    const bust = (meta.url.includes('?') ? '&' : '?') + '_=' + Date.now();
    const raw = await (await fetch(meta.url + bust, { credentials: 'omit', cache: 'no-store' })).text();
    const { body: md } = parseMarkdownFile(raw);
    const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
    article.innerHTML = `<h1 class="doc-title">${esc(meta.title)}</h1>` + render(md);
    article.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((c) => (c.disabled = true));
    void renderMermaid(article, settings().theme === 'dark');
    injectJsonLd(meta.title, name, meta.updatedAt);
  } catch (e) {
    article.append(h('p', { class: 'public-empty' }, ['Could not load this note. ' + (e as Error).message]));
  }
}

function navHandler(path: string) {
  return (e: Event) => {
    e.preventDefault();
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
}

function setMeta(name: string, content: string) {
  let el = document.querySelector(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute('name', name);
    document.head.append(el);
  }
  el.setAttribute('content', content);
}

function injectJsonLd(title: string, author: string, updated: number) {
  document.getElementById('ld-json')?.remove();
  const s = document.createElement('script');
  s.type = 'application/ld+json';
  s.id = 'ld-json';
  s.textContent = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    author: { '@type': 'Person', name: author },
    dateModified: new Date(updated).toISOString(),
    isAccessibleForFree: true,
  });
  document.head.append(s);
}

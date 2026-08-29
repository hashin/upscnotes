import './styles.css';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';

import { reflect } from './ui/settings';
import { mountToasts } from './ui/toast';
import { bus } from './util/misc';
import { initAuth } from './auth/google';
import { bootstrapWorkspace, rebuildSearch } from './store/workspace';
import { startAutoSync } from './sync/sync';
import { watchPublishing } from './publish/publish';

const RESERVED_FIRST_SEGMENT = new Set([
  'about', 'api', 'assets', 'icons', 'favicon.svg', 'robots.txt', 'sitemap.xml', 'manifest.webmanifest',
  'sw.js', 'registrations', 'index.html', 'og.png',
]);

const app = document.getElementById('app')!;

async function boot() {
  reflect();
  mountToasts();
  await bootstrapWorkspace();
  await rebuildSearch();
  watchPublishing();
  initAuth().then(() => startAutoSync());

  window.addEventListener('popstate', route);
  bus.on('navigate', (path: string) => {
    history.pushState({}, '', path);
    route();
  });
  await route();
}

let workspaceMounted = false;

async function route() {
  const path = decodeURIComponent(location.pathname).replace(/\/+$/, '') || '/';
  const segments = path.split('/').filter(Boolean);

  if (segments.length === 0) {
    await mountWorkspace();
    return;
  }
  if (segments[0] === 'about') {
    renderAbout();
    return;
  }
  if (!RESERVED_FIRST_SEGMENT.has(segments[0])) {
    const [username, slug] = segments;
    const { renderPublicProfile } = await import('./views/publicProfile');
    await renderPublicProfile(app, username.toLowerCase(), slug);
    return;
  }
  // Unknown reserved path -> workspace.
  await mountWorkspace();
}

async function mountWorkspace() {
  const { WorkspaceView } = await import('./views/app');
  if (!workspaceMounted || !app.querySelector('.workspace')) {
    const view = new WorkspaceView(app);
    await view.mount();
    workspaceMounted = true;
  }
}

function renderAbout() {
  app.className = 'public';
  app.removeAttribute('aria-busy');
  app.innerHTML = `
  <div class="public-shell">
    <header class="public-top">
      <a href="/" class="brand-mark">UPSC Notes</a>
      <a href="/" class="btn btn-sm btn-primary">Open the app</a>
    </header>
    <main class="about">
      <h1>Notes that stay yours</h1>
      <p class="lede">A free, offline-first markdown notebook for the UPSC Civil Services
      preparation — General Studies I–IV, Essay, current affairs and your optional.</p>
      <ul class="about-points">
        <li><strong>Works offline.</strong> Everything runs in your browser. Your notes are saved locally the instant you type.</li>
        <li><strong>Backed up to <em>your</em> Google Drive.</strong> A plain folder of <code>.md</code> files you fully own and can open anywhere.</li>
        <li><strong>Readable by design.</strong> Clean typography, three reading themes, math, tables and diagrams.</li>
        <li><strong>Share when you want.</strong> Publish selected notes at <code>upscnotes.hashin.me/your-name</code>.</li>
        <li><strong>Free forever.</strong> No servers storing your notes, no subscription.</li>
      </ul>
      <a href="/" class="btn btn-primary btn-lg">Start writing</a>
      <p class="muted" style="margin-top:2rem">Open source. Your data lives only in this browser and your Drive.</p>
    </main>
    <footer class="public-foot muted">UPSC Notes · free &amp; offline-first</footer>
  </div>`;
  document.title = 'About · UPSC Notes';
}

boot().catch((e) => {
  console.error(e);
  app.innerHTML = `<div style="padding:2rem;font-family:system-ui"><h2>Something broke on load</h2><pre>${String(e)}</pre></div>`;
});

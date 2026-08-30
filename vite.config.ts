import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: [
            '@codemirror/state',
            '@codemirror/view',
            '@codemirror/commands',
            '@codemirror/language',
            '@codemirror/lang-markdown',
            '@codemirror/language-data',
            '@codemirror/search',
          ],
          markdown: [
            'markdown-it',
            'markdown-it-anchor',
            'markdown-it-deflist',
            'markdown-it-footnote',
            'markdown-it-task-lists',
          ],
          katex: ['katex'],
          mermaid: ['mermaid'],
          hljs: ['highlight.js'],
        },
      },
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'robots.txt', 'icons/*.png'],
      manifest: {
        name: 'UPSC Notes',
        short_name: 'UPSC Notes',
        description: 'Offline-first markdown notes for UPSC preparation, synced to your Google Drive.',
        theme_color: '#0b3d2e',
        background_color: '#faf8f4',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The new SW takes over immediately and the whole precache swaps atomically, so a
        // build's index.html and EVERY chunk it can import move together — no "Failed to
        // fetch dynamically imported module" after a deploy. Precaching everything also
        // means the app is genuinely 100% offline. Repeat-deploy cost is only the changed
        // (small) app chunks — workbox revalidates by content hash.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{css,html,svg,png,woff2,js}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: '/index.html',
        // Public profile pages (/username) are SPA routes — let the shell handle them.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\//,
            handler: 'CacheFirst',
            options: { cacheName: 'google-fonts', expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 } },
          },
          {
            urlPattern: /googleusercontent\.com\/.*/,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'drive-content', expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 } },
          },
        ],
      },
    }),
  ],
});

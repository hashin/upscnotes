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
        // Precache the shell + editor only. Heavy on-demand chunks (mermaid, katex,
        // highlight.js, jszip, cytoscape) are runtime-cached the first time they load.
        globPatterns: ['**/*.{css,html,svg,png,woff2}', 'assets/index-*.js', 'assets/codemirror-*.js', 'assets/markdown-*.js'],
        globIgnores: ['**/mermaid-*.js', '**/katex-*.js', '**/hljs-*.js', '**/*Diagram-*.js', '**/cytoscape*.js', '**/cynefin*.js', '**/sql-*.js'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/index.html',
        // Public profile pages (/username) are SPA routes — let the shell handle them.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /\/assets\/.*\.(js|css)$/,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'app-chunks', expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 * 60 } },
          },
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

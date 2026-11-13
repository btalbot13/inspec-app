import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// App icons sit at the top level of the repo (next to index.html). Copy them into the build
// under fixed names so the web app manifest, iOS and the service worker can always find them.
// Also accepts a public/ folder, in case the files are ever moved there.
const ICONS = ['icon.svg', 'icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png'];
const copyIcons = {
  name: 'inspec-copy-icons',
  apply: 'build',
  generateBundle() {
    for (const name of ICONS) {
      const file = [resolve(root, name), resolve(root, 'public', name)].find((p) => existsSync(p));
      if (file) this.emitFile({ type: 'asset', fileName: name, source: readFileSync(file) });
      else this.warn(`Icon not found: ${name}`);
    }
  },
};

// Everything (React, Recharts, Dexie, lucide icons, compiled Tailwind CSS, icons) is bundled into
// local files and precached by the service worker, so after the first visit the app cold-boots
// with zero network. The app uses the system font stack, so there are no web fonts to fetch.
export default defineConfig({
  publicDir: false, // no public/ folder: icons are copied by the plugin above
  build: {
    chunkSizeWarningLimit: 1200, // one ~760 kB app bundle is expected (React + Recharts + Dexie)
  },
  plugins: [
    react(),
    copyIcons,
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // registered explicitly in main.jsx via virtual:pwa-register
      manifest: {
        id: '/',
        name: 'InSpec — Asset Maintenance',
        short_name: 'InSpec',
        description: 'Offline-first field calibration and equipment tolerance drift log',
        theme_color: '#09090b',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        // Precache the entire app shell so it loads offline with zero network calls.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: {
        enabled: false, // test offline behaviour with `npm run build && npm run preview`
      },
    }),
  ],
});

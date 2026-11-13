# InSpec — Asset Maintenance

Offline-first field calibration and equipment tolerance drift log, packaged as an installable
Progressive Web App (Vite + React 18 + Tailwind CSS v3 + vite-plugin-pwa).

Everything the app needs (React, Recharts, Dexie, the lucide icons, the compiled Tailwind CSS and the
app icons) is bundled into local files and precached by a service worker. After the first visit, InSpec
**cold-boots with zero signal**, even after a phone restart or with the browser cache cleared. The app uses
the system font stack, so there are no web fonts to download.

## Quick start

```bash
npm install
npm run dev        # development server with hot reload (service worker off)
npm run build      # production build into dist/
npm run preview    # serve dist/ locally WITH the service worker, to test offline
```

Requires Node.js 18 or newer.

## Deploy to Vercel

**Option A: Git (recommended)**
1. Push this folder to a GitHub, GitLab or Bitbucket repository.
2. In Vercel: **Add New → Project → Import** the repository.
3. Vercel detects Vite automatically (build `npm run build`, output `dist`). Click **Deploy**.

**Option B: CLI**
```bash
npm i -g vercel
vercel          # preview deployment
vercel --prod   # production
```

`vercel.json` makes sure `sw.js` and the manifest are always re-checked, so updates reach installed
phones, while the hashed files in `/assets` are cached long-term.

## Install on a phone

- **iPhone / iPad (Safari):** open your Vercel URL → Share → **Add to Home Screen**.
- **Android (Chrome):** open your Vercel URL → ⋮ menu → **Install app**.

Open it once **with signal** so everything is cached. From then on it works fully offline.

## Test the offline cold boot

1. `npm run build && npm run preview` and open the URL in Chrome (or use your Vercel URL).
2. Wait a few seconds. DevTools → Application → Service workers should show it as *activated*.
3. DevTools → Network → **Offline**, or turn on airplane mode and fully close the app.
4. Reopen it. InSpec should boot normally, with all your data.

## Updates

`registerType: 'autoUpdate'`: when you deploy a new version, open copies download it in the background
(it also checks hourly) and switch to it automatically. Readings are saved the moment you tap
**Log Reading**, so an update never loses saved data. At most, a value you were halfway through typing
is cleared.

## Moving existing data into the installed app

Each website keeps its own storage, and on iPhone a home-screen app also has storage separate from Safari.
Data from the claude.ai preview won't appear on your Vercel site automatically. To bring it over:

1. In the old copy: **Data & Backup → Export Full Backup (.json)**.
2. In the installed app: **Data & Backup → Import Backup (.json) → Merge / Add Missing**.

Backups from before the rebrand (`"app": "SpecLog"`) import fine. In the installed iPhone app, exports open
the iOS share sheet (Save to Files, AirDrop, Mail); everywhere else they're normal downloads.

## Data safety

- Database: Dexie / IndexedDB, name **`SpecLogDB`** (unchanged from the original build), tables
  `equipment`, `inspectionPoints`, `readings`. It falls back to localStorage if IndexedDB is unavailable.
- On launch the app requests persistent storage (`navigator.storage.persist()`) so the browser doesn't
  clear it to free space.
- Data lives only on the device. **Back up regularly.** The app reminds you when it reconnects after
  being offline with unsaved changes.
- Merges are tree-aware: an asset is only treated as the same one if its tag *and* its place in the
  hierarchy match. Same-tag assets from another site are imported separately with a renamed tag
  (e.g. `BAT-01 → BAT-01-IMP`), so readings never get mixed between sites.

## Project layout

```
index.html              app shell, mobile / iOS home-screen meta tags (black-translucent status bar)
vite.config.js          React + vite-plugin-pwa: manifest, Workbox precache, auto-update
vercel.json             Vercel build settings and cache headers for the service worker
tailwind.config.js      Tailwind v3, compiled at build time (no CDN)
postcss.config.js
src/main.jsx            entry point: registers the service worker, requests persistent storage
src/App.jsx             the InSpec app
src/index.css           Tailwind directives, safe-area handling, Daylight mode overrides
public/icon.svg         app icon (also the browser favicon)
public/icon-192.png     PNG icons for Android and the manifest
public/icon-512.png
public/maskable-512.png full-bleed icon for Android adaptive shapes
public/apple-touch-icon.png  180×180 iOS home-screen icon
```

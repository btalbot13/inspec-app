import React from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.jsx';
import './index.css';

// Service worker: precaches the whole app for offline cold boots. With registerType 'autoUpdate',
// a new deploy is downloaded in the background and activated automatically.
const UPDATE_CHECK_MS = 60 * 60 * 1000; // look for a new version hourly while the app is open
registerSW({
  immediate: true,
  onRegisteredSW(swUrl, registration) {
    if (!registration) return;
    setInterval(() => {
      if (navigator.onLine) registration.update().catch(() => {});
    }, UPDATE_CHECK_MS);
  },
  onOfflineReady() {
    console.info('[InSpec] App cached: ready to work offline.');
  },
});

// Ask the browser to keep InSpec's IndexedDB data from being evicted under storage pressure
// (matters most on iOS). Installed home-screen apps are usually granted this automatically.
try {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
} catch {
  /* not supported: Data & Backup still protects the data */
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

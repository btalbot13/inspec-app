/**
 * InSpec — Asset Maintenance
 * Offline-first field calibration and equipment tolerance drift log.
 *
 * Storage: Dexie (IndexedDB) database "SpecLogDB" with tables equipment / inspectionPoints / readings,
 * falling back to localStorage if IndexedDB is unavailable. Daylight-mode styles live in src/index.css.
 */
import React, { useState, useEffect, useMemo, useCallback, useRef, useContext, createContext } from 'react';
import Dexie from 'dexie';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip,
  ReferenceArea, ReferenceLine, CartesianGrid,
} from 'recharts';
import {
  Search, Plus, ChevronLeft, ChevronRight, MapPin, Tag, AlertTriangle,
  CheckCircle2, X, Download, RotateCcw, MessageSquarePlus, Database,
  Activity, Copy, Gauge, WifiOff, Wifi, Wrench, Trash2, AlertOctagon, SlidersHorizontal, Maximize2, Pencil, Sun, Moon, Undo2, Upload, Home, Archive, ArchiveRestore, ChevronDown,
} from 'lucide-react';

/* ============================================================
   Constants, math & formatting helpers
   ============================================================ */

// Storage names keep the original SpecLog identifiers so data saved before the InSpec rebrand still loads.
const DB_NAME = 'SpecLogDB';
const FALLBACK_KEY = 'speclog-fallback-v1';
const DAY = 86400000;
const HOUR = 3600000;

const cx = (...a) => a.filter(Boolean).join(' ');

const limits = (p) => ({ min: p.targetValue - p.tolerance, max: p.targetValue + p.tolerance });
const isOutOfSpec = (p, v) => {
  const { min, max } = limits(p);
  const eps = 1e-9 * Math.max(1, Math.abs(p.targetValue)); // absorb float noise like 27.2 - 0.8 = 26.400000000000002
  return v < min - eps || v > max + eps;
};
// Optional second (outer) limit: green inside ±tolerance, yellow up to ±alarmTolerance, red beyond.
const hasAlarm = (p) => Number.isFinite(p.alarmTolerance) && p.alarmTolerance > p.tolerance;
const alarmLimits = (p) => ({ amin: p.targetValue - p.alarmTolerance, amax: p.targetValue + p.alarmTolerance });
const severityOf = (p, r) => {
  const out = typeof r.isOutOfSpec === 'boolean' ? r.isOutOfSpec : isOutOfSpec(p, r.value);
  if (!out) return 'ok';
  if (!hasAlarm(p)) return 'alarm';
  const eps = 1e-9 * Math.max(1, Math.abs(p.targetValue));
  return Math.abs(r.value - p.targetValue) <= p.alarmTolerance + eps ? 'warn' : 'alarm';
};
const SEV = {
  ok: { label: 'IN SPEC', text: 'text-emerald-400', border: 'border-zinc-700', fill: '#10b981' },
  warn: { label: 'WARNING', text: 'text-amber-400', border: 'border-amber-400/70', fill: '#f59e0b' },
  alarm: { label: 'ALARM', text: 'text-red-400', border: 'border-red-500/70', fill: '#ef4444' },
};
/* ---------- Themes: dark (default) and high-contrast daylight ---------- */
const THEME_KEY = 'speclog-theme';
const CHART_PALETTE = {
  dark: {
    line: '#e4e4e7', dotStroke: '#09090b', grid: '#27272a', tick: '#a1a1aa', tick2: '#71717a', axis: '#3f3f46',
    cursor: '#52525b', activeStroke: '#fafafa', activeFill: '#18181b', ok: '#10b981', warn: '#f59e0b', alarm: '#ef4444',
  },
  day: {
    line: '#000000', dotStroke: '#ffffff', grid: '#d4d4d8', tick: '#18181b', tick2: '#3f3f46', axis: '#18181b',
    cursor: '#71717a', activeStroke: '#000000', activeFill: '#ffffff', ok: '#047857', warn: '#b45309', alarm: '#b91c1c',
  },
};
const ThemeCtx = createContext({ name: 'dark', chart: CHART_PALETTE.dark, toggle: () => {} });
const useChart = () => useContext(ThemeCtx).chart;

// Minimal 3.5" disk mark (custom, SF Symbols-style): rounded body, cut corner, shutter and label.
function DiskIcon({ size = 24, strokeWidth = 1.75, className }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M6.75 3.25h8.69a1.5 1.5 0 0 1 1.06.44l3.81 3.81a1.5 1.5 0 0 1 .44 1.06v8.69a3.5 3.5 0 0 1-3.5 3.5H6.75a3.5 3.5 0 0 1-3.5-3.5V6.75a3.5 3.5 0 0 1 3.5-3.5z" />
      <path d="M8.25 3.25v3a1 1 0 0 0 1 1h4.5a1 1 0 0 0 1-1v-3" />
      <path d="M7.75 20.75v-5a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v5" />
    </svg>
  );
}

function HomeButton({ onHome }) {
  return (
    <button
      type="button"
      onClick={onHome}
      aria-label="Home"
      title="Home"
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-zinc-200 active:bg-zinc-700"
    >
      <Home size={22} strokeWidth={2.25} />
    </button>
  );
}

function ThemeToggle() {
  const { name, toggle } = useContext(ThemeCtx);
  const day = name === 'day';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={day ? 'Switch to dark mode' : 'Switch to daylight mode'}
      title={day ? 'Dark mode' : 'Daylight mode'}
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-zinc-200 active:bg-zinc-700"
    >
      {day ? <Moon size={22} strokeWidth={2.5} /> : <Sun size={22} strokeWidth={2.5} />}
    </button>
  );
}

const countDecimals = (n) => {
  const s = String(n);
  if (s.includes('e')) return 3;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
};
// Show a reading with at least the parameter's precision, but never hide digits the tech entered (13.12 stays 13.12).
const fmtV = (v, dp) => fmt(v, Math.max(dp, Math.min(3, countDecimals(v))));
const decimalsFor = (p) => Math.min(3, Math.max(1, countDecimals(p.targetValue), countDecimals(p.tolerance), hasAlarm(p) ? countDecimals(p.alarmTolerance) : 0));
const fmt = (n, dp = 1) => (Number.isFinite(Number(n)) ? Number(n).toFixed(dp) : '—');
const signed = (n, dp = 1) => {
  const r = Number(Math.abs(n).toFixed(dp));
  if (r === 0) return `±${(0).toFixed(dp)}`;
  return `${n > 0 ? '+' : '−'}${r.toFixed(dp)}`;
};
const parseNum = (s) => {
  const t = String(s ?? '').trim().replace(',', '.');
  if (t === '' || t === '-' || t === '.') return NaN;
  return Number(t);
};
const fmtDateTime = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const timeAgo = (iso) => {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  return `${Math.floor(diff / DAY)}d ago`;
};
const chartDomain = (values, min, max) => {
  const lo = Math.min(min, ...values);
  const hi = Math.max(max, ...values);
  const pad = (hi - lo) * 0.12 || 1;
  return [lo - pad, hi + pad];
};
const byTime = (a, b) => new Date(a.recordedAt) - new Date(b.recordedAt);

/* ============================================================
   Seed data
   ============================================================ */

const BATTERY = (n, values, notes = []) => ({
  name: `Battery ${n}`,
  location: 'MP 112.4 — Main St Crossing',
  identifier: `XH-112-BAT-0${n}`,
  points: [{
    label: 'Float Voltage', unit: 'VDC', targetValue: 13.5, tolerance: 0.3, alarmTolerance: 0.6,
    readings: values.map((v, i) => [[30, 23, 16, 2][i], v, notes[i] || '']),
  }],
});

const SEED = [
  {
    name: 'Grade Crossing House',
    location: 'MP 112.4 — Main St Crossing',
    identifier: 'XH-112',
    points: [
      {
        label: 'House Interior Temp', unit: '°F', targetValue: 72, tolerance: 18, alarmTolerance: 28,
        readings: [[30, 68.0, ''], [16, 75.5, ''], [2, 79.0, 'HVAC filter replaced']],
      },
    ],
    children: [
      {
        name: 'Battery Bank',
        location: 'MP 112.4 — Main St Crossing',
        identifier: 'XH-112-BAT',
        points: [
          {
            label: 'Charger Output', unit: 'VDC', targetValue: 13.6, tolerance: 0.2, alarmTolerance: 0.4,
            readings: [[30, 13.6, ''], [16, 13.62, ''], [2, 13.55, '']],
          },
        ],
        children: [
          BATTERY(1, [13.52, 13.48, 13.5, 13.47]),
          BATTERY(2, [13.55, 13.51, 13.53, 13.49]),
          BATTERY(3, [13.45, 13.32, 13.21, 13.12], ['', '', 'Slightly low — recheck', 'Still dropping — load test scheduled']),
          BATTERY(4, [13.5, 13.46, 13.49, 13.51]),
        ],
      },
    ],
  },
  {
    name: 'Main Chiller Pump #2',
    location: 'Basement Mech Room B',
    identifier: 'CHP-002-B',
    points: [
      {
        label: 'Discharge Pressure', unit: 'psi', targetValue: 65, tolerance: 5, alarmTolerance: 8,
        readings: [
          [36, 64.2, 'Baseline after seal replacement'],
          [29, 65.8, ''],
          [22, 63.9, 'Suction strainer cleaned'],
          [15, 66.4, ''],
          [8, 65.1, ''],
          [1, 64.7, ''],
        ],
      },
      {
        label: 'Motor Bearing Temp', unit: '°F', targetValue: 145, tolerance: 10, alarmTolerance: 12,
        readings: [
          [36, 142.5, 'Baseline after motor rebuild'],
          [29, 146.1, ''],
          [22, 149.8, ''],
          [15, 152.3, 'Faint whine at drive-end bearing'],
          [8, 154.6, 'Regreased DE bearing'],
          [1, 158.2, 'Drifting high — schedule vibration analysis'],
        ],
      },
    ],
  },
  {
    name: 'Backup Diesel Generator #1',
    location: 'North Substation',
    identifier: 'DG-001-N',
    points: [
      {
        label: 'Coolant Temp (Under Load)', unit: '°F', targetValue: 185, tolerance: 10, alarmTolerance: 15,
        readings: [
          [33, 182.0, ''],
          [26, 186.4, ''],
          [19, 184.5, 'Monthly load bank test, 75% load'],
          [12, 188.1, ''],
          [5, 183.2, ''],
        ],
      },
      {
        label: 'Starting Battery Voltage', unit: 'VDC', targetValue: 27.2, tolerance: 0.8, alarmTolerance: 1.5,
        readings: [
          [33, 27.3, ''],
          [26, 27.0, ''],
          [19, 26.1, 'Charger breaker found tripped — reset'],
          [12, 27.1, 'Recovered after recharge'],
          [5, 27.2, ''],
        ],
      },
    ],
  },
];

async function seedStore(store) {
  await store.clear();
  const now = Date.now();
  let order = 0;
  const addAsset = async (asset, parentId) => {
    const equipmentId = await store.add('equipment', {
      name: asset.name,
      location: asset.location,
      identifier: asset.identifier,
      parentId,
      createdAt: new Date(now - 40 * DAY + order++ * HOUR).toISOString(),
    });
    for (const p of asset.points || []) {
      const pointId = await store.add('inspectionPoints', {
        equipmentId, label: p.label, unit: p.unit, targetValue: p.targetValue, tolerance: p.tolerance, alarmTolerance: p.alarmTolerance ?? null,
      });
      for (const [daysAgo, value, notes] of p.readings) {
        await store.add('readings', {
          pointId,
          value,
          isOutOfSpec: isOutOfSpec(p, value),
          severity: severityOf(p, { value }),
          notes,
          recordedAt: new Date(now - daysAgo * DAY - (2 + (daysAgo % 4)) * HOUR).toISOString(),
        });
      }
    }
    for (const child of asset.children || []) await addAsset(child, equipmentId);
  };
  for (const asset of SEED) await addAsset(asset, null);
}

/* ============================================================
   Storage: Dexie (IndexedDB) with in-memory/localStorage fallback
   ============================================================ */

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('IndexedDB open timed out')), ms))]);

async function createDexieStore() {
  if (typeof indexedDB === 'undefined' || !indexedDB) throw new Error('IndexedDB unavailable');
  const db = new Dexie(DB_NAME);
  db.version(1).stores({
    equipment: '++id, name, location, identifier, createdAt',
    inspectionPoints: '++id, equipmentId',
    readings: '++id, pointId, recordedAt',
  });
  await withTimeout(db.open(), 3000);
  await db.equipment.count(); // probe a real read
  return {
    kind: 'indexeddb',
    async loadAll() {
      const [equipment, inspectionPoints, readings] = await Promise.all([
        db.equipment.toArray(), db.inspectionPoints.toArray(), db.readings.toArray(),
      ]);
      return { equipment, inspectionPoints, readings };
    },
    add: (table, obj) => db.table(table).add(obj),
    update: (table, id, changes) => db.table(table).update(id, changes),
    remove: (table, id) => db.table(table).delete(id),
    count: () => db.equipment.count(),
    async deletePoint(pointId) {
      await db.transaction('rw', db.inspectionPoints, db.readings, async () => {
        await db.readings.where('pointId').equals(pointId).delete();
        await db.inspectionPoints.delete(pointId);
      });
    },
    async clear() {
      await db.transaction('rw', db.equipment, db.inspectionPoints, db.readings, async () => {
        await Promise.all([db.equipment.clear(), db.inspectionPoints.clear(), db.readings.clear()]);
      });
    },
    // Atomic merge: records arrive with fresh IDs above every existing one, so bulkPut can never overwrite local data.
    async bulkMerge(add) {
      await db.transaction('rw', db.equipment, db.inspectionPoints, db.readings, async () => {
        if (add.equipment.length) await db.equipment.bulkPut(add.equipment);
        if (add.inspectionPoints.length) await db.inspectionPoints.bulkPut(add.inspectionPoints);
        if (add.readings.length) await db.readings.bulkPut(add.readings);
      });
    },
    // Atomic restore: either the whole backup lands (original IDs kept) or nothing changes.
    async replaceAll(next) {
      await db.transaction('rw', db.equipment, db.inspectionPoints, db.readings, async () => {
        await Promise.all([db.equipment.clear(), db.inspectionPoints.clear(), db.readings.clear()]);
        await db.equipment.bulkAdd(next.equipment);
        await db.inspectionPoints.bulkAdd(next.inspectionPoints);
        await db.readings.bulkAdd(next.readings);
      });
    },
  };
}

function createFallbackStore() {
  const empty = () => ({ equipment: [], inspectionPoints: [], readings: [] });
  let data = empty();
  let seq = { equipment: 0, inspectionPoints: 0, readings: 0 };
  let persistent = false;
  try {
    const raw = window.localStorage.getItem(FALLBACK_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.data && parsed.seq) ({ data, seq } = parsed);
    }
    window.localStorage.setItem(FALLBACK_KEY + '-probe', '1');
    window.localStorage.removeItem(FALLBACK_KEY + '-probe');
    persistent = true;
  } catch {
    persistent = false;
  }
  const save = () => {
    if (!persistent) return;
    try {
      window.localStorage.setItem(FALLBACK_KEY, JSON.stringify({ data, seq }));
    } catch {
      /* quota or sandbox: keep running in memory */
    }
  };
  return {
    kind: persistent ? 'localstorage' : 'memory',
    loadAll: async () => ({
      equipment: data.equipment.map((r) => ({ ...r })),
      inspectionPoints: data.inspectionPoints.map((r) => ({ ...r })),
      readings: data.readings.map((r) => ({ ...r })),
    }),
    add: async (table, obj) => {
      const id = ++seq[table];
      data[table].push({ ...obj, id });
      save();
      return id;
    },
    count: async () => data.equipment.length,
    remove: async (table, id) => {
      data[table] = data[table].filter((r) => r.id !== id);
      save();
    },
    update: async (table, id, changes) => {
      const row = data[table].find((r) => r.id === id);
      if (row) Object.assign(row, changes);
      save();
    },
    deletePoint: async (pointId) => {
      data.inspectionPoints = data.inspectionPoints.filter((p) => p.id !== pointId);
      data.readings = data.readings.filter((r) => r.pointId !== pointId);
      save();
    },
    clear: async () => {
      data = empty();
      seq = { equipment: 0, inspectionPoints: 0, readings: 0 };
      save();
    },
    bulkMerge: async (add) => {
      const taken = (rows) => new Set(rows.map((r) => r.id));
      for (const t of ['equipment', 'inspectionPoints', 'readings']) {
        const ids = taken(data[t]);
        if (add[t].some((r) => ids.has(r.id))) throw new Error('ID collision');
      }
      for (const t of ['equipment', 'inspectionPoints', 'readings']) {
        data[t].push(...add[t].map((r) => ({ ...r })));
        seq[t] = Math.max(seq[t], ...data[t].map((r) => r.id), 0);
      }
      save();
    },
    replaceAll: async (next) => {
      const maxId = (rows) => rows.reduce((m, r) => Math.max(m, r.id), 0);
      data = {
        equipment: next.equipment.map((r) => ({ ...r })),
        inspectionPoints: next.inspectionPoints.map((r) => ({ ...r })),
        readings: next.readings.map((r) => ({ ...r })),
      };
      seq = { equipment: maxId(data.equipment), inspectionPoints: maxId(data.inspectionPoints), readings: maxId(data.readings) };
      save();
    },
  };
}

// Module-level singleton so React StrictMode double-effects never double-seed.
let storePromise = null;
function getStore() {
  if (!storePromise) {
    storePromise = (async () => {
      let store;
      try {
        store = await createDexieStore();
        if ((await store.count()) === 0) await seedStore(store);
      } catch (err) {
        console.warn('[InSpec] IndexedDB unavailable, using fallback storage:', err);
        store = createFallbackStore();
        if ((await store.count()) === 0) await seedStore(store);
      }
      return store;
    })();
  }
  return storePromise;
}

/* ============================================================
   CSV export
   ============================================================ */

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function buildCsv(asset, point, readings, assetPath = '') {
  const { min, max } = limits(point);
  const dp = decimalsFor(point);
  const header = [
    'Recorded At (ISO)', 'Local Time', 'Asset Path', 'Equipment', 'Tag', 'Location', 'Parameter', 'Unit',
    'Value', 'Target', 'Tolerance', 'Min Acceptable', 'Max Acceptable', 'Alarm Tolerance', 'Alarm Low', 'Alarm High',
    'Delta From Target', 'Status', 'Notes',
  ];
  const rows = [...readings].sort(byTime).reverse().map((r) => [
    r.recordedAt, new Date(r.recordedAt).toLocaleString(), assetPath || asset.name, asset.name, asset.identifier, asset.location,
    point.label, point.unit, r.value, point.targetValue, point.tolerance, fmt(min, dp), fmt(max, dp),
    hasAlarm(point) ? point.alarmTolerance : '', hasAlarm(point) ? fmt(point.targetValue - point.alarmTolerance, dp) : '',
    hasAlarm(point) ? fmt(point.targetValue + point.alarmTolerance, dp) : '',
    (r.value - point.targetValue).toFixed(dp), SEV[r.sev || severityOf(point, r)].label, r.notes || '',
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Installed iPhone/iPad home-screen apps can't reliably download files; use the share sheet there
// ("Save to Files", AirDrop, Mail). Returns 'shared' | 'declined' | null (null = not applicable, fall back).
async function shareFileOnIOSApp(filename, text, mime) {
  try {
    const iosStandalone = typeof navigator !== 'undefined' && navigator.standalone === true;
    if (!iosStandalone || typeof File === 'undefined' || !navigator.canShare || !navigator.share) return null;
    const file = new File([text], filename, { type: mime });
    if (!navigator.canShare({ files: [file] })) return null;
    await navigator.share({ files: [file], title: filename });
    return 'shared';
  } catch (err) {
    return err && err.name === 'AbortError' ? 'declined' : null;
  }
}

function downloadFile(filename, text) {
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ============================================================
   Shared UI primitives
   ============================================================ */

const inputCls =
  'h-14 w-full rounded-xl border-2 border-zinc-700 bg-zinc-950 px-4 text-lg text-white placeholder-zinc-500 ' +
  'focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30';

/* ---------- Motion ----------
   Small Web Animations API helpers: no CSS keyframes needed, and everything is skipped when the
   device asks for reduced motion. */
const prefersReducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};
const animateEl = (el, frames, options) => {
  if (!el || typeof el.animate !== 'function' || prefersReducedMotion()) return null;
  try {
    return el.animate(frames, options);
  } catch {
    return null;
  }
};
const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)'; // slight overshoot, like an iOS spring

function Modal({ title, onClose, children }) {
  const backdropRef = useRef(null);
  const sheetRef = useRef(null);
  // Entrance: backdrop fades in, sheet springs up from the bottom (scales up from centre on wide screens).
  useEffect(() => {
    animateEl(backdropRef.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
    const wide = window.matchMedia && window.matchMedia('(min-width: 640px)').matches;
    animateEl(
      sheetRef.current,
      wide
        ? [{ opacity: 0, transform: 'scale(0.94)' }, { opacity: 1, transform: 'scale(1)' }]
        : [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }],
      { duration: wide ? 220 : 340, easing: SPRING },
    );
  }, []);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 sm:items-center"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
    >
      <div ref={sheetRef} className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl border-2 border-zinc-700 bg-zinc-900 p-5 pb-[calc(1.25rem+var(--sab,0px))] shadow-2xl sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-black uppercase tracking-wide text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-800 text-zinc-300 active:bg-zinc-700"
          >
            <X size={24} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, error, hint, children }) {
  return (
    <label className="mb-4 block">
      <span className="mb-1.5 block text-xs font-bold uppercase tracking-widest text-zinc-400">{label}</span>
      {children}
      {error ? (
        <span className="mt-1.5 block text-sm font-semibold text-red-400">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-sm text-zinc-500">{hint}</span>
      ) : null}
    </label>
  );
}

function PrimaryButton({ children, className, ...props }) {
  return (
    <button
      {...props}
      className={cx(
        'flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-5 text-lg font-black uppercase tracking-wider text-zinc-950',
        'active:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      {children}
    </button>
  );
}

function StatusPill({ sev, small }) {
  const tone = {
    ok: 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/50',
    warn: 'bg-amber-400/15 text-amber-300 ring-amber-400/60',
    alarm: 'bg-red-500/15 text-red-400 ring-red-500/50',
  }[sev];
  const Icon = sev === 'ok' ? CheckCircle2 : sev === 'warn' ? AlertTriangle : AlertOctagon;
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-md font-black uppercase tracking-wider ring-1', tone, small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs')}>
      <Icon size={small ? 11 : 13} /> {sev === 'ok' ? 'OK' : sev === 'warn' ? 'Warn' : 'Alarm'}
    </span>
  );
}

function RangeInfo({ point, className }) {
  const dp = decimalsFor(point);
  const { min, max } = limits(point);
  return (
    <div className={cx('font-mono text-xs leading-relaxed', className)}>
      <p className="text-zinc-400">
        Target: {fmt(point.targetValue, dp)} ± {fmt(point.tolerance, dp)} {point.unit} | Range: {fmt(min, dp)} - {fmt(max, dp)} {point.unit}
      </p>
      {hasAlarm(point) && (() => {
        const { amin, amax } = alarmLimits(point);
        return (
          <p>
            <span className="text-amber-400">Warn: {fmt(amin, dp)}–{fmt(min, dp)} / {fmt(max, dp)}–{fmt(amax, dp)}</span>
            <span className="text-zinc-600"> | </span>
            <span className="text-red-400">Alarm: &lt; {fmt(amin, dp)} or &gt; {fmt(amax, dp)}</span>
          </p>
        );
      })()}
    </div>
  );
}

function SpecDot(props) {
  const { cx: x, cy: y, payload, index, r = 4 } = props;
  if (x == null || y == null) return <g key={`d-${index}`} />;
  const C = useChart();
  const sev = (payload && payload.sev) || 'ok';
  return (
    <circle
      key={`d-${index}`}
      cx={x}
      cy={y}
      r={sev === 'ok' ? r : r + 1.5}
      fill={C[sev]}
      stroke={C.dotStroke}
      strokeWidth={1.5}
    />
  );
}

function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

/* ============================================================
   Modals: new asset, new parameter, reset, CSV fallback
   ============================================================ */

function AddParameterModal({ onClose, onCreate, initial, readings = [] }) {
  const editing = Boolean(initial);
  const [form, setForm] = useState(() => ({
    label: initial ? initial.label : '',
    unit: initial ? initial.unit : '',
    target: initial ? String(initial.targetValue) : '',
    tolerance: initial ? String(initial.tolerance) : '',
    alarm: initial && hasAlarm(initial) ? String(initial.alarmTolerance) : '',
  }));
  const [recheck, setRecheck] = useState(true);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const t = parseNum(form.target);
  const tol = parseNum(form.tolerance);
  const alarmBlank = form.alarm.trim() === '';
  const alarm = alarmBlank ? null : parseNum(form.alarm);
  const previewPoint = Number.isFinite(t) && Number.isFinite(tol) && tol > 0
    ? { targetValue: t, tolerance: tol, alarmTolerance: Number.isFinite(alarm) && alarm > tol ? alarm : null, unit: form.unit.trim() }
    : null;
  const limitsChanged = editing && Number.isFinite(t) && Number.isFinite(tol) && tol > 0
    && (Math.abs(t - initial.targetValue) > 1e-12 || Math.abs(tol - initial.tolerance) > 1e-12);
  const flips = limitsChanged
    ? readings.filter((r) => isOutOfSpec({ targetValue: t, tolerance: tol }, r.value) !== r.isOutOfSpec).length
    : 0;

  const submit = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!form.label.trim()) errs.label = 'Parameter label is required';
    if (!form.unit.trim()) errs.unit = 'Unit is required';
    if (!Number.isFinite(t)) errs.target = 'Enter a numeric target';
    if (!Number.isFinite(tol)) errs.tolerance = 'Enter a numeric tolerance';
    else if (tol <= 0) errs.tolerance = 'Tolerance must be greater than 0';
    if (!alarmBlank) {
      if (!Number.isFinite(alarm)) errs.alarm = 'Enter a number, or leave blank';
      else if (Number.isFinite(tol) && alarm <= tol) errs.alarm = 'Must be wider than the tolerance';
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try {
      await onCreate(
        { label: form.label.trim(), unit: form.unit.trim(), targetValue: t, tolerance: tol, alarmTolerance: alarmBlank ? null : alarm },
        { recheck: limitsChanged && recheck },
      );
    } catch {
      setErrors({ form: 'Could not save parameter. Try again.' });
      setSaving(false);
    }
  };

  return (
    <Modal title={editing ? 'Edit Parameter' : 'Add Parameter'} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Field label="Parameter Label" error={errors.label}>
          <input className={inputCls} value={form.label} onChange={set('label')} placeholder="e.g. Vibration (DE Horizontal)" autoFocus />
        </Field>
        <Field label="Unit" error={errors.unit}>
          <input className={inputCls} value={form.unit} onChange={set('unit')} placeholder="e.g. in/s, °F, psi, VDC" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Target" error={errors.target}>
            <input className={cx(inputCls, 'font-mono')} value={form.target} onChange={set('target')} inputMode="decimal" placeholder="145.0" />
          </Field>
          <Field label="Tolerance ±" error={errors.tolerance}>
            <input className={cx(inputCls, 'font-mono')} value={form.tolerance} onChange={set('tolerance')} inputMode="decimal" placeholder="10.0" />
          </Field>
        </div>
        <Field label="Alarm Tolerance ± (optional)" error={errors.alarm} hint="Outer limit. Between tolerance and this is a yellow warning; beyond it is a red alarm. Leave blank for in/out only.">
          <input className={cx(inputCls, 'font-mono')} value={form.alarm} onChange={set('alarm')} inputMode="decimal" placeholder="e.g. 15.0" />
        </Field>
        <div className="mb-4 rounded-xl border border-dashed border-zinc-700 px-4 py-3">
          {previewPoint ? <RangeInfo point={previewPoint} /> : <p className="font-mono text-sm text-zinc-400">Enter target and tolerance to preview the acceptable range</p>}
        </div>
        {limitsChanged && readings.length > 0 && (
          <label className="mb-4 flex min-h-[56px] cursor-pointer items-start gap-3 rounded-xl border-2 border-amber-400/50 bg-amber-400/5 p-3">
            <input
              type="checkbox"
              checked={recheck}
              onChange={(e) => setRecheck(e.target.checked)}
              className="mt-0.5 h-6 w-6 shrink-0 accent-emerald-500"
            />
            <span className="text-sm leading-snug text-zinc-300">
              <span className="font-bold text-white">Re-check past readings against the new limits</span>
              <span className="block text-zinc-400">
                {flips > 0
                  ? `${plural(flips, 'reading')} would change between in spec and out of spec.`
                  : 'No past reading changes status with these limits.'}{' '}
                Untick to keep the pass/fail recorded at the time.
              </span>
            </span>
          </label>
        )}
        {errors.form && <p className="mb-3 text-sm font-semibold text-red-400">{errors.form}</p>}
        <PrimaryButton type="submit" disabled={saving}>
          {editing ? <Pencil size={20} strokeWidth={2.5} /> : <Plus size={22} strokeWidth={3} />}{' '}
          {saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Parameter'}
        </PrimaryButton>
      </form>
    </Modal>
  );
}

function ResetModal({ onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Reset Demo Data" onClose={onClose}>
      <p className="mb-5 text-base leading-relaxed text-zinc-300">
        This erases <span className="font-bold text-white">every asset, parameter and reading</span> on this device and restores the original sample data. This cannot be undone.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <button type="button" onClick={onClose} className="h-14 rounded-xl border-2 border-zinc-700 text-lg font-bold uppercase text-zinc-200 active:bg-zinc-800">
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onConfirm();
          }}
          className="flex h-14 items-center justify-center gap-2 rounded-xl bg-red-600 text-lg font-black uppercase text-white active:bg-red-500 disabled:opacity-50"
        >
          <RotateCcw size={20} /> {busy ? 'Resetting…' : 'Reset'}
        </button>
      </div>
    </Modal>
  );
}

function AlarmZoneModal({ point, onClose, onSave }) {
  const [val, setVal] = useState(hasAlarm(point) ? String(point.alarmTolerance) : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dp = decimalsFor(point);
  const blank = val.trim() === '';
  const a = blank ? null : parseNum(val);
  const preview = { ...point, alarmTolerance: Number.isFinite(a) && a > point.tolerance ? a : null };

  const save = async (alarmTolerance) => {
    setSaving(true);
    const ok = await onSave(alarmTolerance);
    if (!ok) setSaving(false);
  };
  const submit = (e) => {
    e.preventDefault();
    if (blank) return save(null);
    if (!Number.isFinite(a)) return setError('Enter a number, or leave blank to remove');
    if (a <= point.tolerance) return setError(`Must be wider than the tolerance (± ${fmt(point.tolerance, dp)})`);
    save(a);
  };

  return (
    <Modal title="Alarm Zone" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p className="mb-4 text-sm leading-relaxed text-zinc-400">
          <span className="font-bold text-white">{point.label}</span> is in spec within ± {fmt(point.tolerance, dp)} {point.unit} of {fmt(point.targetValue, dp)}.
          Set a wider alarm limit: readings between the two show <span className="font-bold text-amber-400">yellow (warning)</span>, readings past it show <span className="font-bold text-red-400">red (alarm)</span>.
        </p>
        <Field label={`Alarm Tolerance ± (${point.unit})`} error={error} hint="Leave blank to remove the warning zone (out of spec = red).">
          <input
            className={cx(inputCls, 'font-mono')}
            value={val}
            onChange={(e) => { setVal(e.target.value); setError(''); }}
            inputMode="decimal"
            placeholder={fmt(point.tolerance * 1.5, dp)}
            autoFocus
          />
        </Field>
        <div className="mb-4 rounded-xl border border-dashed border-zinc-700 px-4 py-3">
          <RangeInfo point={preview} />
        </div>
        <PrimaryButton type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save Alarm Zone'}</PrimaryButton>
      </form>
    </Modal>
  );
}

function DeletePointModal({ point, readingCount, onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Delete Parameter" onClose={onClose}>
      <p className="mb-2 text-base leading-relaxed text-zinc-300">
        Delete <span className="font-bold text-white">{point.label}</span> ({point.unit})?
      </p>
      <p className="mb-5 text-base leading-relaxed text-zinc-300">
        {readingCount > 0 ? (
          <>Its <span className="font-bold text-red-400">{readingCount} logged reading{readingCount === 1 ? '' : 's'}</span> will be permanently erased. Export the CSV first if you need a record.</>
        ) : (
          <>It has no readings yet.</>
        )}{' '}
        This cannot be undone.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <button type="button" onClick={onClose} className="h-14 rounded-xl border-2 border-zinc-700 text-lg font-bold uppercase text-zinc-200 active:bg-zinc-800">
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const ok = await onConfirm();
            if (!ok) setBusy(false);
          }}
          className="flex h-14 items-center justify-center gap-2 rounded-xl bg-red-600 text-lg font-black uppercase text-white active:bg-red-500 disabled:opacity-50"
        >
          <Trash2 size={20} /> {busy ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </Modal>
  );
}

function CsvModal({ csv, filename, onClose, onCopy }) {
  const ref = useRef(null);
  return (
    <Modal title="CSV Export" onClose={onClose}>
      <p className="mb-3 text-sm text-zinc-400">
        If the download didn&apos;t start (some embedded previews block downloads), copy the data below and save it as <span className="font-mono text-zinc-200">{filename}</span>.
      </p>
      <textarea
        ref={ref}
        readOnly
        value={csv}
        onFocus={(e) => e.target.select()}
        className="mb-4 h-48 w-full rounded-xl border-2 border-zinc-700 bg-zinc-950 p-3 font-mono text-xs text-zinc-300"
      />
      <PrimaryButton
        type="button"
        onClick={async () => {
          const ok = await copyText(csv);
          if (!ok && ref.current) ref.current.select();
          onCopy(ok);
        }}
      >
        <Copy size={20} /> Copy CSV
      </PrimaryButton>
    </Modal>
  );
}

/* ============================================================
   Screen 1: Equipment directory
   ============================================================ */

function assetStatus(points, readingsByPoint) {
  if (!points.length) return { kind: 'empty', warn: 0, alarm: 0 };
  let warn = 0;
  let alarm = 0;
  let withReadings = 0;
  let lastAt = null;
  for (const p of points) {
    const rs = readingsByPoint.get(p.id) || [];
    const latest = rs[rs.length - 1];
    if (latest) {
      withReadings++;
      if (latest.sev === 'warn') warn++;
      if (latest.sev === 'alarm') alarm++;
      if (!lastAt || latest.recordedAt > lastAt) lastAt = latest.recordedAt;
    }
  }
  if (alarm) return { kind: 'alarm', warn, alarm, lastAt };
  if (warn) return { kind: 'warn', warn, alarm, lastAt };
  if (!withReadings) return { kind: 'pending', warn, alarm, lastAt };
  return { kind: 'ok', warn, alarm, lastAt };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isAttention = (k) => k === 'warn' || k === 'alarm';

function AssetStatusBadge({ status }) {
  if (status.kind === 'alarm') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/15 px-2.5 py-1.5 text-xs font-black uppercase tracking-wider text-red-400 ring-2 ring-red-500/60">
        <AlertOctagon size={15} strokeWidth={2.5} />
        {plural(status.alarm, 'Alarm')}{status.warn ? ` · ${plural(status.warn, 'Warning')}` : ''}
      </span>
    );
  }
  if (status.kind === 'warn') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400/15 px-2.5 py-1.5 text-xs font-black uppercase tracking-wider text-amber-300 ring-2 ring-amber-400/60">
        <AlertTriangle size={15} strokeWidth={2.5} />
        {plural(status.warn, 'Warning')}
      </span>
    );
  }
  if (status.kind === 'ok') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-2.5 py-1.5 text-xs font-black uppercase tracking-wider text-emerald-400 ring-2 ring-emerald-500/50">
        <CheckCircle2 size={15} strokeWidth={2.5} /> All in spec
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs font-black uppercase tracking-wider text-zinc-400 ring-1 ring-zinc-600">
      {status.kind === 'empty' ? 'No parameters' : 'Awaiting readings'}
    </span>
  );
}

/* ============================================================
   Local data backup & restore
   ============================================================ */

const BACKUP_VERSION = 1;
const BACKUP_APP_NAMES = ['InSpec', 'SpecLog'];
const LAST_BACKUP_KEY = 'speclog_last_backup';
const LEGACY_BACKUP_KEY = 'speclog-last-backup';

const LAST_CHANGE_KEY = 'speclog_last_change';
const RECONNECT_MIN_OFFLINE_MS = 30 * 1000; // ignore brief signal blips
const RECONNECT_PROMPT_COOLDOWN_MS = 30 * 60 * 1000; // never more than once per 30 min
const RECONNECT_PROMPT_VISIBLE_MS = 45 * 1000; // fades away on its own

const readLastChange = () => {
  try {
    return window.localStorage.getItem(LAST_CHANGE_KEY);
  } catch {
    return null;
  }
};
const fmtDuration = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} hr ${m % 60 ? `${m % 60} min` : ''}`.trim() : `${Math.floor(h / 24)} day${h >= 48 ? 's' : ''}`;
};

const readLastBackup = () => {
  try {
    return window.localStorage.getItem(LAST_BACKUP_KEY) || window.localStorage.getItem(LEGACY_BACKUP_KEY);
  } catch {
    return null;
  }
};
const writeLastBackup = (iso) => {
  try {
    window.localStorage.setItem(LAST_BACKUP_KEY, iso);
  } catch {
    /* storage blocked: reminder just won't persist */
  }
};

const relativeDays = (iso) => {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < HOUR) return diff < 60000 ? 'just now' : `${Math.floor(diff / 60000)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} hour${Math.floor(diff / HOUR) === 1 ? '' : 's'} ago`;
  const d = Math.floor(diff / DAY);
  return d === 1 ? 'yesterday' : `${d} days ago`;
};

function buildBackup(raw) {
  // Raw store records only (no derived UI fields), so a restore is byte-for-byte faithful.
  const clean = (rows) => rows.map((r) => {
    const { sev, ...rest } = r; // eslint-disable-line no-unused-vars
    return rest;
  });
  return {
    app: 'InSpec',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      equipment: clean(raw.equipment),
      inspectionPoints: clean(raw.inspectionPoints),
      readings: clean(raw.readings),
    },
  };
}

// Validate and normalise a backup file. Returns { ok, error } or { ok, meta, data, warnings }.
function parseBackup(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file is not valid JSON.' };
  }
  if (!doc || typeof doc !== 'object') return { ok: false, error: 'This file is not an InSpec backup.' };
  // Backups made before the rebrand say "SpecLog"; both are the same format.
  if (!BACKUP_APP_NAMES.includes(doc.app)) return { ok: false, error: 'This file is not an InSpec backup (missing "app": "InSpec").' };
  if (!Number.isInteger(doc.version) || doc.version < 1) return { ok: false, error: 'Backup version is missing or invalid.' };
  if (doc.version > BACKUP_VERSION) {
    return { ok: false, error: `This backup was made by a newer InSpec (format v${doc.version}). Update the app, then try again.` };
  }
  const d = doc.data;
  if (!d || !Array.isArray(d.equipment) || !Array.isArray(d.inspectionPoints) || !Array.isArray(d.readings)) {
    return { ok: false, error: 'Backup is missing the equipment, inspectionPoints or readings lists.' };
  }
  const warnings = [];
  const isId = (v) => Number.isInteger(v) && v > 0;
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  const dateOk = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

  // Equipment
  const equipment = [];
  const eqIds = new Set();
  let dropped = 0;
  for (const e of d.equipment) {
    if (!e || !isId(e.id) || eqIds.has(e.id) || !str(e.name).trim()) { dropped++; continue; }
    eqIds.add(e.id);
    equipment.push({
      ...e,
      name: str(e.name),
      location: str(e.location),
      identifier: str(e.identifier),
      parentId: e.parentId == null ? null : Number(e.parentId),
      createdAt: dateOk(e.createdAt) ? e.createdAt : new Date().toISOString(),
    });
  }
  if (dropped) warnings.push(`${plural(dropped, 'asset')} skipped (missing ID or name).`);
  // Parent links: missing parents become top level; break any loops.
  const byId = new Map(equipment.map((e) => [e.id, e]));
  let orphans = 0;
  for (const e of equipment) {
    if (e.parentId != null && !byId.has(e.parentId)) { e.parentId = null; orphans++; }
  }
  let loops = 0;
  for (const e of equipment) {
    const seen = new Set([e.id]);
    let cur = e.parentId != null ? byId.get(e.parentId) : null;
    while (cur) {
      if (seen.has(cur.id)) { e.parentId = null; loops++; break; }
      seen.add(cur.id);
      cur = cur.parentId != null ? byId.get(cur.parentId) : null;
    }
  }
  if (orphans) warnings.push(`${plural(orphans, 'asset')} pointed to a missing parent and will be placed at the top level.`);
  if (loops) warnings.push(`${plural(loops, 'circular parent link')} fixed by moving to the top level.`);

  // Inspection points
  const inspectionPoints = [];
  const ptById = new Map();
  dropped = 0;
  for (const p of d.inspectionPoints) {
    const target = num(p && p.targetValue);
    const tol = num(p && p.tolerance);
    if (!p || !isId(p.id) || ptById.has(p.id) || !eqIds.has(p.equipmentId) || !Number.isFinite(target) || !Number.isFinite(tol) || tol <= 0) {
      dropped++;
      continue;
    }
    const alarm = p.alarmTolerance == null ? null : num(p.alarmTolerance);
    const row = {
      ...p,
      label: str(p.label) || 'Unnamed parameter',
      unit: str(p.unit),
      targetValue: target,
      tolerance: tol,
      alarmTolerance: Number.isFinite(alarm) && alarm > tol ? alarm : null,
    };
    ptById.set(row.id, row);
    inspectionPoints.push(row);
  }
  if (dropped) warnings.push(`${plural(dropped, 'parameter')} skipped (invalid limits or missing asset).`);

  // Readings
  const readings = [];
  const rdIds = new Set();
  dropped = 0;
  for (const r of d.readings) {
    const value = num(r && r.value);
    const pt = r && ptById.get(r.pointId);
    if (!r || !isId(r.id) || rdIds.has(r.id) || !pt || !Number.isFinite(value) || !dateOk(r.recordedAt)) { dropped++; continue; }
    rdIds.add(r.id);
    const out = typeof r.isOutOfSpec === 'boolean' ? r.isOutOfSpec : isOutOfSpec(pt, value);
    readings.push({
      ...r,
      value,
      isOutOfSpec: out,
      severity: typeof r.severity === 'string' ? r.severity : severityOf(pt, { value, isOutOfSpec: out }),
      notes: str(r.notes),
    });
  }
  if (dropped) warnings.push(`${plural(dropped, 'reading')} skipped (invalid value, date or parameter).`);

  return {
    ok: true,
    meta: { exportedAt: dateOk(doc.exportedAt) ? doc.exportedAt : null, version: doc.version },
    data: { equipment, inspectionPoints, readings },
    warnings,
  };
}

// Merge plan: an incoming asset is "the same asset" only if its tag matches AND it sits under the same
// (already matched) parent - so a generic child tag like BAT-01 at another site can never be merged onto
// this site's BAT-01. Same-tag assets in a different place are added separately with a renamed tag.
// Parameters match by label+unit within a matched asset; readings by time+value.
// Nothing on this device is changed or removed; only missing records are added (with fresh IDs).
function planMerge(current, incoming) {
  const tagKey = (s) => String(s || '').trim().toUpperCase();
  const ptKey = (assetId, p) => `${assetId}|${String(p.label).trim().toLowerCase()}|${String(p.unit).trim().toLowerCase()}`;
  const rdKey = (pointId, r) => `${pointId}|${new Date(r.recordedAt).getTime()}|${Number(r.value)}`;

  const curByTag = new Map();
  for (const e of current.equipment) if (tagKey(e.identifier)) curByTag.set(tagKey(e.identifier), e);
  const curPoint = new Map(current.inspectionPoints.map((p) => [ptKey(p.equipmentId, p), p]));
  const curReading = new Set(current.readings.map((r) => rdKey(r.pointId, r)));

  const curIds = new Set(current.equipment.map((e) => e.id));
  const curParent = (m) => (m.parentId != null && curIds.has(m.parentId) ? m.parentId : null);

  // Walk the backup top-down so each asset's parent is decided before the asset itself.
  const incById = new Map(incoming.equipment.map((e) => [e.id, e]));
  const depth = (e) => {
    let d = 0;
    const seen = new Set([e.id]);
    let cur = e.parentId != null ? incById.get(e.parentId) : null;
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); d++; cur = cur.parentId != null ? incById.get(cur.parentId) : null; }
    return d;
  };
  const incPath = (e) => {
    const out = [];
    const seen = new Set([e.id]);
    let cur = e.parentId != null ? incById.get(e.parentId) : null;
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur.name); cur = cur.parentId != null ? incById.get(cur.parentId) : null; }
    return out;
  };
  const ordered = [...incoming.equipment].sort((a, b) => depth(a) - depth(b));

  const usedTags = new Set([...current.equipment.map((e) => tagKey(e.identifier)), ...incoming.equipment.map((e) => tagKey(e.identifier))]);
  const renameTag = (tag) => {
    const base = String(tag || 'ASSET').trim();
    let candidate = `${base}-IMP`;
    for (let n = 2; usedTags.has(tagKey(candidate)); n++) candidate = `${base}-IMP${n}`;
    usedTags.add(tagKey(candidate));
    return candidate;
  };

  const eqMatch = new Map(); // incoming asset id -> existing asset id
  const claimed = new Set();
  const newEquipment = [];
  const conflicts = [];
  for (const e of ordered) {
    const m = tagKey(e.identifier) ? curByTag.get(tagKey(e.identifier)) : null;
    if (!m) { newEquipment.push(e); continue; }
    // Where this asset would live on this device: top level, under a matched asset, or under a brand-new asset.
    const parentHere = e.parentId == null || !incById.has(e.parentId) ? null : eqMatch.has(e.parentId) ? eqMatch.get(e.parentId) : 'new';
    if (parentHere !== 'new' && parentHere === curParent(m) && !claimed.has(m.id)) {
      eqMatch.set(e.id, m.id);
      claimed.add(m.id);
    } else {
      const renamed = renameTag(e.identifier);
      conflicts.push({ name: e.name, path: incPath(e), from: e.identifier, to: renamed });
      newEquipment.push({ ...e, identifier: renamed });
    }
  }
  const ptMatch = new Map(); // incoming point id -> existing point id
  const newPoints = [];
  for (const p of incoming.inspectionPoints) {
    const existingAsset = eqMatch.get(p.equipmentId);
    const m = existingAsset != null ? curPoint.get(ptKey(existingAsset, p)) : null;
    if (m) ptMatch.set(p.id, m.id);
    else newPoints.push(p);
  }
  const newReadings = [];
  let dupReadings = 0;
  for (const r of incoming.readings) {
    const existingPoint = ptMatch.get(r.pointId);
    if (existingPoint != null && curReading.has(rdKey(existingPoint, r))) dupReadings++;
    else newReadings.push(r);
  }
  return {
    eqMatch, ptMatch, newEquipment, newPoints, newReadings, conflicts,
    matched: { equipment: eqMatch.size, inspectionPoints: ptMatch.size, readings: dupReadings },
  };
}

// Save a text file: iOS share sheet in the installed iPhone/iPad app, otherwise a normal browser download.
async function saveTextFile(filename, text) {
  const shared = await shareFileOnIOSApp(filename, text, 'application/json');
  if (shared === 'shared') return 'saved';
  if (shared === 'declined') return 'declined';
  try {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}

function ReconnectBackupPrompt({ info, onBackup, onDismiss }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(0.75rem+var(--sat,0px))] z-[55] flex justify-center px-3" role="status" aria-live="polite">
      <div className="pointer-events-auto w-full max-w-md rounded-2xl bg-zinc-900 p-3 shadow-2xl ring-2 ring-emerald-500/60">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
            <Wifi size={20} strokeWidth={2.5} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black uppercase tracking-wide text-white">Back online</p>
            <p className="mt-0.5 text-sm leading-snug text-zinc-400">
              {info.newReadings > 0
                ? `${plural(info.newReadings, 'reading')} logged since your last backup.`
                : 'You made changes since your last backup.'}
              {info.neverBackedUp ? ' This device has never been backed up.' : ''} Save a copy now?
            </p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="h-12 rounded-xl border-2 border-zinc-700 text-sm font-bold uppercase tracking-wider text-zinc-300 active:bg-zinc-800"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={onBackup}
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-emerald-500 text-sm font-black uppercase tracking-wider text-zinc-950 active:bg-emerald-400"
          >
            <DiskIcon size={18} strokeWidth={2} /> Back up now
          </button>
        </div>
      </div>
    </div>
  );
}

function BackupModal({ store, current, counts, onClose, onRestore, onMerge, notify }) {
  const [lastBackup, setLastBackup] = useState(readLastBackup);
  const [busy, setBusy] = useState(false);
  const [fallback, setFallback] = useState(null); // { filename, text } when the download may have been blocked
  const [pending, setPending] = useState(null); // parsed backup awaiting confirmation
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [mode, setMode] = useState('merge');
  const fileRef = useRef(null);
  const plan = useMemo(() => (pending ? planMerge(current, pending.data) : null), [pending, current]);
  const taRef = useRef(null);

  const exportBackup = async () => {
    setBusy(true);
    setError('');
    try {
      const raw = await store.loadAll();
      const doc = buildBackup(raw);
      const text = JSON.stringify(doc, null, 2);
      const t = new Date(doc.exportedAt);
      const pad = (n) => String(n).padStart(2, '0');
      const filename = `inspec-backup-${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}.json`;
      const result = await saveTextFile(filename, text);
      if (result === 'saved' || result === 'downloaded') {
        writeLastBackup(doc.exportedAt);
        setLastBackup(doc.exportedAt);
        notify(
          `Backup exported · ${plural(raw.equipment.length, 'asset')}, ${plural(raw.readings.length, 'reading')}`,
          'ok',
        );
        // Plain browser downloads can be silently blocked inside embedded previews; keep a copy option visible.
        if (result === 'downloaded') setFallback({ filename, text });
      } else if (result === 'declined') {
        notify('Backup cancelled', 'warn');
      } else if (result === 'busy') {
        notify('A save prompt is already open', 'warn');
      } else {
        setFallback({ filename, text });
      }
    } catch {
      setError('Could not read the database to export. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const onPickFile = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setPending(null);
    setConfirmArmed(false);
    setMode('merge');
    setFileName(file.name);
    const reader = new FileReader();
    reader.onerror = () => setError('Could not read that file.');
    reader.onload = () => {
      const parsed = parseBackup(String(reader.result || ''));
      if (!parsed.ok) setError(parsed.error);
      else setPending(parsed);
    };
    reader.readAsText(file);
  };

  const restore = async () => {
    if (mode === 'replace' && !confirmArmed) {
      setConfirmArmed(true);
      return;
    }
    setBusy(true);
    const ok = mode === 'merge' ? await onMerge(plan) : await onRestore(pending.data);
    if (!ok) {
      setBusy(false);
      setConfirmArmed(false);
    }
  };

  const stat = (n, label) => (
    <div className="rounded-xl bg-zinc-950 p-2.5 text-center ring-1 ring-zinc-800">
      <p className="font-mono text-xl font-black text-white">{n}</p>
      <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">{label}</p>
    </div>
  );

  return (
    <Modal title="Data & Backup" onClose={onClose}>
      <p className="mb-3 text-sm leading-relaxed text-zinc-400">
        Your data lives only in this browser. Export a backup file regularly and before clearing your cache or switching devices.
      </p>

      <div className="mb-2 grid grid-cols-3 gap-2">
        {stat(counts.equipment, 'Assets')}
        {stat(counts.inspectionPoints, 'Params')}
        {stat(counts.readings, 'Readings')}
      </div>
      <div className="mb-4">
        <p className={cx('flex items-center gap-1.5 text-sm font-black uppercase tracking-wider', lastBackup ? 'text-emerald-400' : 'text-amber-400')}>
          {lastBackup ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          {lastBackup ? `Last backup: ${relativeDays(lastBackup)}` : 'Never backed up'}
        </p>
        <p className="mt-0.5 text-xs text-zinc-500">
          {lastBackup ? `${fmtDateTime(lastBackup)} · from this device` : 'Save a snapshot after adding a new site or crossing house.'}
        </p>
      </div>

      <PrimaryButton type="button" onClick={exportBackup} disabled={busy} className="!text-sm">
        <Download size={20} strokeWidth={2.5} /> {busy && !pending ? 'Exporting…' : 'Export Full Backup (.json)'}
      </PrimaryButton>

      {fallback && (
        <div className="mt-3 rounded-xl border-2 border-dashed border-zinc-700 p-3">
          <p className="mb-2 text-xs text-zinc-400">
            If no file appeared, copy the backup and save it as <span className="font-mono text-zinc-200">{fallback.filename}</span>.
          </p>
          <textarea
            ref={taRef}
            readOnly
            value={fallback.text}
            onFocus={(e) => e.target.select()}
            className="mb-2 h-24 w-full rounded-lg border-2 border-zinc-700 bg-zinc-950 p-2 font-mono text-[10px] text-zinc-300"
          />
          <button
            type="button"
            onClick={async () => {
              const ok = await copyText(fallback.text);
              if (!ok && taRef.current) taRef.current.select();
              if (ok) {
                writeLastBackup(new Date().toISOString());
                setLastBackup(readLastBackup());
              }
              notify(ok ? 'Backup copied to clipboard' : 'Copy blocked — text selected, copy manually', ok ? 'ok' : 'warn');
            }}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-zinc-800 text-sm font-black uppercase tracking-wider text-white active:bg-zinc-700"
          >
            <Copy size={18} /> Copy backup
          </button>
        </div>
      )}

      <div className="my-5 border-t-2 border-zinc-800" />

      <h3 className="mb-1 text-sm font-black uppercase tracking-wider text-white">Restore from backup</h3>
      <p className="mb-3 text-sm text-zinc-400">Pick an InSpec .json backup (older SpecLog backups work too). You&apos;ll see what&apos;s in it before anything changes.</p>
      <input ref={fileRef} type="file" accept=".json" onChange={onPickFile} className="hidden" aria-label="Import backup file" />
      <button
        type="button"
        onClick={() => fileRef.current && fileRef.current.click()}
        disabled={busy}
        className="flex h-14 w-full items-center justify-center gap-2 rounded-xl border-2 border-zinc-600 text-base font-black uppercase tracking-wider text-zinc-200 active:bg-zinc-800 disabled:opacity-50"
      >
        <Upload size={20} strokeWidth={2.5} /> Import Backup (.json)
      </button>

      {error && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-red-500/10 p-3 text-sm font-semibold text-red-400 ring-1 ring-red-500/50">
          <AlertOctagon size={18} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}

      {pending && (
        <div className="mt-3 rounded-xl border-2 border-zinc-700 p-3">
          <p className="mb-2 truncate font-mono text-xs text-zinc-400">{fileName}</p>
          <p className="mb-2 text-sm text-zinc-300">
            Backup from <span className="font-bold text-white">{pending.meta.exportedAt ? fmtDateTime(pending.meta.exportedAt) : 'an unknown date'}</span>
          </p>
          <div className="mb-3 grid grid-cols-3 gap-2">
            {stat(pending.data.equipment.length, 'Assets')}
            {stat(pending.data.inspectionPoints.length, 'Params')}
            {stat(pending.data.readings.length, 'Readings')}
          </div>
          {pending.warnings.length > 0 && (
            <ul className="mb-3 space-y-1 rounded-lg bg-amber-400/10 p-2.5 text-xs text-amber-300 ring-1 ring-amber-400/50">
              {pending.warnings.map((w) => <li key={w} className="flex gap-1.5"><AlertTriangle size={13} className="mt-0.5 shrink-0" /> {w}</li>)}
            </ul>
          )}
          <div className="mb-3 grid gap-2" role="radiogroup" aria-label="Restore mode">
            {[
              ['merge', 'Merge / Add Missing', 'Recommended. Keeps everything on this device and adds whatever the backup has that’s missing.'],
              ['replace', 'Replace All Data (clean restore)', 'Erases this device’s data and makes it an exact copy of the backup, IDs and timestamps included.'],
            ].map(([v, title, desc]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={mode === v}
                onClick={() => { setMode(v); setConfirmArmed(false); }}
                className={cx(
                  'flex min-h-[56px] w-full items-start gap-3 rounded-xl border-2 p-3 text-left',
                  mode === v ? (v === 'replace' ? 'border-red-500 bg-red-500/10' : 'border-emerald-500 bg-emerald-500/10') : 'border-zinc-700 active:bg-zinc-800',
                )}
              >
                <span className={cx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2', mode === v ? (v === 'replace' ? 'border-red-400' : 'border-emerald-400') : 'border-zinc-500')}>
                  {mode === v && <span className={cx('h-2.5 w-2.5 rounded-full', v === 'replace' ? 'bg-red-400' : 'bg-emerald-400')} />}
                </span>
                <span>
                  <span className="block text-sm font-black uppercase tracking-wide text-white">{title}</span>
                  <span className="block text-xs text-zinc-400">{desc}</span>
                </span>
              </button>
            ))}
          </div>

          {mode === 'merge' && plan && (
            <div className="mb-3 rounded-lg bg-zinc-950 p-3 text-sm ring-1 ring-zinc-800">
              {plan.newEquipment.length + plan.newPoints.length + plan.newReadings.length === 0 ? (
                <p className="font-bold text-emerald-400">Everything in this backup is already on this device. Nothing to add.</p>
              ) : (
                <p className="text-zinc-300">
                  Will add <span className="font-bold text-emerald-400">
                    {plural(plan.newEquipment.length, 'asset')}, {plural(plan.newPoints.length, 'parameter')}, {plural(plan.newReadings.length, 'reading')}
                  </span>.
                </p>
              )}
              {(plan.matched.equipment > 0 || plan.matched.readings > 0) && (
                <p className="mt-1 text-xs text-zinc-500">
                  Already here (skipped): {plural(plan.matched.equipment, 'asset')} matched by tag and place in the tree, {plural(plan.matched.inspectionPoints, 'parameter')}, {plural(plan.matched.readings, 'duplicate reading')}.
                  Matched assets and parameters keep this device’s names and limits.
                </p>
              )}
            </div>
          )}
          {mode === 'merge' && plan && plan.conflicts.length > 0 && (
            <div className="mb-3 rounded-lg bg-amber-400/10 p-3 text-xs text-amber-300 ring-1 ring-amber-400/50">
              <p className="mb-1.5 flex items-start gap-1.5 font-bold">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                {plural(plan.conflicts.length, 'asset')} in the backup {plan.conflicts.length === 1 ? 'uses a tag' : 'use tags'} that belong to a different asset here. {plan.conflicts.length === 1 ? 'It' : 'They'}’ll be added separately with a new tag, so no readings get mixed up:
              </p>
              <ul className="space-y-0.5 font-mono">
                {plan.conflicts.slice(0, 5).map((c) => (
                  <li key={c.to} className="truncate">
                    {c.from} → {c.to} <span className="font-sans text-amber-200/70">({[...c.path, c.name].join(' › ')})</span>
                  </li>
                ))}
                {plan.conflicts.length > 5 && <li className="font-sans">…and {plan.conflicts.length - 5} more</li>}
              </ul>
            </div>
          )}
          {mode === 'replace' && (
            <p className="mb-3 text-sm text-zinc-300">
              <span className="font-bold text-red-400">Replaces everything on this device</span> ({plural(counts.equipment, 'asset')}, {plural(counts.readings, 'reading')}) with this backup.
              Export a backup of the current data first if you might need it.
            </p>
          )}

          <button
            type="button"
            onClick={restore}
            disabled={busy || (mode === 'merge' && plan && plan.newEquipment.length + plan.newPoints.length + plan.newReadings.length === 0)}
            className={cx(
              'flex h-14 w-full items-center justify-center gap-2 rounded-xl text-base font-black uppercase tracking-wider disabled:opacity-50',
              mode === 'merge'
                ? 'bg-emerald-500 text-zinc-950 active:bg-emerald-400'
                : confirmArmed ? 'bg-red-600 text-white active:bg-red-500' : 'bg-zinc-800 text-white ring-2 ring-red-500/60 active:bg-zinc-700',
            )}
          >
            {mode === 'merge' ? <Upload size={20} strokeWidth={2.5} /> : <RotateCcw size={20} />}
            {busy
              ? (mode === 'merge' ? 'Merging…' : 'Restoring…')
              : mode === 'merge' ? 'Merge backup' : confirmArmed ? 'Tap again to replace all data' : 'Replace with this backup'}
          </button>
          {confirmArmed && !busy && (
            <button type="button" onClick={() => setConfirmArmed(false)} className="mt-1 h-12 w-full text-sm font-bold uppercase tracking-wider text-zinc-400">
              Cancel
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ---------- Asset hierarchy helpers & components ---------- */

const pathLabel = (path) => path.map((a) => a.name).join(' › ');

// Press-and-hold (or right-click) without breaking normal taps or scrolling.
// Press-and-hold (or right-click) without breaking normal taps or scrolling.
// Motion: the card sinks slightly while held, then springs back with a small bounce as the menu opens.
const MENU_OPEN_DELAY_MS = 110; // let the bounce start before the menu slides over it

function useLongPress(onLongPress, targetRef, ms = 500) {
  const timer = useRef(null);
  const start = useRef(null);
  const fired = useRef(false);
  const pressAnim = useRef(null);
  const clear = () => {
    clearTimeout(timer.current);
    timer.current = null;
  };
  // Release without triggering: ease back to normal size.
  const settle = () => {
    const anim = pressAnim.current;
    pressAnim.current = null;
    if (!anim) return;
    const el = targetRef && targetRef.current;
    let current = 'scale(1)';
    try {
      current = getComputedStyle(el).transform;
    } catch {
      /* noop */
    }
    anim.cancel();
    animateEl(el, [{ transform: current === 'none' ? 'scale(1)' : current }, { transform: 'scale(1)' }], { duration: 160, easing: 'ease-out' });
  };
  const bounce = () => {
    const el = targetRef && targetRef.current;
    if (pressAnim.current) {
      pressAnim.current.cancel();
      pressAnim.current = null;
    }
    animateEl(
      el,
      [
        { transform: 'scale(0.965)' },
        { transform: 'scale(1.035)', offset: 0.45 },
        { transform: 'scale(0.995)', offset: 0.75 },
        { transform: 'scale(1)' },
      ],
      { duration: 420, easing: 'ease-out' },
    );
  };
  const trigger = () => {
    fired.current = true;
    try {
      if (navigator.vibrate) navigator.vibrate(12);
    } catch {
      /* no haptics */
    }
    bounce();
    if (prefersReducedMotion()) onLongPress();
    else setTimeout(onLongPress, MENU_OPEN_DELAY_MS);
  };
  useEffect(() => clear, []);
  if (!onLongPress) return { handlers: {}, consumeClick: () => false };
  const cancel = () => {
    clear();
    if (!fired.current) settle();
  };
  const handlers = {
    onPointerDown: (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      clear();
      // Slowly sink while held, so the user can see the hold registering.
      pressAnim.current = animateEl(
        targetRef && targetRef.current,
        [{ transform: 'scale(1)' }, { transform: 'scale(0.965)' }],
        { duration: ms, easing: 'cubic-bezier(0.2, 0, 0.4, 1)', fill: 'forwards' },
      );
      timer.current = setTimeout(() => {
        timer.current = null;
        trigger();
      }, ms);
    },
    onPointerMove: (e) => {
      if (!start.current || !timer.current) return;
      if (Math.abs(e.clientX - start.current.x) > 10 || Math.abs(e.clientY - start.current.y) > 10) cancel(); // scrolling
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e) => {
      e.preventDefault();
      if (!fired.current) {
        clear();
        trigger();
      }
    },
  };
  // A long press must not also count as a tap.
  const consumeClick = () => {
    if (fired.current) {
      fired.current = false;
      return true;
    }
    return false;
  };
  return { handlers, consumeClick };
}

function AssetMenu({ asset, path, archived, onClose, onOpen, onEdit, onArchive, onUnarchive, onDelete }) {
  const item = 'flex h-14 w-full items-center gap-3 rounded-xl px-4 text-left text-base font-bold active:bg-zinc-800';
  return (
    <Modal title="Asset" onClose={onClose}>
      <div className="mb-3 rounded-xl bg-zinc-950 px-4 py-3 ring-1 ring-zinc-800">
        {path.length > 0 && <p className="truncate text-[11px] font-bold uppercase tracking-wider text-zinc-500">{pathLabel(path)} ›</p>}
        <p className="text-lg font-black leading-tight text-white">{asset.name}</p>
        <p className="font-mono text-xs text-zinc-400">{asset.identifier}</p>
      </div>
      <div className="space-y-1">
        <button type="button" onClick={onOpen} className={cx(item, 'text-white')}><ChevronRight size={22} /> Open</button>
        <button type="button" onClick={onEdit} className={cx(item, 'text-white')}><Pencil size={20} /> Edit or move</button>
        {archived ? (
          <button type="button" onClick={onUnarchive} className={cx(item, 'text-emerald-400')}><ArchiveRestore size={21} /> Restore from archive</button>
        ) : (
          <button type="button" onClick={onArchive} className={cx(item, 'text-amber-300')}>
            <Archive size={21} />
            <span>
              Archive
              <span className="block text-xs font-semibold text-zinc-500">Hide from lists and alerts · keeps all readings</span>
            </span>
          </button>
        )}
        <button type="button" onClick={onDelete} className={cx(item, 'text-red-400')}><Trash2 size={20} /> Delete…</button>
      </div>
    </Modal>
  );
}

const MAX_ISSUE_LINES = 4;

function AssetCard({ asset, status, path, tree, onOpen, onOpenAsset, onLongPress, archived }) {
  const cardRef = useRef(null);
  const { handlers, consumeClick } = useLongPress(onLongPress, cardRef);
  const parts = [];
  if (status.childCount) parts.push(plural(status.childCount, 'sub-asset'));
  parts.push(`${status.pointCount} param${status.pointCount === 1 ? '' : 's'}`);
  if (status.lastAt) parts.push(timeAgo(status.lastAt));
  const issues = status.issues || [];
  // Path from this card's asset down to the asset holding the drifted parameter.
  const relPath = (assetId) => {
    if (assetId === asset.id) return [];
    const target = tree.byId.get(assetId);
    if (!target) return [];
    const full = [...tree.pathOf(target), target];
    const k = full.findIndex((a) => a.id === asset.id);
    return full.slice(k + 1);
  };
  return (
    <div
      ref={cardRef}
      className={cx(
        'w-full overflow-hidden rounded-2xl border-2 bg-zinc-900',
        archived ? 'border-zinc-800' : status.kind === 'alarm' ? 'border-red-500/60' : status.kind === 'warn' ? 'border-amber-400/60' : status.kind === 'ok' ? 'border-zinc-700' : 'border-zinc-800',
      )}
    >
      <button
        type="button"
        onClick={() => { if (!consumeClick()) onOpen(); }}
        {...handlers}
        style={{ WebkitTouchCallout: 'none' }}
        className={cx('block w-full select-none p-4 text-left transition-transform active:scale-[0.99] active:bg-zinc-800', archived && 'opacity-60')}
        aria-description={onLongPress ? 'Press and hold for more options' : undefined}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {path && path.length > 0 && (
              <p className="mb-1 truncate text-[11px] font-bold uppercase tracking-wider text-zinc-500">{pathLabel(path)} ›</p>
            )}
            <h2 className="text-lg font-black leading-tight text-white">{asset.name}</h2>
            <p className="mt-1.5 flex items-center gap-1.5 text-sm text-zinc-400"><MapPin size={15} className="shrink-0" /> {asset.location}</p>
            <p className="mt-1 flex items-center gap-1.5 font-mono text-sm text-zinc-400"><Tag size={15} className="shrink-0" /> {asset.identifier}</p>
          </div>
          <ChevronRight className="mt-1 shrink-0 text-zinc-500" size={26} />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          {archived ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs font-black uppercase tracking-wider text-zinc-400 ring-1 ring-zinc-600">
              <Archive size={14} /> Archived
            </span>
          ) : (
            <AssetStatusBadge status={status} />
          )}
          <span className="text-xs font-semibold text-zinc-500">{archived && asset.archivedAt ? `archived ${timeAgo(asset.archivedAt)}` : parts.join(' · ')}</span>
        </div>
      </button>

      {!archived && issues.length > 0 && (
        <div className="space-y-1.5 border-t-2 border-zinc-800 px-3 pb-3 pt-2">
          {issues.slice(0, MAX_ISSUE_LINES).map((it) => {
            const rel = relPath(it.assetId);
            const dp = decimalsFor(it.point);
            const isAlarm = it.sev === 'alarm';
            return (
              <button
                key={it.point.id}
                type="button"
                onClick={() => onOpenAsset(it.assetId)}
                aria-label={`Open ${rel.length ? rel[rel.length - 1].name : asset.name}: ${it.point.label} ${SEV[it.sev].label}`}
                className={cx(
                  'flex min-h-[48px] w-full items-center gap-2.5 rounded-xl px-3 py-1.5 text-left ring-1',
                  isAlarm ? 'bg-red-500/10 ring-red-500/50 active:bg-red-500/15' : 'bg-amber-400/10 ring-amber-400/50 active:bg-amber-400/15',
                )}
              >
                {isAlarm
                  ? <AlertOctagon size={20} strokeWidth={2.5} className="shrink-0 text-red-400" />
                  : <AlertTriangle size={20} strokeWidth={2.5} className="shrink-0 text-amber-400" />}
                <span className="min-w-0 flex-1">
                  <span className={cx('block truncate text-sm font-black', isAlarm ? 'text-red-400' : 'text-amber-300')}>
                    {rel.length ? pathLabel(rel) : it.point.label}
                  </span>
                  <span className="block truncate font-mono text-xs text-zinc-300">
                    {rel.length ? `${it.point.label} · ` : ''}{fmtV(it.value, dp)} {it.point.unit} · {isAlarm ? 'ALARM' : 'WARN'}
                  </span>
                </span>
                <ChevronRight size={20} className="shrink-0 text-zinc-500" />
              </button>
            );
          })}
          {issues.length > MAX_ISSUE_LINES && (
            <button
              type="button"
              onClick={onOpen}
              className="flex h-11 w-full items-center justify-center text-xs font-black uppercase tracking-wider text-zinc-400 active:text-white"
            >
              + {issues.length - MAX_ISSUE_LINES} more out of spec
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const selectCls =
  'h-14 w-full appearance-none rounded-xl border-2 border-zinc-700 bg-zinc-950 px-4 text-base text-white ' +
  'focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30';

function AssetModal({ initial, parent, assets, tree, pointsByEquipment, onClose, onSubmit, onDelete }) {
  const editing = Boolean(initial);
  const [form, setForm] = useState(() => ({
    name: initial ? initial.name : '',
    location: initial ? initial.location : parent ? parent.location : '',
    identifier: initial ? initial.identifier : parent ? `${parent.identifier}-` : '',
    parentId: initial ? (initial.parentId ?? '') : parent ? parent.id : '',
    qty: '1',
    start: '1',
    copyFrom: '',
  }));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const blocked = useMemo(() => {
    if (!initial) return new Set();
    return new Set([initial.id, ...tree.descendants(initial.id).map((d) => d.id)]);
  }, [initial, tree]);
  const parentOptions = useMemo(
    () => assets
      .filter((a) => !blocked.has(a.id) && !tree.isArchived(a))
      .map((a) => ({ id: a.id, label: pathLabel([...tree.pathOf(a), a]) }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    [assets, blocked, tree],
  );
  const templates = useMemo(
    () => assets
      .filter((a) => (pointsByEquipment.get(a.id) || []).length > 0)
      .map((a) => ({ id: a.id, n: pointsByEquipment.get(a.id).length, label: pathLabel([...tree.pathOf(a), a]) }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    [assets, pointsByEquipment, tree],
  );

  const qty = editing ? 1 : parseInt(form.qty, 10);
  const start = parseInt(form.start, 10);
  const multi = Number.isInteger(qty) && qty > 1;
  const baseName = form.name.trim();
  const baseTag = form.identifier.trim().toUpperCase().replace(/-+$/, '');
  const items = (() => {
    if (!multi) return [{ name: baseName, identifier: baseTag }];
    if (!Number.isInteger(start) || start < 0) return [];
    const width = Math.max(2, String(start + qty - 1).length);
    return Array.from({ length: qty }, (_, i) => ({
      name: `${baseName} ${start + i}`,
      identifier: `${baseTag}-${String(start + i).padStart(width, '0')}`,
    }));
  })();

  const submit = async (e) => {
    e.preventDefault();
    const location = form.location.trim();
    const errs = {};
    if (!baseName) errs.name = 'Asset name is required';
    if (!location) errs.location = 'Location is required';
    if (!baseTag) errs.identifier = 'Serial / tag is required';
    if (!editing) {
      if (!Number.isInteger(qty) || qty < 1 || qty > 50) errs.qty = 'Enter 1 to 50';
      if (multi && (!Number.isInteger(start) || start < 0)) errs.start = 'Enter a whole number';
    }
    if (!errs.identifier && !errs.qty && !errs.start) {
      const taken = new Set(assets.filter((a) => !initial || a.id !== initial.id).map((a) => a.identifier.toUpperCase()));
      const clash = items.find((it) => taken.has(it.identifier));
      if (clash) errs.identifier = `Tag ${clash.identifier} is already in use`;
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    const parentId = form.parentId === '' ? null : Number(form.parentId);
    try {
      if (editing) {
        await onSubmit({ name: baseName, location, identifier: baseTag, parentId });
      } else {
        await onSubmit({
          items: items.map((it) => ({ ...it, location })),
          parentId,
          copyFrom: form.copyFrom === '' ? null : Number(form.copyFrom),
        });
      }
    } catch {
      setErrors({ form: 'Could not save. Try again.' });
      setSaving(false);
    }
  };

  const title = editing ? 'Edit Asset' : parent ? 'New Sub-Asset' : 'New Asset';
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {!editing && parent && (
          <p className="mb-4 rounded-xl bg-zinc-800 px-4 py-3 text-sm text-zinc-300">
            Inside <span className="font-bold text-white">{pathLabel([...tree.pathOf(parent), parent])}</span>
          </p>
        )}
        <Field label={multi ? 'Base Name' : 'Asset Name'} error={errors.name} hint={multi ? 'A number is added to each, e.g. “Battery 1”' : null}>
          <input className={inputCls} value={form.name} onChange={set('name')} placeholder={parent ? 'e.g. Battery' : 'e.g. Grade Crossing House'} autoFocus />
        </Field>
        <Field label="Location" error={errors.location}>
          <input className={inputCls} value={form.location} onChange={set('location')} placeholder="e.g. MP 112.4, Main St" />
        </Field>
        <Field label={multi ? 'Base Tag' : 'Serial / Tag ID'} error={errors.identifier} hint={multi ? 'Each gets -01, -02… added' : null}>
          <input className={cx(inputCls, 'font-mono uppercase')} value={form.identifier} onChange={set('identifier')} placeholder="e.g. XH-112-BAT" autoCapitalize="characters" />
        </Field>

        {!editing && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="How many" error={errors.qty}>
              <input className={cx(inputCls, 'font-mono')} value={form.qty} onChange={set('qty')} inputMode="numeric" placeholder="1" />
            </Field>
            {multi && (
              <Field label="Start numbering at" error={errors.start}>
                <input className={cx(inputCls, 'font-mono')} value={form.start} onChange={set('start')} inputMode="numeric" placeholder="1" />
              </Field>
            )}
          </div>
        )}
        {multi && items.length > 0 && baseName && baseTag && (
          <div className="mb-4 rounded-xl border border-dashed border-zinc-700 px-4 py-3 font-mono text-xs text-zinc-300">
            {items[0].name} ({items[0].identifier})
            {items.length > 2 && <span className="block text-zinc-500">… {items.length - 2} more …</span>}
            {items.length > 1 && <span className="block">{items[items.length - 1].name} ({items[items.length - 1].identifier})</span>}
          </div>
        )}

        <Field label={editing ? 'Located inside' : 'Create inside'}>
          <select className={selectCls} value={form.parentId} onChange={set('parentId')}>
            <option value="">— Top level (no parent) —</option>
            {parentOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </Field>

        {!editing && (
          <Field label="Copy parameters from (optional)" hint="Copies labels, units, targets and zones. Readings are not copied.">
            <select className={selectCls} value={form.copyFrom} onChange={set('copyFrom')}>
              <option value="">— None —</option>
              {templates.map((o) => <option key={o.id} value={o.id}>{o.label} ({o.n} param{o.n === 1 ? '' : 's'})</option>)}
            </select>
          </Field>
        )}

        {errors.form && <p className="mb-3 text-sm font-semibold text-red-400">{errors.form}</p>}
        <PrimaryButton type="submit" disabled={saving}>
          {editing ? <Pencil size={20} strokeWidth={2.5} /> : <Plus size={22} strokeWidth={3} />}{' '}
          {saving ? 'Saving…' : editing ? 'Save Changes' : multi ? `Create ${qty} Assets` : 'Create Asset'}
        </PrimaryButton>
        {editing && onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl border-2 border-red-500/50 text-sm font-black uppercase tracking-wider text-red-400 active:bg-red-500/10"
          >
            <Trash2 size={18} /> Delete Asset
          </button>
        )}
      </form>
    </Modal>
  );
}

function DeleteAssetModal({ asset, counts, onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Delete Asset" onClose={onClose}>
      <p className="mb-2 text-base leading-relaxed text-zinc-300">
        Delete <span className="font-bold text-white">{asset.name}</span> ({asset.identifier})?
      </p>
      <p className="mb-5 text-base leading-relaxed text-zinc-300">
        This permanently erases{' '}
        <span className="font-bold text-red-400">
          {[counts.subs ? plural(counts.subs, 'sub-asset') : null, plural(counts.points, 'parameter'), plural(counts.readings, 'reading')]
            .filter(Boolean)
            .join(', ')}
        </span>
        . Export any CSVs you need first. This cannot be undone.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <button type="button" onClick={onClose} className="h-14 rounded-xl border-2 border-zinc-700 text-lg font-bold uppercase text-zinc-200 active:bg-zinc-800">
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const ok = await onConfirm();
            if (!ok) setBusy(false);
          }}
          className="flex h-14 items-center justify-center gap-2 rounded-xl bg-red-600 text-lg font-black uppercase text-white active:bg-red-500 disabled:opacity-50"
        >
          <Trash2 size={20} /> {busy ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </Modal>
  );
}

/* ---------- Search ----------
   Every word in the query must match somewhere in the asset's own name / tag / location
   or in any asset above it (its parent house, bank, etc.). Ranked by how close the matches are. */
const normText = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function searchAssets(equipment, tree, query) {
  const tokens = normText(query).split(' ').filter(Boolean);
  if (!tokens.length) return [];
  const fullQuery = tokens.join(' ');
  const field = (text) => {
    const n = normText(text);
    return { n, padded: ` ${n}`, compact: n.replace(/ /g, '') };
  };
  // Points for one word against one field: substring match, +1 if it starts a word, ignoring spaces as a fallback.
  const scoreIn = (f, t, weight) => {
    if (f.n.includes(t)) return weight + (f.padded.includes(` ${t}`) ? 1 : 0);
    if (f.compact.includes(t)) return weight;
    return 0;
  };
  const out = [];
  for (const e of equipment) {
    const ancestors = tree.pathOf(e);
    const own = { name: field(e.name), tag: field(e.identifier), loc: field(e.location) };
    const above = field(ancestors.map((a) => `${a.name} ${a.identifier} ${a.location}`).join(' '));
    // Words spanning the whole line (e.g. "1300s" against "1300 S Redwood Rd").
    const all = field(`${ancestors.map((a) => `${a.name} ${a.identifier} ${a.location}`).join(' ')} ${e.name} ${e.identifier} ${e.location}`);
    let score = 0;
    let ok = true;
    for (const t of tokens) {
      const best = Math.max(scoreIn(own.name, t, 6), scoreIn(own.tag, t, 6), scoreIn(own.loc, t, 3), scoreIn(above, t, 1), all.compact.includes(t) ? 1 : 0);
      if (!best) { ok = false; break; }
      score += best;
    }
    if (!ok) continue;
    if (own.name.n === fullQuery || own.tag.n === fullQuery) score += 10;
    else if (own.name.n.startsWith(fullQuery)) score += 4;
    out.push({ asset: e, score, depth: ancestors.length });
  }
  return out.sort((a, b) =>
    b.score - a.score || a.depth - b.depth || a.asset.name.localeCompare(b.asset.name, undefined, { numeric: true }));
}

function HomeScreen({ data, tree, statusById, onOpenAsset, onNewAsset, onReset, onBackup, onAssetMenu, storageKind }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const rank = (a, b) =>
    (statusById.get(b.id).kind === 'alarm') - (statusById.get(a.id).kind === 'alarm') ||
    isAttention(statusById.get(b.id).kind) - isAttention(statusById.get(a.id).kind) ||
    a.name.localeCompare(b.name, undefined, { numeric: true });
  const topLevel = useMemo(() => [...(tree.live.get(null) || [])].sort(rank), [tree, statusById]); // eslint-disable-line react-hooks/exhaustive-deps
  const archivedList = useMemo(
    () => data.equipment.filter((e) => e.archivedAt).sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt))),
    [data.equipment],
  );
  const [showArchived, setShowArchived] = useState(false);
  const results = useMemo(() => {
    if (!needle) return null;
    return searchAssets(data.equipment.filter((e) => !tree.isArchived(e)), tree, q).map((r) => r.asset);
  }, [data.equipment, tree, q, needle]);
  const list = results || topLevel;
  const warnCount = topLevel.filter((e) => isAttention(statusById.get(e.id).kind)).length;

  return (
    <div className="flex min-h-screen flex-col">
      <div className="sticky top-[var(--sat,0px)] z-20 border-b-2 border-zinc-800 bg-zinc-950/95 px-4 pb-4 pt-4 backdrop-blur">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-zinc-950 min-[380px]:flex">
              <Gauge size={26} strokeWidth={2.5} />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-black leading-none tracking-tight">InSpec</h1>
              <p className="mt-1 text-[10px] font-bold uppercase leading-tight tracking-wider text-zinc-500">Asset Maintenance</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onBackup}
              aria-label="Data & Backup"
              title="Data & Backup"
              className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-zinc-200 active:bg-zinc-700"
            >
              <DiskIcon size={23} strokeWidth={1.9} />
              {!readLastBackup() && data.equipment.length > 0 && (
                <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-zinc-950" aria-hidden="true" />
              )}
            </button>
            <ThemeToggle />
            <PrimaryButton type="button" onClick={onNewAsset} className="!w-auto !h-12 !gap-1 !px-3 !text-sm" aria-label="New Asset">
              <Plus size={20} strokeWidth={3} /> New<span className="sr-only"> Asset</span>
            </PrimaryButton>
          </div>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" size={22} />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, tag or location — e.g. 1300 S B12"
            className={cx(inputCls, 'pl-12 pr-12')}
            aria-label="Search assets"
          />
          {q && (
            <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="absolute right-1 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center text-zinc-400">
              <X size={20} />
            </button>
          )}
        </div>
        <div className="mt-3 flex items-center gap-4 text-xs font-bold uppercase tracking-wider">
          <span className="text-zinc-400">
            {results
              ? `${results.length} match${results.length === 1 ? '' : 'es'}`
              : `${topLevel.length} asset${topLevel.length === 1 ? '' : 's'}${data.equipment.length > topLevel.length ? ` · ${data.equipment.length} total` : ''}`}
          </span>
          {!results && (warnCount > 0 ? (
            <span className="flex items-center gap-1 text-red-400"><AlertTriangle size={14} /> {warnCount} need attention</span>
          ) : (
            topLevel.length > 0 && <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 size={14} /> Fleet nominal</span>
          ))}
        </div>
      </div>

      <main className="flex-1 space-y-3 px-4 py-4">
        {list.length === 0 && (
          <div className="rounded-2xl border-2 border-dashed border-zinc-700 p-8 text-center text-zinc-400">
            <Wrench className="mx-auto mb-3 text-zinc-600" size={36} />
            {q ? <>No assets match “{q}”.</> : <>No assets yet. Tap <span className="font-bold text-white">New Asset</span> to add one.</>}
          </div>
        )}
        {list.map((e) => (
          <AssetCard key={e.id} asset={e} status={statusById.get(e.id)} path={results ? tree.pathOf(e) : null} tree={tree} onOpen={() => onOpenAsset(e.id)} onOpenAsset={onOpenAsset} onLongPress={() => onAssetMenu(e.id)} />
        ))}
        {!results && topLevel.length > 0 && (
          <p className="pt-1 text-center text-xs text-zinc-600">Press and hold an asset for archive, edit and delete</p>
        )}
        {!results && archivedList.length > 0 && (
          <section className="pt-3">
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              aria-expanded={showArchived}
              className="flex h-12 w-full items-center justify-between rounded-xl px-1 text-xs font-black uppercase tracking-widest text-zinc-400 active:text-white"
            >
              <span className="flex items-center gap-2"><Archive size={16} /> Archived · {archivedList.length}</span>
              <ChevronDown size={20} className={cx('transition-transform', showArchived && 'rotate-180')} />
            </button>
            {showArchived && (
              <div className="space-y-3">
                {archivedList.map((e) => (
                  <AssetCard key={e.id} asset={e} status={statusById.get(e.id)} path={tree.pathOf(e)} tree={tree} archived onOpen={() => onAssetMenu(e.id)} onOpenAsset={onOpenAsset} onLongPress={() => onAssetMenu(e.id)} />
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="border-t-2 border-zinc-800 px-4 py-5">
        <div className="mb-3 flex items-center justify-center gap-1.5 text-xs font-semibold text-zinc-500">
          <Database size={14} />
          {storageKind === 'indexeddb' && 'Saved on this device (IndexedDB)'}
          {storageKind === 'localstorage' && 'Saved on this device (localStorage fallback)'}
          {storageKind === 'memory' && 'Storage blocked here — data lasts until you close this page'}
        </div>
        <button
          type="button"
          onClick={onBackup}
          className="mb-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl border-2 border-zinc-700 text-sm font-bold uppercase tracking-wider text-zinc-300 active:bg-zinc-800"
        >
          <DiskIcon size={18} strokeWidth={1.9} /> Data &amp; Backup{' '}
          <span className="font-semibold normal-case tracking-normal text-zinc-500">
            · {readLastBackup() ? `last ${relativeDays(readLastBackup())}` : 'never backed up'}
          </span>
        </button>
        <button
          type="button"
          onClick={onReset}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border-2 border-zinc-700 text-sm font-bold uppercase tracking-wider text-zinc-300 active:bg-zinc-800"
        >
          <RotateCcw size={18} /> Reset Demo Data
        </button>
      </footer>
    </div>
  );
}

/* ============================================================
   Screen 2: Asset inspection & rapid log
   ============================================================ */

function Sparkline({ point, readings }) {
  const C = useChart();
  const { min, max } = limits(point);
  const last = readings.slice(-5);
  if (!last.length) {
    return (
      <div className="flex h-20 items-center justify-center rounded-xl border border-dashed border-zinc-700 text-sm text-zinc-500">
        No readings yet — log the first one below
      </div>
    );
  }
  const chartData = last.map((r, i) => ({ i, value: r.value, sev: r.sev }));
  const alarmOn = hasAlarm(point);
  const { amin, amax } = alarmOn ? alarmLimits(point) : { amin: min, amax: max };
  const domain = chartDomain(last.map((r) => r.value), amin, amax);
  return (
    <div className="h-20 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 8, right: 10, bottom: 8, left: 10 }}>
          <XAxis dataKey="i" hide type="number" domain={[0, Math.max(1, chartData.length - 1)]} />
          <YAxis hide domain={domain} />
          {alarmOn && <ReferenceArea y1={amin} y2={min} fill={C.warn} fillOpacity={0.16} ifOverflow="extendDomain" />}
          {alarmOn && <ReferenceArea y1={max} y2={amax} fill={C.warn} fillOpacity={0.16} ifOverflow="extendDomain" />}
          <ReferenceArea y1={min} y2={max} fill={C.ok} fillOpacity={0.14} stroke={C.ok} strokeOpacity={0.35} strokeDasharray="3 3" ifOverflow="extendDomain" />
          <ReferenceLine y={point.targetValue} stroke={C.ok} strokeOpacity={0.5} strokeDasharray="2 4" />
          <Line type="monotone" dataKey="value" stroke={C.line} strokeWidth={2.5} dot={<SpecDot r={3.5} />} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ResultBanner({ point, reading, onDismiss }) {
  const dp = decimalsFor(point);
  const { min, max } = limits(point);
  const v = reading.value;
  const dTarget = v - point.targetValue;
  const sev = reading.sev;
  const above = v > max;
  let body;
  if (sev === 'ok') {
    body = (
      <>
        <p className="flex items-center gap-2 text-base font-black uppercase tracking-wide">
          <CheckCircle2 size={22} strokeWidth={2.5} /> In spec — saved
        </p>
        <p className="mt-1 font-mono text-sm">
          {fmtV(v, dp)} {point.unit} · Δ {signed(dTarget, dp)} from target
        </p>
      </>
    );
  } else {
    const delta = above ? v - max : min - v;
    const alarmOn = hasAlarm(point);
    const { amin, amax } = alarmOn ? alarmLimits(point) : {};
    body = (
      <>
        <p className="flex items-center gap-2 text-base font-black uppercase tracking-wide">
          {sev === 'warn' ? <AlertTriangle size={22} strokeWidth={2.5} /> : <AlertOctagon size={22} strokeWidth={2.5} />}
          {sev === 'warn' ? 'Warning — out of spec' : alarmOn ? 'Alarm — past alarm limit' : 'Out of spec'}
        </p>
        <p className="mt-1 font-mono text-lg font-bold">
          {fmt(delta, dp)} {point.unit} {above ? 'ABOVE MAX' : 'BELOW MIN'} ({fmt(above ? max : min, dp)})
        </p>
        {sev === 'warn' && (
          <p className="mt-0.5 font-mono text-sm">
            {fmt(above ? amax - v : v - amin, dp)} {point.unit} before alarm limit ({fmt(above ? amax : amin, dp)})
          </p>
        )}
        {sev === 'alarm' && alarmOn && (
          <p className="mt-0.5 font-mono text-sm">
            {fmt(above ? v - amax : amin - v, dp)} {point.unit} past alarm limit ({fmt(above ? amax : amin, dp)})
          </p>
        )}
        <p className="mt-0.5 text-sm opacity-80">
          Δ {signed(dTarget, dp)} {point.unit} from target · {sev === 'warn' ? 'monitor closely' : 'take action / escalate'}
        </p>
      </>
    );
  }
  return (
    <div
      role="status"
      className={cx(
        'relative mt-3 rounded-xl border-2 p-3 pr-12',
        sev === 'alarm' ? 'border-red-500 bg-red-500/15 text-red-300'
          : sev === 'warn' ? 'border-amber-400 bg-amber-400/10 text-amber-200'
          : 'border-emerald-500/70 bg-emerald-500/10 text-emerald-300',
      )}
    >
      {body}
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center opacity-70">
        <X size={20} />
      </button>
    </div>
  );
}

function PointCard({ point, readings, onLog, onOpen, onDelete, onEditZones, onEdit }) {
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const dp = decimalsFor(point);
  const { min, max } = limits(point);
  const latest = readings[readings.length - 1];

  const submit = async (e) => {
    e.preventDefault();
    const v = parseNum(value);
    if (!Number.isFinite(v)) {
      setError('Enter a numeric reading');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const saved = await onLog(point, v, note.trim());
      setResult(saved);
      setValue('');
      setNote('');
      setShowNote(false);
    } catch {
      setError('Save failed — reading not stored. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className={cx(
        'rounded-2xl border-2 bg-zinc-900 p-4',
        latest ? SEV[latest.sev].border : 'border-zinc-800',
      )}
    >
      <button type="button" onClick={onOpen} className="block w-full text-left" aria-label={`Open trend for ${point.label}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-black leading-tight text-white">{point.label}</h3>
            <RangeInfo point={point} className="mt-1" />
          </div>
          <div className="shrink-0 text-right">
            {latest ? (
              <>
                <p className={cx('font-mono text-xl font-black leading-none', SEV[latest.sev].text)}>
                  {fmtV(latest.value, dp)}
                </p>
                <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">{point.unit} · {timeAgo(latest.recordedAt)}</p>
              </>
            ) : (
              <p className="text-xs font-bold uppercase text-zinc-500">No data</p>
            )}
          </div>
        </div>
        <div className="mt-2">
          <Sparkline point={point} readings={readings} />
        </div>
        <p className="mt-1 flex items-center justify-end gap-1 text-xs font-bold uppercase tracking-wider text-zinc-500">
          <Activity size={13} /> Trend & audit log <ChevronRight size={14} />
        </p>
      </button>

      <form onSubmit={submit} noValidate className="mt-3">
        <div className="relative">
          <input
            className={cx(inputCls, 'h-16 pr-20 font-mono text-2xl font-bold', error && 'border-red-500')}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError('');
            }}
            inputMode="decimal"
            enterKeyHint="done"
            autoComplete="off"
            placeholder={fmt(point.targetValue, dp)}
            aria-label={`New reading for ${point.label} in ${point.unit}`}
          />
          <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-mono text-base font-bold text-zinc-500">{point.unit}</span>
        </div>
        {error && <p className="mt-1.5 text-sm font-semibold text-red-400">{error}</p>}

        {showNote ? (
          <div className="mt-2">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Quick note (optional) — e.g. noise, leak, adjustment made"
              className="min-h-[56px] w-full rounded-xl border-2 border-zinc-700 bg-zinc-950 p-3 text-base text-white placeholder-zinc-500 focus:border-emerald-500 focus:outline-none"
              autoFocus
            />
            <button type="button" onClick={() => { setShowNote(false); setNote(''); }} className="h-12 text-sm font-bold uppercase tracking-wider text-zinc-400">
              Remove note
            </button>
          </div>
        ) : (
          <div className="mt-1 flex items-center justify-between">
            <button type="button" onClick={() => setShowNote(true)} className="flex h-12 items-center gap-2 text-sm font-bold uppercase tracking-wider text-zinc-400 active:text-white">
              <MessageSquarePlus size={18} /> Add note
            </button>
            <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onEditZones}
              aria-label={`Alarm zone for ${point.label}`}
              className={cx(
                'flex h-12 items-center gap-1.5 rounded-xl px-3 text-xs font-bold uppercase tracking-wider active:bg-zinc-800',
                hasAlarm(point) ? 'text-amber-400' : 'text-zinc-500',
              )}
            >
              <SlidersHorizontal size={18} /> {hasAlarm(point) ? 'Zones' : 'Alarm zone'}
            </button>
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Edit parameter ${point.label}`}
              className="flex h-12 w-12 items-center justify-center rounded-xl text-zinc-400 active:bg-zinc-800 active:text-white"
            >
              <Pencil size={19} />
            </button>
            <button
              type="button"
              onClick={onDelete}
              aria-label={`Delete parameter ${point.label}`}
              className="flex h-12 w-12 items-center justify-center rounded-xl text-zinc-500 active:bg-red-500/15 active:text-red-400"
            >
              <Trash2 size={20} />
            </button>
            </div>
          </div>
        )}

        <PrimaryButton type="submit" disabled={saving} className="h-16 text-xl">
          {saving ? 'Saving…' : 'Log Reading'}
        </PrimaryButton>
      </form>

      {result && readings.some((r) => r.id === result.id) && <ResultBanner point={point} reading={result} onDismiss={() => setResult(null)} />}
    </section>
  );
}

function AssetScreen({
  asset, path, subAssets, statusById, tree, points, readingsByPoint, onBack, onHome, onOpenAsset, archived, archivedSelf, onUnarchive, onAssetMenu, onAddSubAsset, onAddPoint, onLog,
  onOpenPoint, onDeletePoint, onEditZones, onEditAsset, onEditPoint,
}) {
  const latestSev = points.map((p) => {
    const rs = readingsByPoint.get(p.id) || [];
    return rs.length ? rs[rs.length - 1].sev : null;
  });
  const alarmN = latestSev.filter((x) => x === 'alarm').length;
  const warnN = latestSev.filter((x) => x === 'warn').length;
  const parent = path[path.length - 1];
  const sectionCls = 'flex items-center justify-between pt-1 text-xs font-black uppercase tracking-widest text-zinc-400';
  return (
    <div className="min-h-screen">
      <header className="sticky top-[var(--sat,0px)] z-20 border-b-2 border-zinc-800 bg-zinc-950/95 px-4 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            aria-label={parent ? `Back to ${parent.name}` : 'Back to directory'}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-zinc-800 active:bg-zinc-700"
          >
            <ChevronLeft size={30} strokeWidth={3} />
          </button>
          <HomeButton onHome={onHome} />
          <div className="flex-1" />
          <button
            type="button"
            onClick={onEditAsset}
            aria-label={`Edit asset ${asset.name}`}
            title="Edit"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-zinc-200 active:bg-zinc-700"
          >
            <Pencil size={20} strokeWidth={2.25} />
          </button>
          <ThemeToggle />
        </div>
      </header>

      <div className="border-b-2 border-zinc-800 px-4 pb-4 pt-3">
        {path.length > 0 && (
          <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">{pathLabel(path)} ›</p>
        )}
        <h1 className="break-words text-xl font-black leading-tight">{asset.name}</h1>
        <p className="mt-1 text-sm text-zinc-400">
          <MapPin size={14} className="mr-1 inline -translate-y-px" />{asset.location} · <span className="whitespace-nowrap font-mono">{asset.identifier}</span>
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onAddSubAsset}
            className="flex h-12 items-center justify-center gap-1.5 rounded-xl border-2 border-zinc-600 text-sm font-black uppercase tracking-wider text-zinc-200 active:bg-zinc-800"
          >
            <Plus size={18} strokeWidth={3} /> Sub-Asset
          </button>
          <button
            type="button"
            onClick={onAddPoint}
            className="flex h-12 items-center justify-center gap-1.5 rounded-xl border-2 border-emerald-500/70 text-sm font-black uppercase tracking-wider text-emerald-400 active:bg-emerald-500/10"
          >
            <Plus size={18} strokeWidth={3} /> Parameter
          </button>
        </div>
      </div>

      <main className="space-y-4 px-4 py-4">
        {archived && (
          <div className="flex items-center gap-3 rounded-xl bg-zinc-800 p-3 ring-1 ring-zinc-600">
            <Archive size={20} className="shrink-0 text-zinc-300" />
            <p className="min-w-0 flex-1 text-sm text-zinc-300">
              {archivedSelf ? 'This asset is archived.' : 'This asset is inside an archived asset.'} It's hidden from lists and alerts; readings are kept.
            </p>
            {archivedSelf && (
              <button type="button" onClick={onUnarchive} className="h-12 shrink-0 rounded-xl bg-emerald-500 px-3 text-xs font-black uppercase tracking-wider text-zinc-950 active:bg-emerald-400">
                Restore
              </button>
            )}
          </div>
        )}
        {alarmN > 0 && (
          <div className="flex items-center gap-2 rounded-xl bg-red-500/15 px-4 py-3 text-sm font-black uppercase tracking-wide text-red-400 ring-2 ring-red-500/60">
            <AlertOctagon size={20} /> {plural(alarmN, 'parameter')} in alarm on latest reading
          </div>
        )}
        {warnN > 0 && (
          <div className="flex items-center gap-2 rounded-xl bg-amber-400/15 px-4 py-3 text-sm font-black uppercase tracking-wide text-amber-300 ring-2 ring-amber-400/60">
            <AlertTriangle size={20} /> {plural(warnN, 'parameter')} in warning zone
          </div>
        )}

        {subAssets.length > 0 && (
          <section className="space-y-3">
            <h2 className={sectionCls}>Sub-assets · {subAssets.length}</h2>
            {subAssets.map((e) => (
              <AssetCard key={e.id} asset={e} status={statusById.get(e.id)} tree={tree} onOpen={() => onOpenAsset(e.id)} onOpenAsset={onOpenAsset} onLongPress={() => onAssetMenu(e.id)} />
            ))}
          </section>
        )}

        {subAssets.length > 0 && points.length > 0 && <h2 className={sectionCls}>Parameters · {points.length}</h2>}
        {points.length === 0 && subAssets.length === 0 && (
          <div className="rounded-2xl border-2 border-dashed border-zinc-700 p-8 text-center text-zinc-400">
            Nothing here yet. Tap <span className="font-bold text-white">Parameter</span> to define what you measure on this asset, or{' '}
            <span className="font-bold text-white">Sub-Asset</span> to add equipment inside it.
          </div>
        )}
        {points.map((p) => (
          <PointCard key={p.id} point={p} readings={readingsByPoint.get(p.id) || []} onLog={onLog} onOpen={() => onOpenPoint(p.id)} onDelete={() => onDeletePoint(p.id)} onEditZones={() => onEditZones(p.id)} onEdit={() => onEditPoint(p.id)} />
        ))}
      </main>
    </div>
  );
}

/* ============================================================
   Screen 3: Point trend & audit log
   ============================================================ */

function TrendTooltip({ active, payload, point }) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0].payload;
  const dp = decimalsFor(point);
  return (
    <div className={cx('max-w-[220px] rounded-xl border-2 bg-zinc-950 p-3 shadow-xl', d.sev === 'alarm' ? 'border-red-500' : d.sev === 'warn' ? 'border-amber-400' : 'border-emerald-500')}>
      <p className="text-xs font-semibold text-zinc-400">{fmtDateTime(d.recordedAt)}</p>
      <p className={cx('font-mono text-xl font-black', SEV[d.sev].text)}>
        {fmtV(d.value, dp)} <span className="text-sm text-zinc-400">{point.unit}</span>
      </p>
      <p className="font-mono text-xs text-zinc-300">Δ {signed(d.value - point.targetValue, dp)} from target</p>
      <div className="mt-1.5"><StatusPill sev={d.sev} small /></div>
      {d.notes && <p className="mt-1.5 text-xs italic text-zinc-400">“{d.notes}”</p>}
    </div>
  );
}

function ExpandedTick({ x, y, payload, data }) {
  const C = useChart();
  const d = data[payload.value];
  if (!d) return null;
  const dt = new Date(d.recordedAt);
  return (
    <text x={x} y={y + 14} textAnchor="middle" fill={C.tick} fontSize={11}>
      <tspan x={x}>{dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</tspan>
      <tspan x={x} dy={13} fill={C.tick2}>{dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</tspan>
    </text>
  );
}

function ExpandedChart({ point, readings, onClose }) {
  const C = useChart();
  const [zoom, setZoom] = useState(true);
  const [size, setSize] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 400,
    h: typeof window !== 'undefined' ? window.innerHeight : 700,
  }));
  const scrollRef = useRef(null);
  const dp = decimalsFor(point);
  const { min, max } = limits(point);
  const alarmOn = hasAlarm(point);
  const { amin, amax } = alarmOn ? alarmLimits(point) : { amin: min, amax: max };

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // Start scrolled to the newest readings (right edge, where the Y axis sits).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [readings.length, size.w]);

  const data = readings.map((r, i) => ({ i, value: r.value, sev: r.sev, notes: r.notes, recordedAt: r.recordedAt }));
  const values = readings.map((r) => r.value);
  const domain = (() => {
    if (!zoom) return chartDomain(values, amin, amax);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo;
    const pad = span > 0 ? span * 0.18 : Math.max(point.tolerance * 0.1, 10 ** -dp);
    return [lo - pad, hi + pad];
  })();
  const overflow = zoom ? 'hidden' : 'extendDomain';
  const SPACING = 76;
  const chartW = Math.max(size.w - 16, data.length * SPACING + 90);
  const chartH = Math.max(260, size.h - 190);
  const scrolls = chartW > size.w - 16;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950 pb-[var(--sab,0px)] pt-[var(--sat,0px)]" role="dialog" aria-modal="true" aria-label={`${point.label} full history`}>
      <div className="flex items-center gap-2 border-b-2 border-zinc-800 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-black uppercase tracking-wide">{point.label}</h2>
          <p className="truncate font-mono text-[11px] text-zinc-400">
            {readings.length} readings · Target {fmt(point.targetValue, dp)} ± {fmt(point.tolerance, dp)} {point.unit}
          </p>
        </div>
        <ThemeToggle />
        <button type="button" onClick={onClose} aria-label="Close expanded chart" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-zinc-800 active:bg-zinc-700">
          <X size={26} strokeWidth={2.5} />
        </button>
      </div>

      <div className="flex items-center gap-2 px-3 py-2">
        <div className="grid flex-1 grid-cols-2 rounded-xl bg-zinc-900 p-1 ring-1 ring-zinc-800">
          {[
            [true, 'Zoom to readings'],
            [false, 'Show spec bands'],
          ].map(([v, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => setZoom(v)}
              aria-pressed={zoom === v}
              className={cx(
                'h-11 rounded-lg text-xs font-black uppercase tracking-wider',
                zoom === v ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 active:bg-zinc-800',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {scrolls && (
        <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">‹ Swipe sideways for older readings · tap a point for details</p>
      )}

      <div ref={scrollRef} className="flex-1 overflow-x-auto overflow-y-hidden px-2" style={{ WebkitOverflowScrolling: 'touch' }}>
        <LineChart width={chartW} height={chartH} data={data} margin={{ top: 28, right: 8, bottom: 22, left: 8 }}>
          <CartesianGrid stroke={C.grid} strokeDasharray="3 3" />
          <XAxis dataKey="i" type="category" interval={0} tick={<ExpandedTick data={data} />} stroke={C.axis} padding={{ left: 24, right: 24 }} height={36} />
          <YAxis orientation="right" domain={domain} tickFormatter={(v) => fmt(v, dp)} tick={{ fill: C.tick, fontSize: 11 }} stroke={C.axis} width={54} allowDataOverflow />
          {alarmOn && <ReferenceArea y1={amin} y2={min} fill={C.warn} fillOpacity={0.16} ifOverflow={overflow} />}
          {alarmOn && <ReferenceArea y1={max} y2={amax} fill={C.warn} fillOpacity={0.16} ifOverflow={overflow} />}
          <ReferenceArea y1={min} y2={max} fill={C.ok} fillOpacity={0.14} ifOverflow={overflow} />
          <ReferenceLine y={max} stroke={C.warn} strokeDasharray="4 4" strokeOpacity={0.7} ifOverflow={zoom ? 'discard' : 'extendDomain'} />
          <ReferenceLine y={min} stroke={C.warn} strokeDasharray="4 4" strokeOpacity={0.7} ifOverflow={zoom ? 'discard' : 'extendDomain'} />
          {alarmOn && <ReferenceLine y={amax} stroke={C.alarm} strokeDasharray="4 4" strokeOpacity={0.8} ifOverflow={zoom ? 'discard' : 'extendDomain'} />}
          {alarmOn && <ReferenceLine y={amin} stroke={C.alarm} strokeDasharray="4 4" strokeOpacity={0.8} ifOverflow={zoom ? 'discard' : 'extendDomain'} />}
          <ReferenceLine y={point.targetValue} stroke={C.ok} strokeDasharray="2 4" ifOverflow={zoom ? 'discard' : 'extendDomain'} />
          <Tooltip content={<TrendTooltip point={point} />} cursor={{ stroke: C.cursor, strokeWidth: 1 }} />
          <Line
            type="linear"
            dataKey="value"
            stroke={C.line}
            strokeWidth={2.5}
            dot={<SpecDot r={6} />}
            activeDot={{ r: 10, stroke: C.activeStroke, strokeWidth: 2, fill: C.activeFill }}
            isAnimationActive={false}
            label={({ x, y, value, index }) => (
              <text key={`lbl-${index}`} x={x} y={y - 14} textAnchor="middle" fontSize={12} fontWeight={800} fontFamily="ui-monospace, monospace"
                fill={data[index] ? C[data[index].sev] : C.line}>
                {fmtV(value, dp)}
              </text>
            )}
          />
        </LineChart>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t-2 border-zinc-800 px-3 py-2 text-[11px] font-bold uppercase text-zinc-500">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" /> In spec</span>
        {alarmOn && <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500" /> Warning</span>}
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-red-500" /> {alarmOn ? 'Alarm' : 'Out of spec'}</span>
        {zoom && <span className="text-zinc-600">Scale zoomed — bands may be off-screen</span>}
      </div>
    </div>
  );
}

function PointScreen({ asset, assetPath, point, readings, onBack, onHome, notify, onDelete, onEdit }) {
  const [csvModal, setCsvModal] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const C = useChart();
  const closeExpanded = useCallback(() => setExpanded(false), []);
  const dp = decimalsFor(point);
  const { min, max } = limits(point);
  const chartData = readings.map((r) => ({ t: new Date(r.recordedAt).getTime(), value: r.value, sev: r.sev, notes: r.notes, recordedAt: r.recordedAt }));
  const alarmOn = hasAlarm(point);
  const { amin, amax } = alarmOn ? alarmLimits(point) : { amin: min, amax: max };
  const domain = readings.length ? chartDomain(readings.map((r) => r.value), amin, amax) : [amin - 1, amax + 1];
  const outCount = readings.filter((r) => r.isOutOfSpec).length;
  const alarmCount = readings.filter((r) => r.sev === 'alarm').length;
  const latest = readings[readings.length - 1];
  const audit = [...readings].reverse();
  const filename = `inspec_${slug(asset.identifier)}_${slug(point.label)}_${new Date().toISOString().slice(0, 10)}.csv`;

  const exportCsv = async () => {
    if (!readings.length) {
      notify('No readings to export yet', 'warn');
      return;
    }
    const csv = buildCsv(asset, point, readings, assetPath);
    const shared = await shareFileOnIOSApp(filename, csv, 'text/csv');
    if (shared === 'shared') return notify('CSV exported');
    if (shared === 'declined') return notify('Export cancelled', 'warn');
    try {
      downloadFile(filename, csv);
    } catch {
      /* blocked: the modal below covers it */
    }
    setCsvModal({ csv });
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-[var(--sat,0px)] z-20 border-b-2 border-zinc-800 bg-zinc-950/95 px-4 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onBack} aria-label={`Back to ${asset.name}`} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-zinc-800 active:bg-zinc-700">
            <ChevronLeft size={30} strokeWidth={3} />
          </button>
          <HomeButton onHome={onHome} />
          <div className="flex-1" />
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit parameter ${point.label}`}
            title="Edit"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-zinc-200 active:bg-zinc-700"
          >
            <Pencil size={20} strokeWidth={2.25} />
          </button>
          <ThemeToggle />
        </div>
      </header>

      <div className="px-4 pt-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">{assetPath || asset.name} ›</p>
        <h1 className="break-words text-xl font-black leading-tight">{point.label}</h1>
        <p className="mt-0.5 font-mono text-xs text-zinc-400">{asset.identifier}</p>
      </div>

      <main className="space-y-4 px-4 py-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3">
          <RangeInfo point={point} />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl bg-zinc-900 p-3 ring-1 ring-zinc-800">
            <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Readings</p>
            <p className="font-mono text-2xl font-black">{readings.length}</p>
          </div>
          <div className={cx('rounded-xl p-3 ring-1', alarmCount ? 'bg-red-500/10 ring-red-500/50' : outCount ? 'bg-amber-400/10 ring-amber-400/50' : 'bg-zinc-900 ring-zinc-800')}>
            <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Out of spec</p>
            <p className={cx('font-mono text-2xl font-black', alarmCount ? 'text-red-400' : outCount ? 'text-amber-400' : 'text-emerald-400')}>
              {outCount}
              {alarmOn && outCount > 0 && <span className="ml-1 text-xs font-bold text-zinc-400">({alarmCount} alarm)</span>}
            </p>
          </div>
          <div className="rounded-xl bg-zinc-900 p-3 ring-1 ring-zinc-800">
            <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Latest</p>
            <p className={cx('truncate font-mono text-2xl font-black', latest ? SEV[latest.sev].text : 'text-zinc-500')}>
              {latest ? fmtV(latest.value, dp) : '—'}
            </p>
          </div>
        </div>

        <div className="rounded-2xl border-2 border-zinc-800 bg-zinc-900 p-3">
          <div className="mb-1 flex items-center justify-between px-1">
            <h2 className="text-xs font-black uppercase tracking-widest text-zinc-400">Full history</h2>
            <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase text-zinc-500">
              <span className="inline-block h-2.5 w-4 rounded-sm bg-emerald-500/30 ring-1 ring-emerald-500/60" /> Safe
              {alarmOn && <><span className="ml-2 inline-block h-2.5 w-4 rounded-sm bg-amber-400/30 ring-1 ring-amber-400/60" /> Warn</>}
            </span>
          </div>
          {readings.length ? (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke={C.grid} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="t"
                    type="number"
                    scale="time"
                    domain={[(d) => d - DAY * 0.6, (d) => d + DAY * 0.6]}
                    tickFormatter={fmtDate}
                    tick={{ fill: C.tick, fontSize: 11 }}
                    stroke={C.axis}
                    minTickGap={24}
                  />
                  <YAxis
                    domain={domain}
                    tickFormatter={(v) => fmt(v, dp)}
                    tick={{ fill: C.tick, fontSize: 11 }}
                    stroke={C.axis}
                    width={48}
                  />
                  {alarmOn && <ReferenceArea y1={amin} y2={min} fill={C.warn} fillOpacity={0.16} ifOverflow="extendDomain" />}
                  {alarmOn && <ReferenceArea y1={max} y2={amax} fill={C.warn} fillOpacity={0.16} ifOverflow="extendDomain" />}
                  <ReferenceArea y1={min} y2={max} fill={C.ok} fillOpacity={0.14} ifOverflow="extendDomain" />
                  <ReferenceLine y={max} stroke={C.warn} strokeDasharray="4 4" strokeOpacity={0.7} />
                  <ReferenceLine y={min} stroke={C.warn} strokeDasharray="4 4" strokeOpacity={0.7} />
                  {alarmOn && <ReferenceLine y={amax} stroke={C.alarm} strokeDasharray="4 4" strokeOpacity={0.8} />}
                  {alarmOn && <ReferenceLine y={amin} stroke={C.alarm} strokeDasharray="4 4" strokeOpacity={0.8} />}
                  <ReferenceLine y={point.targetValue} stroke={C.ok} strokeDasharray="2 4" />
                  <Tooltip content={<TrendTooltip point={point} />} cursor={{ stroke: C.cursor, strokeWidth: 1 }} />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke={C.line}
                    strokeWidth={2.5}
                    dot={<SpecDot r={4.5} />}
                    activeDot={{ r: 8, stroke: C.activeStroke, strokeWidth: 2, fill: C.activeFill }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-40 items-center justify-center text-sm text-zinc-500">No readings logged yet.</div>
          )}
          {readings.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-zinc-800 text-sm font-black uppercase tracking-wider text-white active:bg-zinc-700"
            >
              <Maximize2 size={18} strokeWidth={2.5} /> Expand chart
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={exportCsv}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-xl border-2 border-zinc-600 bg-zinc-800 text-base font-black uppercase tracking-wider text-white active:bg-zinc-700"
        >
          <Download size={20} /> Export CSV
        </button>

        <div className="overflow-hidden rounded-2xl border-2 border-zinc-800 bg-zinc-900">
          <h2 className="border-b border-zinc-800 px-4 py-3 text-xs font-black uppercase tracking-widest text-zinc-400">Audit log · newest first</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="bg-zinc-950 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                <tr>
                  <th className="px-3 py-2.5">Date / Time</th>
                  <th className="px-3 py-2.5 text-right">Value</th>
                  <th className="px-3 py-2.5 text-right">Δ Target</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Notes</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((r) => (
                  <tr key={r.id} className={cx('border-t border-zinc-800', r.sev === 'alarm' && 'bg-red-500/5', r.sev === 'warn' && 'bg-amber-400/5')}>
                    <td className="whitespace-nowrap px-3 py-3 text-zinc-300">{fmtDateTime(r.recordedAt)}</td>
                    <td className={cx('whitespace-nowrap px-3 py-3 text-right font-mono font-bold', r.sev === 'ok' ? 'text-white' : SEV[r.sev].text)}>
                      {fmtV(r.value, dp)} <span className="text-xs text-zinc-500">{point.unit}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-zinc-300">{signed(r.value - point.targetValue, dp)}</td>
                    <td className="px-3 py-3"><StatusPill sev={r.sev} small /></td>
                    <td className="px-3 py-3 text-zinc-400">{r.notes || <span className="text-zinc-600">—</span>}</td>
                  </tr>
                ))}
                {!audit.length && (
                  <tr><td colSpan={5} className="px-3 py-6 text-center text-zinc-500">No readings yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-xl border-2 border-red-500/50 text-base font-black uppercase tracking-wider text-red-400 active:bg-red-500/10"
        >
          <Trash2 size={20} /> Delete Parameter
        </button>
      </main>

      {expanded && <ExpandedChart point={point} readings={readings} onClose={closeExpanded} />}

      {csvModal && (
        <CsvModal
          csv={csvModal.csv}
          filename={filename}
          onClose={() => setCsvModal(null)}
          onCopy={(ok) => {
            notify(ok ? 'CSV copied to clipboard' : 'Copy blocked — text selected, copy manually', ok ? 'ok' : 'warn');
            if (ok) setCsvModal(null);
          }}
        />
      )}
    </div>
  );
}

/* ============================================================
   App shell: data loading, routing, mutations
   ============================================================ */

export default function InSpecApp() {
  const [store, setStore] = useState(null);
  const [data, setData] = useState({ equipment: [], inspectionPoints: [], readings: [] });
  const [loadError, setLoadError] = useState(null);
  const [view, setView] = useState({ name: 'home' });
  const [modal, setModal] = useState(null); // 'asset' | 'point' | 'reset' | 'editAsset' | { newChild } | { deleteAsset } | { deletePoint } | { editZones } | { editPoint }
  const [toast, setToast] = useState(null);
  const online = useOnline();
  const [backupPrompt, setBackupPrompt] = useState(null);
  const dataRef = useRef(null);
  const offlineSince = useRef(typeof navigator !== 'undefined' && navigator.onLine === false ? Date.now() : null);
  const lastPromptAt = useRef(0);
  const promptTimer = useRef(null);
  const [themeName, setThemeName] = useState(() => {
    try {
      return window.localStorage.getItem(THEME_KEY) === 'day' ? 'day' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const toggleTheme = useCallback(() => {
    setThemeName((t) => {
      const next = t === 'day' ? 'dark' : 'day';
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch {
        /* storage blocked: theme still switches for this session */
      }
      return next;
    });
  }, []);
  const themeValue = useMemo(() => ({ name: themeName, chart: CHART_PALETTE[themeName], toggle: toggleTheme }), [themeName, toggleTheme]);
  useEffect(() => {
    try {
      document.documentElement.style.background = themeName === 'day' ? '#ffffff' : '#000000';
      document.body.style.background = themeName === 'day' ? '#ffffff' : '#000000';
    } catch {
      /* noop */
    }
  }, [themeName]);
  const toastTimer = useRef(null);

  const notify = useCallback((msg, tone = 'ok', action = null) => {
    setToast({ msg, tone, action, key: Date.now() });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), action ? 6000 : 2800);
  }, []);

  useEffect(() => {
    let alive = true;
    getStore()
      .then(async (s) => {
        const d = await s.loadAll();
        if (alive) {
          setStore(s);
          setData(d);
        }
      })
      .catch((err) => alive && setLoadError(String(err && err.message ? err.message : err)));
    return () => {
      alive = false;
      clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    try {
      window.scrollTo(0, 0);
    } catch {
      /* noop */
    }
  }, [view]);

  // Remember when data last changed (any save after the first load), so we only nudge when there's something new to back up.
  const loadedOnce = useRef(false);
  useEffect(() => {
    dataRef.current = data;
    if (!store) return;
    if (!loadedOnce.current) {
      loadedOnce.current = true;
      return;
    }
    try {
      window.localStorage.setItem(LAST_CHANGE_KEY, new Date().toISOString());
    } catch {
      /* storage blocked: prompt falls back to "never backed up" logic */
    }
  }, [data, store]);

  // Offline -> online: offer a backup once, if there are unsaved changes. Brief blips and repeats are ignored.
  useEffect(() => {
    const goneOffline = () => {
      if (offlineSince.current == null) offlineSince.current = Date.now();
    };
    const backOnline = () => {
      const since = offlineSince.current;
      offlineSince.current = null;
      if (since == null) return;
      const now = Date.now();
      if (now - since < RECONNECT_MIN_OFFLINE_MS) return;
      if (now - lastPromptAt.current < RECONNECT_PROMPT_COOLDOWN_MS) return;
      const d = dataRef.current;
      if (!d || !d.equipment.length) return;
      const lastBackup = readLastBackup();
      const lastChange = readLastChange();
      const changed = !lastBackup || (lastChange && new Date(lastChange) > new Date(lastBackup));
      if (!changed) return;
      const cutoff = lastBackup ? new Date(lastBackup).getTime() : 0;
      lastPromptAt.current = now;
      setBackupPrompt({
        newReadings: d.readings.filter((r) => new Date(r.recordedAt).getTime() > cutoff).length,
        neverBackedUp: !lastBackup,
        offlineMs: now - since,
      });
      clearTimeout(promptTimer.current);
      promptTimer.current = setTimeout(() => setBackupPrompt(null), RECONNECT_PROMPT_VISIBLE_MS);
    };
    window.addEventListener('offline', goneOffline);
    window.addEventListener('online', backOnline);
    return () => {
      window.removeEventListener('offline', goneOffline);
      window.removeEventListener('online', backOnline);
      clearTimeout(promptTimer.current);
    };
  }, []);

  const refresh = useCallback(async () => {
    if (store) setData(await store.loadAll());
  }, [store]);

  const pointsByEquipment = useMemo(() => {
    const m = new Map();
    for (const p of data.inspectionPoints) {
      if (!m.has(p.equipmentId)) m.set(p.equipmentId, []);
      m.get(p.equipmentId).push(p);
    }
    for (const list of m.values()) list.sort((a, b) => a.id - b.id);
    return m;
  }, [data.inspectionPoints]);

  const readingsByPoint = useMemo(() => {
    const pointById = new Map(data.inspectionPoints.map((p) => [p.id, p]));
    const m = new Map();
    for (const r of data.readings) {
      const pt = pointById.get(r.pointId);
      if (!m.has(r.pointId)) m.set(r.pointId, []);
      // Pass/fail is the stored isOutOfSpec; the yellow/red split follows the current alarm zone.
      m.get(r.pointId).push({ ...r, sev: pt ? severityOf(pt, r) : r.isOutOfSpec ? 'alarm' : 'ok' });
    }
    for (const list of m.values()) list.sort(byTime);
    return m;
  }, [data.readings, data.inspectionPoints]);

  const tree = useMemo(() => {
    const byId = new Map(data.equipment.map((e) => [e.id, e]));
    const children = new Map([[null, []]]);
    for (const e of data.equipment) {
      const key = e.parentId != null && byId.has(e.parentId) ? e.parentId : null; // orphans surface at top level
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(e);
    }
    for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const pathOf = (e) => {
      const out = [];
      const seen = new Set([e.id]);
      let cur = e.parentId != null ? byId.get(e.parentId) : null;
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        out.unshift(cur);
        cur = cur.parentId != null ? byId.get(cur.parentId) : null;
      }
      return out;
    };
    const descendants = (id) => {
      const out = [];
      const stack = [...(children.get(id) || [])];
      const seen = new Set([id]);
      while (stack.length) {
        const e = stack.pop();
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push(e);
        stack.push(...(children.get(e.id) || []));
      }
      return out;
    };
    // Archived = this asset or anything above it has archivedAt set. Archived branches drop out of lists, search and roll-ups.
    const isArchived = (e) => {
      if (!e) return false;
      if (e.archivedAt) return true;
      return pathOf(e).some((a) => a.archivedAt);
    };
    const live = new Map();
    for (const [k, list] of children) live.set(k, list.filter((e) => !e.archivedAt));
    const liveDescendants = (id) => {
      const out = [];
      const stack = [...(live.get(id) || [])];
      const seen = new Set([id]);
      while (stack.length) {
        const e = stack.pop();
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push(e);
        stack.push(...(live.get(e.id) || []));
      }
      return out;
    };
    return { byId, children, live, pathOf, descendants, liveDescendants, isArchived };
  }, [data.equipment]);

  // Status rolls up: an asset reflects its own parameters plus everything nested inside it.
  const statusById = useMemo(() => {
    const m = new Map();
    for (const e of data.equipment) {
      const ids = [e.id, ...tree.liveDescendants(e.id).map((d) => d.id)];
      const pts = ids.flatMap((i) => pointsByEquipment.get(i) || []);
      const issues = [];
      for (const p of pts) {
        const rs = readingsByPoint.get(p.id) || [];
        const latest = rs[rs.length - 1];
        if (latest && latest.sev !== 'ok') issues.push({ point: p, assetId: p.equipmentId, sev: latest.sev, value: latest.value });
      }
      issues.sort((a, b) =>
        (b.sev === 'alarm') - (a.sev === 'alarm') ||
        pathLabel([...tree.pathOf(tree.byId.get(a.assetId)), tree.byId.get(a.assetId)])
          .localeCompare(pathLabel([...tree.pathOf(tree.byId.get(b.assetId)), tree.byId.get(b.assetId)]), undefined, { numeric: true }));
      m.set(e.id, {
        ...assetStatus(pts, readingsByPoint),
        pointCount: (pointsByEquipment.get(e.id) || []).length,
        childCount: (tree.live.get(e.id) || []).length,
        issues,
      });
    }
    return m;
  }, [data.equipment, tree, pointsByEquipment, readingsByPoint]);

  const createAssets = async ({ items, parentId, copyFrom }) => {
    const template = copyFrom != null ? pointsByEquipment.get(copyFrom) || [] : [];
    const ids = [];
    for (const it of items) {
      const id = await store.add('equipment', { ...it, parentId: parentId ?? null, createdAt: new Date().toISOString() });
      ids.push(id);
      for (const p of template) {
        await store.add('inspectionPoints', {
          equipmentId: id, label: p.label, unit: p.unit, targetValue: p.targetValue, tolerance: p.tolerance, alarmTolerance: p.alarmTolerance ?? null,
        });
      }
    }
    await refresh();
    setModal(null);
    if (parentId == null && ids.length === 1) setView({ name: 'asset', id: ids[0] });
    else if (parentId != null) setView({ name: 'asset', id: parentId });
    const copied = template.length ? ` with ${plural(template.length, 'parameter')} each` : '';
    notify(ids.length === 1 ? `${items[0].name} created${template.length ? ` with ${plural(template.length, 'parameter')}` : ''}` : `${ids.length} assets created${copied}`);
  };

  const updateAsset = async (id, fields) => {
    if (fields.parentId != null && (fields.parentId === id || tree.descendants(id).some((d) => d.id === fields.parentId))) {
      throw new Error('cycle');
    }
    await store.update('equipment', id, fields);
    await refresh();
    setModal(null);
    notify('Asset updated');
  };

  const setArchived = async (id, on, { withUndo = true } = {}) => {
    const asset = tree.byId.get(id);
    try {
      await store.update('equipment', id, { archivedAt: on ? new Date().toISOString() : null });
      await refresh();
      setModal(null);
      if (on) {
        // Leave the archived asset's page (it's hidden now) and go up to where it lived.
        if (view.name !== 'home') {
          const inside = view.name === 'asset' && (view.id === id || tree.descendants(id).some((d) => d.id === view.id));
          if (inside) setView(asset && asset.parentId != null && tree.byId.has(asset.parentId) ? { name: 'asset', id: asset.parentId } : { name: 'home' });
        }
        notify(`${asset ? asset.name : 'Asset'} archived`, 'ok', withUndo ? { label: 'Undo', onClick: () => setArchived(id, false, { withUndo: false }) } : null);
      } else {
        notify(`${asset ? asset.name : 'Asset'} restored`);
      }
    } catch {
      notify('Could not update — try again', 'warn');
    }
  };

  const subtreeCounts = (id) => {
    const ids = [id, ...tree.descendants(id).map((d) => d.id)];
    const pts = ids.flatMap((i) => pointsByEquipment.get(i) || []);
    return { ids, pts, subs: ids.length - 1, points: pts.length, readings: pts.reduce((n, p) => n + (readingsByPoint.get(p.id) || []).length, 0) };
  };

  const deleteAsset = async (id) => {
    const asset = tree.byId.get(id);
    const { ids, pts } = subtreeCounts(id);
    try {
      for (const p of pts) await store.deletePoint(p.id);
      for (const eid of ids) await store.remove('equipment', eid);
      await refresh();
      setModal(null);
      // Only move if the screen you're on was inside what got deleted.
      const viewAsset = view.name === 'asset' ? view.id : view.name === 'point' ? (data.inspectionPoints.find((p) => p.id === view.id) || {}).equipmentId : null;
      if (viewAsset != null && ids.includes(viewAsset)) {
        setView(asset && asset.parentId != null && tree.byId.has(asset.parentId) ? { name: 'asset', id: asset.parentId } : { name: 'home' });
      }
      notify(`${asset ? asset.name : 'Asset'} deleted`);
      return true;
    } catch {
      notify('Delete failed — try again', 'warn');
      return false;
    }
  };

  const createPoint = async (equipmentId, fields) => {
    await store.add('inspectionPoints', { equipmentId, ...fields });
    await refresh();
    setModal(null);
    notify(`${fields.label} added`);
  };

  const logReading = async (point, value, notes) => {
    const reading = {
      pointId: point.id,
      value,
      isOutOfSpec: isOutOfSpec(point, value),
      severity: severityOf(point, { value }),
      notes: notes || '',
      recordedAt: new Date().toISOString(),
    };
    const id = await store.add('readings', reading);
    await refresh();
    let undone = false;
    notify(
      `Reading logged · ${fmtV(value, decimalsFor(point))} ${point.unit}`,
      reading.severity === 'ok' ? 'ok' : reading.severity,
      {
        label: 'Undo',
        onClick: async () => {
          if (undone) return;
          undone = true;
          try {
            await store.remove('readings', id);
            await refresh();
            notify(`Reading removed from ${point.label}`, 'ok');
          } catch {
            undone = false;
            notify('Undo failed — try again', 'warn');
          }
        },
      },
    );
    return { ...reading, id, sev: reading.severity };
  };

  const deletePoint = async (pointId) => {
    const point = data.inspectionPoints.find((p) => p.id === pointId);
    try {
      await store.deletePoint(pointId);
      await refresh();
      setModal(null);
      if (point && view.name === 'point') setView({ name: 'asset', id: point.equipmentId });
      notify(`${point ? point.label : 'Parameter'} deleted`);
      return true;
    } catch {
      notify('Delete failed — try again', 'warn');
      return false;
    }
  };

  const updatePoint = async (pointId, fields, { recheck } = {}) => {
    await store.update('inspectionPoints', pointId, fields);
    let changed = 0;
    if (recheck) {
      const prev = data.inspectionPoints.find((p) => p.id === pointId);
      const next = { ...prev, ...fields };
      for (const r of data.readings.filter((x) => x.pointId === pointId)) {
        const out = isOutOfSpec(next, r.value);
        if (out !== r.isOutOfSpec) changed++;
        await store.update('readings', r.id, { isOutOfSpec: out, severity: severityOf(next, { value: r.value }) });
      }
    }
    await refresh();
    setModal(null);
    notify(recheck ? `Parameter updated · ${plural(changed, 'reading')} re-classified` : 'Parameter updated');
  };

  const saveAlarmZone = async (pointId, alarmTolerance) => {
    try {
      await store.update('inspectionPoints', pointId, { alarmTolerance });
      await refresh();
      setModal(null);
      notify(alarmTolerance == null ? 'Alarm zone removed' : 'Alarm zone saved');
      return true;
    } catch {
      notify('Save failed — try again', 'warn');
      return false;
    }
  };

  const restoreBackup = async (next) => {
    try {
      await store.replaceAll(next);
      await refresh();
      setModal(null);
      setView({ name: 'home' });
      notify(`Restored ${plural(next.equipment.length, 'asset')}, ${plural(next.inspectionPoints.length, 'parameter')}, and ${plural(next.readings.length, 'reading')}`);
      return true;
    } catch {
      notify('Restore failed — your existing data was not changed', 'warn');
      return false;
    }
  };

  const mergeBackup = async (plan) => {
    try {
      const nextId = (rows) => rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
      let eqNext = nextId(data.equipment);
      let ptNext = nextId(data.inspectionPoints);
      let rdNext = nextId(data.readings);
      const eqId = new Map(plan.eqMatch); // incoming asset id -> id on this device
      for (const e of plan.newEquipment) eqId.set(e.id, eqNext++);
      const ptId = new Map(plan.ptMatch);
      const add = { equipment: [], inspectionPoints: [], readings: [] };
      for (const e of plan.newEquipment) {
        add.equipment.push({ ...e, id: eqId.get(e.id), parentId: e.parentId != null && eqId.has(e.parentId) ? eqId.get(e.parentId) : null });
      }
      for (const p of plan.newPoints) {
        if (!eqId.has(p.equipmentId)) continue;
        const id = ptNext++;
        ptId.set(p.id, id);
        add.inspectionPoints.push({ ...p, id, equipmentId: eqId.get(p.equipmentId) });
      }
      for (const r of plan.newReadings) {
        if (!ptId.has(r.pointId)) continue;
        add.readings.push({ ...r, id: rdNext++, pointId: ptId.get(r.pointId) });
      }
      await store.bulkMerge(add);
      await refresh();
      setModal(null);
      setView({ name: 'home' });
      notify(`Merged ${plural(add.equipment.length, 'asset')}, ${plural(add.inspectionPoints.length, 'parameter')}, and ${plural(add.readings.length, 'reading')}`);
      return true;
    } catch {
      notify('Merge failed — your existing data was not changed', 'warn');
      return false;
    }
  };

  const resetDemo = async () => {
    try {
      await seedStore(store);
      await refresh();
      setView({ name: 'home' });
      notify('Demo data restored');
    } catch {
      notify('Reset failed', 'warn');
    }
    setModal(null);
  };

  let screen;
  if (loadError) {
    screen = (
      <div className="flex min-h-screen flex-col items-center justify-center p-8 text-center">
        <AlertTriangle className="mb-3 text-amber-400" size={40} />
        <p className="text-lg font-bold">Storage failed to start</p>
        <p className="mt-2 text-sm text-zinc-400">{loadError}</p>
      </div>
    );
  } else if (!store) {
    screen = (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-zinc-400">
        <Gauge className="animate-pulse text-emerald-500" size={44} />
        <p className="text-sm font-bold uppercase tracking-widest">Opening local database…</p>
      </div>
    );
  } else if (view.name === 'asset') {
    const asset = data.equipment.find((e) => e.id === view.id);
    screen = asset ? (
      <AssetScreen
        asset={asset}
        path={tree.pathOf(asset)}
        subAssets={tree.live.get(asset.id) || []}
        archived={tree.isArchived(asset)}
        archivedSelf={Boolean(asset.archivedAt)}
        onUnarchive={() => setArchived(asset.id, false)}
        onAssetMenu={(id) => setModal({ assetMenu: id })}
        statusById={statusById}
        tree={tree}
        points={pointsByEquipment.get(asset.id) || []}
        readingsByPoint={readingsByPoint}
        onBack={() => setView(asset.parentId != null && tree.byId.has(asset.parentId) ? { name: 'asset', id: asset.parentId } : { name: 'home' })}
        onOpenAsset={(id) => setView({ name: 'asset', id })}
        onHome={() => setView({ name: 'home' })}
        onAddSubAsset={() => setModal({ newChild: asset.id })}
        onAddPoint={() => setModal('point')}
        onEditAsset={() => setModal('editAsset')}
        onLog={logReading}
        onOpenPoint={(pid) => setView({ name: 'point', id: pid, assetId: asset.id })}
        onDeletePoint={(pid) => setModal({ deletePoint: pid })}
        onEditZones={(pid) => setModal({ editZones: pid })}
        onEditPoint={(pid) => setModal({ editPoint: pid })}
      />
    ) : null;
  } else if (view.name === 'point') {
    const point = data.inspectionPoints.find((p) => p.id === view.id);
    const asset = point && data.equipment.find((e) => e.id === point.equipmentId);
    screen = point && asset ? (
      <PointScreen
        asset={asset}
        assetPath={pathLabel([...tree.pathOf(asset), asset])}
        point={point}
        readings={readingsByPoint.get(point.id) || []}
        onBack={() => setView({ name: 'asset', id: asset.id })}
        notify={notify}
        onHome={() => setView({ name: 'home' })}
        onDelete={() => setModal({ deletePoint: point.id })}
        onEdit={() => setModal({ editPoint: point.id })}
      />
    ) : null;
  }
  if (store && !loadError && !screen) {
    screen = (
      <HomeScreen
        data={data}
        tree={tree}
        statusById={statusById}
        onOpenAsset={(id) => setView({ name: 'asset', id })}
        onNewAsset={() => setModal('asset')}
        onReset={() => setModal('reset')}
        onBackup={() => setModal('backup')}
        onAssetMenu={(id) => setModal({ assetMenu: id })}
        storageKind={store.kind}
      />
    );
  }

  return (
    <ThemeCtx.Provider value={themeValue}>
    <div className={cx('min-h-screen bg-black text-white antialiased', themeName === 'day' && 'speclog-day')} style={{ fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' }}>
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 z-[80] h-[var(--sat,0px)]"
        style={{ background: themeName === 'day' ? '#ffffff' : '#09090b' }}
      />
      <div className="relative mx-auto min-h-screen w-full max-w-md bg-zinc-950 shadow-2xl ring-1 ring-zinc-900">
        {!online && (
          <div className="flex items-center justify-center gap-2 bg-amber-500 px-3 py-1.5 text-xs font-black uppercase tracking-wider text-zinc-950">
            <WifiOff size={14} /> Offline — readings save locally
          </div>
        )}
        {online && store && (
          <div className="sr-only"><Wifi size={1} /> Online</div>
        )}
        {screen}

        {(modal === 'asset' || (modal && modal.newChild)) && (
          <AssetModal
            parent={modal.newChild ? tree.byId.get(modal.newChild) : null}
            assets={data.equipment}
            tree={tree}
            pointsByEquipment={pointsByEquipment}
            onClose={() => setModal(null)}
            onSubmit={createAssets}
          />
        )}
        {modal === 'editAsset' && view.name === 'asset' && (() => {
          const a = tree.byId.get(view.id);
          return a ? (
            <AssetModal
              initial={a}
              assets={data.equipment}
              tree={tree}
              pointsByEquipment={pointsByEquipment}
              onClose={() => setModal(null)}
              onSubmit={(f) => updateAsset(a.id, f)}
              onDelete={() => setModal({ deleteAsset: a.id })}
            />
          ) : null;
        })()}
        {modal && modal.assetMenu && (() => {
          const a = tree.byId.get(modal.assetMenu);
          return a ? (
            <AssetMenu
              asset={a}
              path={tree.pathOf(a)}
              archived={Boolean(a.archivedAt)}
              onClose={() => setModal(null)}
              onOpen={() => { setModal(null); setView({ name: 'asset', id: a.id }); }}
              onEdit={() => { setView({ name: 'asset', id: a.id }); setModal('editAsset'); }}
              onArchive={() => setArchived(a.id, true)}
              onUnarchive={() => setArchived(a.id, false)}
              onDelete={() => setModal({ deleteAsset: a.id })}
            />
          ) : null;
        })()}
        {modal && modal.deleteAsset && (() => {
          const a = tree.byId.get(modal.deleteAsset);
          return a ? (
            <DeleteAssetModal asset={a} counts={subtreeCounts(a.id)} onClose={() => setModal(null)} onConfirm={() => deleteAsset(a.id)} />
          ) : null;
        })()}
        {modal === 'point' && view.name === 'asset' && (
          <AddParameterModal onClose={() => setModal(null)} onCreate={(f) => createPoint(view.id, f)} />
        )}
        {modal === 'reset' && <ResetModal onClose={() => setModal(null)} onConfirm={resetDemo} />}
        {backupPrompt && modal !== 'backup' && (
          <ReconnectBackupPrompt
            info={backupPrompt}
            onDismiss={() => setBackupPrompt(null)}
            onBackup={() => {
              setBackupPrompt(null);
              setModal('backup');
            }}
          />
        )}
        {modal === 'backup' && (
          <BackupModal
            store={store}
            current={data}
            onMerge={mergeBackup}
            counts={{ equipment: data.equipment.length, inspectionPoints: data.inspectionPoints.length, readings: data.readings.length }}
            onClose={() => setModal(null)}
            onRestore={restoreBackup}
            notify={notify}
          />
        )}
        {modal && modal.editPoint && (() => {
          const p = data.inspectionPoints.find((x) => x.id === modal.editPoint);
          return p ? (
            <AddParameterModal
              initial={p}
              readings={readingsByPoint.get(p.id) || []}
              onClose={() => setModal(null)}
              onCreate={(f, opts) => updatePoint(p.id, f, opts)}
            />
          ) : null;
        })()}
        {modal && modal.editZones && (() => {
          const p = data.inspectionPoints.find((x) => x.id === modal.editZones);
          return p ? <AlarmZoneModal point={p} onClose={() => setModal(null)} onSave={(a) => saveAlarmZone(p.id, a)} /> : null;
        })()}
        {modal && modal.deletePoint && (() => {
          const p = data.inspectionPoints.find((x) => x.id === modal.deletePoint);
          return p ? (
            <DeletePointModal
              point={p}
              readingCount={(readingsByPoint.get(p.id) || []).length}
              onClose={() => setModal(null)}
              onConfirm={() => deletePoint(p.id)}
            />
          ) : null;
        })()}

        {toast && (
          <div className="pointer-events-none fixed inset-x-0 bottom-[calc(1.5rem+var(--sab,0px))] z-[60] flex justify-center px-4">
            <div
              key={toast.key}
              role="status"
              className={cx(
                'flex w-full max-w-sm items-center gap-2 rounded-xl bg-zinc-900 py-2 pl-4 text-sm font-bold shadow-2xl ring-2',
                toast.action ? 'pointer-events-auto pr-2' : 'pr-4',
                toast.tone === 'alarm' ? 'text-red-400 ring-red-500/60'
                  : toast.tone === 'warn' ? 'text-amber-300 ring-amber-500'
                  : 'text-emerald-300 ring-emerald-500',
              )}
            >
              {toast.tone === 'alarm' ? <AlertOctagon size={18} className="shrink-0" />
                : toast.tone === 'warn' ? <AlertTriangle size={18} className="shrink-0" />
                : <CheckCircle2 size={18} className="shrink-0" />}
              <span className="min-w-0 flex-1 py-1.5">{toast.msg}</span>
              {toast.action && (
                <button
                  type="button"
                  onClick={() => {
                    clearTimeout(toastTimer.current);
                    setToast(null);
                    toast.action.onClick();
                  }}
                  className="flex h-12 shrink-0 items-center gap-1.5 rounded-lg border-2 border-zinc-600 px-4 text-sm font-black uppercase tracking-wider text-white active:bg-zinc-800"
                >
                  <Undo2 size={18} strokeWidth={2.5} /> {toast.action.label}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
    </ThemeCtx.Provider>
  );
}

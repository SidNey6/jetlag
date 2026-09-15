// Zentraler Zustand: ein Objekt, Abonnenten, Persistenz in localStorage.
// Jede Änderung läuft durch update() – dort hängen Undo-Historie und Speichern.

const KEY = 'jetlag.state.v1';
const SCHEMA = 2;

export function emptyState() {
  return {
    v: SCHEMA,
    settings: {
      unit: 'metric',
      maskOpacity: 0.62,
      tileUrl: '',
      keepAwake: true,
      radiusRings: [500, 1000, 2000],
      overpassTimeout: 25,
    },
    area: null,
    constraints: [],
    markers: [],
    pois: [],
    timers: [],
    lists: [],
    game: { teams: [], rounds: [], log: [] },
    // Auf kleine Spielflächen ausgelegt (Stadt und Umland). Frei änderbar
    // unter Mehr → Einstellungen → Radius-Vorgaben.
    presets: {
      radius: [250, 500, 1000, 2000, 5000, 10000],
    },
    ui: { tab: 'map', follow: true, showMask: true, frozen: null },
  };
}

let state = emptyState();
const subs = new Set();
const undoStack = [];
const redoStack = [];
let saveTimer = null;
let quotaWarned = false;

export function getState() {
  return state;
}

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

function notify() {
  for (const fn of subs) {
    try { fn(state); } catch (e) { console.error('Abonnent fehlgeschlagen', e); }
  }
}

// label gesetzt => der Schritt landet in der Undo-Historie.
export function update(mutator, label = null) {
  if (label) {
    undoStack.push({ label, snapshot: JSON.stringify(state) });
    if (undoStack.length > 40) undoStack.shift();
    redoStack.length = 0;
  }
  const next = mutator(state);
  if (next) state = next;
  scheduleSave();
  notify();
}

export function undo() {
  const step = undoStack.pop();
  if (!step) return null;
  redoStack.push({ label: step.label, snapshot: JSON.stringify(state) });
  state = JSON.parse(step.snapshot);
  scheduleSave();
  notify();
  return step.label;
}

export function redo() {
  const step = redoStack.pop();
  if (!step) return null;
  undoStack.push({ label: step.label, snapshot: JSON.stringify(state) });
  state = JSON.parse(step.snapshot);
  scheduleSave();
  notify();
  return step.label;
}

export function undoLabel() {
  return undoStack.length ? undoStack[undoStack.length - 1].label : null;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 250);
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    if (!quotaWarned) {
      quotaWarned = true;
      console.warn('Zustand konnte nicht gespeichert werden', e);
      document.dispatchEvent(new CustomEvent('jetlag:toast', {
        detail: { text: 'Speicher voll – Zustand wird nicht gesichert', kind: 'error' },
      }));
    }
  }
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return state;
    state = migrate(JSON.parse(raw));
  } catch (e) {
    console.warn('Gespeicherter Zustand unlesbar, starte leer', e);
  }
  return state;
}

// Fehlende Felder auffüllen, damit ältere Stände nach einem Update nicht abstürzen.
export function migrate(loaded) {
  const base = emptyState();
  const s = { ...base, ...loaded, v: SCHEMA };
  s.settings = { ...base.settings, ...(loaded.settings || {}) };
  s.presets = { ...base.presets, ...(loaded.presets || {}) };
  s.game = { ...base.game, ...(loaded.game || {}) };
  s.ui = { ...base.ui, ...(loaded.ui || {}) };
  for (const k of ['constraints', 'markers', 'pois', 'timers', 'lists']) {
    if (!Array.isArray(s[k])) s[k] = [];
  }
  // Schema 1 hatte Vorgaben für Großstadtmaßstab und keine Möglichkeit, sie zu ändern –
  // gespeicherte Werte von damals sind also keine bewusste Wahl und werden ersetzt.
  if (!loaded.v || loaded.v < 2) {
    s.presets.radius = base.presets.radius;
    s.settings.radiusRings = base.settings.radiusRings;
    delete s.presets.thermo; // gab es nie eine Oberfläche für; lag nur ungenutzt herum
  }
  if (!Array.isArray(s.presets.radius) || !s.presets.radius.length) s.presets.radius = base.presets.radius;
  return s;
}

export function replaceState(next) {
  undoStack.push({ label: 'Import', snapshot: JSON.stringify(state) });
  state = migrate(next);
  save();
  notify();
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function activeConstraints() {
  return state.constraints.filter((c) => c.active !== false);
}

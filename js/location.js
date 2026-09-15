// Standort: GPS-Verfolgung, Einfrieren und manuelles Setzen.
// Eingefroren/manuell ist kein Randfall, sondern Alltag: beim Messen stört GPS-Drift,
// und man will Punkte prüfen, an denen man gerade nicht steht.

const listeners = new Set();
let watchId = null;
let paused = false;   // vom Seitenwechsel angehalten
let wanted = false;   // soll überhaupt geortet werden?
let live = null;      // letzte echte GPS-Position
let override = null;  // {lat,lng,source:'manual'|'frozen'}
let lastError = null;

export function onLocation(fn) {
  listeners.add(fn);
  fn(current());
  return () => listeners.delete(fn);
}

function emit() {
  const c = current();
  for (const fn of listeners) {
    try { fn(c); } catch (e) { console.error(e); }
  }
}

export function current() {
  if (override) return { ...override, accuracy: override.accuracy ?? null };
  return live;
}

export function liveFix() {
  return live;
}

export function error() {
  return lastError;
}

export function isOverridden() {
  return !!override;
}

// Dauerhaftes GPS ist der größte Stromfresser der App. Deshalb läuft die Ortung nur,
// wenn sie auch gebraucht wird: nicht im Hintergrund, nicht bei eingefrorener oder
// von Hand gesetzter Position.
export function start() {
  wanted = true;
  resume();
}

export function stop() {
  wanted = false;
  clearWatch();
}

function clearWatch() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

export function isWatching() {
  return watchId != null;
}

function resume() {
  if (!wanted || paused || override || watchId != null || !navigator.geolocation) return;
  const sparsam = accuracyMode === 'saving';
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      lastError = null;
      live = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
        speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
        timestamp: pos.timestamp,
        source: 'gps',
      };
      emit();
    },
    (err) => {
      lastError = err.code === err.PERMISSION_DENIED
        ? 'Standortfreigabe fehlt – in den Browsereinstellungen erlauben'
        : err.code === err.TIMEOUT
          ? 'Kein GPS-Fix – freier Himmel hilft'
          : 'Standort nicht verfügbar';
      emit();
    },
    {
      enableHighAccuracy: !sparsam,
      maximumAge: sparsam ? 15000 : 2000,
      timeout: 20000,
    },
  );
}

let accuracyMode = 'high';

export function setAccuracyMode(mode) {
  if (mode === accuracyMode) return;
  accuracyMode = mode;
  clearWatch();
  resume();
}

export function accuracy() {
  return accuracyMode;
}

// Im Hintergrund braucht niemand Positionsaktualisierungen.
document.addEventListener('visibilitychange', () => {
  paused = document.visibilityState !== 'visible';
  if (paused) clearWatch(); else resume();
});

// Eingefroren oder manuell gesetzt heißt: GPS darf schlafen.
export function freeze() {
  const base = live || override;
  if (!base) return false;
  override = { ...base, source: 'frozen' };
  clearWatch();
  emit();
  return true;
}

export function setManual(latlng) {
  override = { lat: latlng.lat, lng: latlng.lng, accuracy: null, timestamp: Date.now(), source: 'manual' };
  clearWatch();
  emit();
}

export function release() {
  override = null;
  resume();
  emit();
}

export function sourceLabel() {
  const c = current();
  if (!c) return 'kein Fix';
  if (c.source === 'manual') return 'manuell gesetzt';
  if (c.source === 'frozen') return 'eingefroren';
  return c.accuracy != null ? `GPS ±${Math.round(c.accuracy)} m` : 'GPS';
}

// Standort: GPS-Verfolgung, Einfrieren und manuelles Setzen.
// Eingefroren/manuell ist kein Randfall, sondern Alltag: beim Messen stört GPS-Drift,
// und man will Punkte prüfen, an denen man gerade nicht steht.
//
// In der Android-App übernimmt während einer Aufzeichnung ein Android-Dienst das GPS
// (js/native.js). Er schreibt jeden Punkt auf das Gerät, auch wenn die App im
// Hintergrund liegt oder geschlossen ist; die App holt die Punkte beim Zurückkehren ab.

import { NATIVE, nativeTracker } from './native.js';

const listeners = new Set();
const fixListeners = new Set();
const keepers = new Set(); // Gründe, das GPS trotz Einfrieren laufen zu lassen (Aufzeichnung)
let watchId = null;
let paused = false;   // vom Seitenwechsel angehalten
let wanted = false;   // soll überhaupt geortet werden?
let live = null;      // letzte echte GPS-Position
let override = null;  // {lat,lng,source:'manual'|'frozen'}
let lastError = null;
let nativeOn = false;  // Android-Dienst zeichnet auf
let nativeCursor = 0;  // Zeitstempel des letzten übernommenen Dienst-Punkts
let aufholen = null;   // laufendes Abholen gespeicherter Punkte
const warteschlange = [];

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

// Rohe GPS-Fixes, unabhängig von eingefrorener oder manueller Position.
// Für die Streckenaufzeichnung: die braucht jeden echten Punkt.
export function onFix(fn) {
  fixListeners.add(fn);
  return () => fixListeners.delete(fn);
}

// Aufzeichnung läuft: GPS bleibt an und arbeitet genau, auch wenn die angezeigte
// Position eingefroren ist oder der Sparmodus gewählt wurde.
export function keepAlive(reason, on) {
  const vorher = keepers.size > 0;
  if (on) keepers.add(reason); else keepers.delete(reason);
  if (vorher !== keepers.size > 0) {
    clearWatch();
    if (NATIVE && !keepers.size) stopNative();
    resume();
  }
}

// Ab welchem Zeitpunkt gespeicherte Dienst-Punkte noch fehlen – die Aufzeichnung setzt
// das auf ihren letzten gesicherten Punkt, damit nach einem Neustart nichts verloren geht
export function setNativeCursor(t) {
  nativeCursor = Math.max(0, t || 0);
}

export function nativeRecording() {
  return nativeOn;
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

// Ein Punkt – vom Browser oder vom Android-Dienst – an alle Zuhörer
function deliver(fix) {
  lastError = null;
  live = fix;
  for (const fn of fixListeners) {
    try { fn(live); } catch (e) { console.error(e); }
  }
  // Bei eingefrorener Position ändert ein neuer Fix nichts an der Anzeige
  if (!override) emit();
}

/* ---------- Android-Dienst ---------- */

function nativeFix(p) {
  if (!nativeOn || !(p.time > nativeCursor)) return;
  nativeCursor = p.time;
  deliver({
    lat: p.lat,
    lng: p.lng,
    accuracy: p.accuracy ?? null,
    heading: Number.isFinite(p.heading) ? p.heading : null,
    speed: Number.isFinite(p.speed) ? p.speed : null,
    timestamp: p.time,
    source: 'gps',
  });
}

// Live-Punkte, die während des Abholens eintreffen, warten – sonst überholten sie die
// älteren gespeicherten und die würden als Duplikat verworfen
function nativeEvent(p) {
  if (aufholen) warteschlange.push(p); else nativeFix(p);
}

// Alles holen, was der Dienst seit dem letzten übernommenen Punkt gespeichert hat
export function catchUp() {
  const t = nativeTracker();
  if (!t || !nativeOn) return Promise.resolve(0);
  if (!aufholen) {
    aufholen = t.read({ after: nativeCursor })
      .then(({ points }) => { for (const p of points) nativeFix(p); return points.length; })
      .catch((e) => { console.error(e); return 0; })
      .finally(() => {
        aufholen = null;
        for (const p of warteschlange.splice(0)) nativeFix(p);
      });
  }
  return aufholen;
}

let nativeListener = null;

async function startNative() {
  const t = nativeTracker();
  if (!t || nativeOn) return;
  nativeOn = true;
  if (!nativeListener) nativeListener = t.addListener('fix', nativeEvent);
  try {
    await t.start({
      title: 'Endgame-Aufzeichnung läuft',
      text: 'Die Spur wird auch bei gesperrtem Bildschirm erfasst – tippen zum Öffnen',
    });
    await catchUp();
  } catch (e) {
    // Ohne Freigabe: im Vordergrund wie die Website weiter orten
    nativeOn = false;
    lastError = e.code === 'NOT_AUTHORIZED' ? (e.message || 'Standortfreigabe fehlt') : `Hintergrund-Aufzeichnung: ${e.message || e}`;
    emit();
    resume();
  }
}

async function stopNative() {
  const t = nativeTracker();
  if (!t || !nativeOn) return;
  await catchUp();
  nativeOn = false;
  try {
    await t.stop();
    await t.clear();
  } catch (e) { console.error(e); }
}

export function isWatching() {
  return watchId != null;
}

function resume() {
  const aufzeichnung = keepers.size > 0;
  // In der Android-App zeichnet der Dienst auf – auch im Hintergrund
  if (NATIVE && aufzeichnung) {
    if (!nativeOn) startNative();
    return;
  }
  if (!wanted || paused || (override && !aufzeichnung) || watchId != null || !navigator.geolocation) return;
  const sparsam = accuracyMode === 'saving' && !aufzeichnung;
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      deliver({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
        speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
        timestamp: pos.timestamp,
        source: 'gps',
      });
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

// Im Hintergrund braucht niemand Positionsaktualisierungen – außer der Aufzeichnung,
// und die läuft in der Android-App über den Dienst weiter. Zurück im Vordergrund werden
// dessen Punkte abgeholt.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    paused = document.visibilityState !== 'visible';
    if (paused) clearWatch();
    else { resume(); if (nativeOn) catchUp(); }
  });
}

// Eingefroren oder manuell gesetzt heißt: GPS darf schlafen.
export function freeze() {
  const base = live || override;
  if (!base) return false;
  override = { ...base, source: 'frozen' };
  if (!keepers.size) clearWatch();
  emit();
  return true;
}

export function setManual(latlng) {
  override = { lat: latlng.lat, lng: latlng.lng, accuracy: null, timestamp: Date.now(), source: 'manual' };
  if (!keepers.size) clearWatch();
  emit();
}

export function release() {
  override = null;
  resume();
  emit();
}

export function sourceLabel() {
  const c = current();
  if (!c) return nativeOn ? 'Aufzeichnung wartet auf GPS' : 'kein Fix';
  if (c.source === 'manual') return 'manuell gesetzt';
  if (c.source === 'frozen') return 'eingefroren';
  return c.accuracy != null ? `GPS ±${Math.round(c.accuracy)} m` : 'GPS';
}

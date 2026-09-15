// Standort: GPS-Verfolgung, Einfrieren und manuelles Setzen.
// Eingefroren/manuell ist kein Randfall, sondern Alltag: beim Messen stört GPS-Drift,
// und man will Punkte prüfen, an denen man gerade nicht steht.

const listeners = new Set();
let watchId = null;
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

export function start() {
  if (watchId != null || !navigator.geolocation) return;
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
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
  );
}

export function stop() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

export function freeze() {
  const base = live || override;
  if (!base) return false;
  override = { ...base, source: 'frozen' };
  emit();
  return true;
}

export function setManual(latlng) {
  override = { lat: latlng.lat, lng: latlng.lng, accuracy: null, timestamp: Date.now(), source: 'manual' };
  emit();
}

export function release() {
  override = null;
  emit();
}

export function sourceLabel() {
  const c = current();
  if (!c) return 'kein Fix';
  if (c.source === 'manual') return 'manuell gesetzt';
  if (c.source === 'frozen') return 'eingefroren';
  return c.accuracy != null ? `GPS ±${Math.round(c.accuracy)} m` : 'GPS';
}

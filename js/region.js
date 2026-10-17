// Vorgebaute Regionsdaten: ein OpenStreetMap-Auszug für ein festes Gebiet, gebaut von
// scripts/region/build.mjs und als statische Dateien unter data/ ausgeliefert.
// Was hier liegt, braucht weder Overpass noch Wartezeit – und nach dem ersten Abruf
// auch kein Netz mehr: jede Datei landet im eigenen Cache.
//
// Reihenfolge der Quellen in overpass.js: Regionsdaten → auf dem Gerät vorbereiteter
// Vorrat → Overpass.

import { destination } from './geo.js';
import { streetTilesIn } from './osmgeo.js';
import { NATIVE, SITE } from './native.js';

// Die Android-App bringt nur die Programmdateien mit; Daten kommen von der Website
const BASE = NATIVE ? `${SITE}data/` : './data/';
export const REGION_CACHE = 'jetlag-region-v1';

let regions = [];
let ready = null;
const memo = new Map();

/* ---------- Verzeichnis ---------- */

export function initRegions() {
  if (!ready) {
    ready = (async () => {
      try {
        const res = await fetchFresh(`${BASE}regions.json`);
        regions = res ? ((await res.json()).regions || []) : [];
      } catch (e) {
        regions = [];
      }
      cleanup().catch(() => {});
      return regions;
    })();
  }
  return ready;
}

export function listRegions() {
  return regions;
}

// Netz zuerst (neue Datenstände sollen sofort greifen), ohne Netz die letzte Fassung
async function fetchFresh(url) {
  const cache = await openCache();
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (res.ok) {
      if (cache) cache.put(url, res.clone());
      return res;
    }
  } catch (e) { /* offline */ }
  return cache ? (await cache.match(url)) || null : null;
}

async function openCache() {
  try { return 'caches' in globalThis ? await caches.open(REGION_CACHE) : null; } catch (e) { return null; }
}

// Dateien älterer Datenstände entfernen (Ortsdaten und Karte haben je eine Version)
async function cleanup() {
  const cache = await openCache();
  if (!cache) return;
  const aktuell = new Map(regions.map((r) => [r.id, new Set([r.version, r.map && r.map.version].filter(Boolean))]));
  for (const req of await cache.keys()) {
    const u = new URL(req.url);
    const m = /\/data\/([^/]+)\//.exec(u.pathname);
    if (!m) continue;
    const gueltig = aktuell.get(m[1]);
    if (!gueltig || !gueltig.has(u.searchParams.get('v'))) {
      await cache.delete(req);
      if (u.pathname.endsWith('.pmtiles')) forgetMaps();
    }
  }
}

// Der Service Worker hält eine geöffnete Kartendatei im Speicher – nach dem Löschen
// soll er sie vergessen
export function forgetMaps() {
  try { navigator.serviceWorker?.controller?.postMessage({ type: 'MAP_CHANGED' }); } catch (e) { /* egal */ }
}

/* ---------- Abdeckung ---------- */

function contains(b, p) {
  return p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
}

// Liegt der ganze Kreis im Rechteck? Dann kann nichts außerhalb näher sein.
export function circleInside(b, center, radiusM) {
  if (!contains(b, center)) return false;
  const n = destination(center, 0, radiusM), s = destination(center, 180, radiusM);
  const e = destination(center, 90, radiusM), w = destination(center, 270, radiusM);
  return n.lat <= b.north && s.lat >= b.south && e.lng <= b.east && w.lng >= b.west;
}

export function boundsInside(outer, inner) {
  return inner.south >= outer.south && inner.north <= outer.north && inner.west >= outer.west && inner.east <= outer.east;
}

// Abstand eines Punktes zum nächsten Rand der Region in Metern
export function edgeDistance(region, p) {
  const b = region.bounds;
  const mLat = 111320, mLng = 111320 * Math.cos(p.lat * Math.PI / 180);
  return Math.max(0, Math.min((p.lat - b.south) * mLat, (b.north - p.lat) * mLat, (p.lng - b.west) * mLng, (b.east - p.lng) * mLng));
}

export function regionAt(point) {
  return point ? regions.find((r) => contains(r.bounds, point)) || null : null;
}

export function regionForCircle(center, radiusM) {
  return center ? regions.find((r) => circleInside(r.bounds, center, radiusM)) || null : null;
}

export function regionForBounds(b) {
  return b ? regions.find((r) => boundsInside(r.bounds, b)) || null : null;
}

export function has(region, path) {
  return !!(region && region.files && path in region.files);
}

// In der Region gebaut, aber leer – z. B. U-Bahn-Linien in Bonn
export function knownEmpty(region, path) {
  return !!(region && Array.isArray(region.empty) && region.empty.includes(path));
}

/* ---------- Dateien ---------- */

export function fileUrl(region, path) {
  return new URL(`${BASE}${region.id}/${path}.json?v=${region.version}`, globalThis.location?.href || 'http://localhost/').toString();
}

// Erst aus dem Cache, sonst holen und ablegen. Unbekannte Datei: null.
export function regionGet(region, path) {
  if (!has(region, path)) return Promise.resolve(null);
  const url = fileUrl(region, path);
  if (!memo.has(url)) {
    memo.set(url, (async () => {
      const cache = await openCache();
      let res = cache ? await cache.match(url) : null;
      if (!res) {
        res = await fetch(url);
        if (!res.ok) throw new Error(`Regionsdaten ${path}: HTTP ${res.status}`);
        if (cache) await cache.put(url, res.clone());
      }
      return decode(path, await res.json());
    })().catch((e) => { memo.delete(url); throw e; }));
  }
  return memo.get(url);
}

// Wie regionGet, aber Fehler (offline und nicht im Cache) ergeben null
export async function regionTry(region, path) {
  try { return await regionGet(region, path); } catch (e) { return null; }
}

/* ---------- Format ---------- */
// Koordinaten liegen als flache Liste [lat, lng, lat, lng, …] vor – kürzer als Objekte.

export function unflat(c) {
  const out = new Array(c.length / 2);
  for (let i = 0, j = 0; i < c.length; i += 2, j++) out[j] = { lat: c[i], lng: c[i + 1] };
  return out;
}

const TYPE = { p: 'polygon', l: 'line', n: 'point' };

export function decode(path, data) {
  if (path.startsWith('pois/')) {
    return data.items.map(([id, lat, lng, name]) => ({ id, lat, lng, name }));
  }
  if (path.startsWith('refs/')) {
    if (data.lines) {
      // Linien teilen sich Wege: jeder Weg wird einmal entpackt, alle Linien darauf
      // verweisen auf dieselbe Punktliste
      const wege = data.ways.map((w) => unflat(w.c));
      return data.lines.flatMap((l) => l.w.map((i) => ({ type: 'line', name: l.n, key: l.k, points: wege[i] })));
    }
    return data.features.map((f) => ({ type: TYPE[f.t] || 'line', name: f.n, key: f.k, points: unflat(f.c) }));
  }
  if (path.startsWith('admin/')) {
    return data.items.map((a) => ({ id: a.id, name: a.name, level: a.level, ring: unflat(a.c) }));
  }
  if (path.startsWith('geom/')) return unflat(data.c);
  if (path === 'geoms') return data.rings;
  if (path.startsWith('streets/')) {
    return data.ways.map((w) => {
      const pts = [];
      for (let i = 0; i < w.c.length; i += 2) pts.push([w.c[i], w.c[i + 1]]);
      return { id: w.id, nodes: null, pts, h: w.h, name: w.n || null };
    });
  }
  if (path === 'areas') return data.items;
  if (path === 'elevation') {
    const { v, scale = 1, ...rest } = data;
    return { ...rest, values: v.map((x) => x * scale) };
  }
  return data;
}

/* ---------- Straßennetz ---------- */

function boxAround(center, radiusM) {
  const n = destination(center, 0, radiusM), s = destination(center, 180, radiusM);
  const e = destination(center, 90, radiusM), w = destination(center, 270, radiusM);
  return { south: s.lat, north: n.lat, west: w.lng, east: e.lng };
}

export function streetsCover(region, center, radiusM) {
  return !!(region && region.streets && circleInside(region.streets.bounds, center, radiusM));
}

export function streetTilesFor(region, center, radiusM) {
  return streetTilesIn(boxAround(center, radiusM), region.streets.tile)
    .filter((k) => has(region, `streets/${k}`));
}

// Wege aus allen Kacheln um den Kreis; ein Weg über mehrere Kacheln kommt nur einmal
export async function regionStreets(region, center, radiusM) {
  const box = boxAround(center, radiusM);
  const listen = await Promise.all(streetTilesFor(region, center, radiusM).map((k) => regionGet(region, `streets/${k}`)));
  const seen = new Set();
  const out = [];
  for (const liste of listen) {
    for (const w of liste) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      let s = 90, n = -90, we = 180, e = -180;
      for (const [lat, lng] of w.pts) {
        if (lat < s) s = lat; if (lat > n) n = lat; if (lng < we) we = lng; if (lng > e) e = lng;
      }
      if (s <= box.north && n >= box.south && we <= box.east && e >= box.west) out.push(w);
    }
  }
  return out;
}

/* ---------- Vorabladen ---------- */

// Alle Dateien, die ein Spielgebiet braucht, in den Cache holen – danach geht es offline.
// Umriss eines Gebiets (Gebietsauswahl). Neue Datenstände bündeln alle in "geoms",
// ältere hatten je Gebiet eine Datei.
export async function areaRing(region, type, id) {
  if (has(region, 'geoms')) {
    const rings = await regionTry(region, 'geoms');
    const c = rings && rings[`${type}-${id}`];
    return c ? unflat(c) : null;
  }
  return regionTry(region, `geom/${type}-${id}`);
}

export function filesFor(region, bounds, { streets = true } = {}) {
  const paths = Object.keys(region.files).filter((p) => !p.startsWith('streets/'));
  if (streets && region.streets) {
    paths.push(...streetTilesIn(bounds, region.streets.tile).map((k) => `streets/${k}`).filter((p) => has(region, p)));
  }
  return paths;
}

export function bytesFor(region, paths) {
  return paths.reduce((s, p) => s + (region.files[p] || 0), 0);
}

export async function warm(region, paths, { onProgress = () => {}, signal } = {}) {
  const cache = await openCache();
  if (!cache) throw new Error('Kein Cache-Speicher verfügbar');
  let done = 0, failed = 0;
  const queue = paths.slice();
  const worker = async () => {
    while (queue.length) {
      if (signal?.aborted) throw new Error('abgebrochen');
      const p = queue.shift();
      const url = fileUrl(region, p);
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url, { signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await cache.put(url, res);
        }
      } catch (e) {
        if (signal?.aborted) throw e;
        failed++;
      }
      done++;
      onProgress(done, paths.length);
    }
  };
  // Eigene statische Dateien über HTTP/2: zehn gleichzeitig sind für GitHub Pages kein
  // Problem und verkürzen vor allem auf Mobilfunk die Wartezeit erheblich
  await Promise.all(Array.from({ length: Math.min(10, paths.length) }, worker));
  return { done, failed };
}

export async function cachedCount(region) {
  const cache = await openCache();
  if (!cache) return 0;
  const keys = await cache.keys();
  return keys.filter((r) => r.url.includes(`/data/${region.id}/`) && r.url.includes(`v=${region.version}`)).length;
}

/* ---------- Vorgebaute Karte ---------- */
// Das Kartenbild der Region als eine PMTiles-Datei (scripts/region/basemap.mjs). Online
// holt die Karte nur die sichtbaren Bytebereiche; offline liefert der Service Worker sie
// aus der gespeicherten Datei.

export function hasMap(region) {
  return !!(region && region.map && region.map.file);
}

export function mapUrl(region) {
  return new URL(`${BASE}${region.id}/${region.map.file}?v=${region.map.version}`, globalThis.location?.href || 'http://localhost/').toString();
}

// Region, deren Karte das Spielgebiet (oder ohne Gebiet: den Kartenmittelpunkt) abdeckt
export function mapRegionFor(bounds, point) {
  const r = bounds ? regionForBounds(bounds) : regionAt(point);
  return hasMap(r) ? r : null;
}

export async function mapStored(region) {
  const cache = await openCache();
  return !!(cache && hasMap(region) && (await cache.match(mapUrl(region))));
}

// Die ganze Karte in einem Stück auf das Gerät – eine Anfrage statt Hunderter Kacheln
export async function downloadMap(region, { onProgress = () => {}, signal } = {}) {
  const cache = await openCache();
  if (!cache) throw new Error('Kein Cache-Speicher verfügbar');
  const url = mapUrl(region);
  if (await cache.match(url)) { onProgress(region.map.bytes, region.map.bytes); return { bytes: region.map.bytes, cached: true }; }
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Karte: HTTP ${res.status}`);
  const total = +res.headers.get('Content-Length') || region.map.bytes;
  const reader = res.body.getReader();
  const teile = [];
  let geladen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    teile.push(value);
    geladen += value.length;
    onProgress(geladen, total);
  }
  const blob = new Blob(teile, { type: 'application/octet-stream' });
  await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(blob.size) } }));
  return { bytes: blob.size, cached: false };
}

// Ablage für vorab heruntergeladene Spielgebietsdaten.
//
// Liegt im Cache Storage statt in localStorage: Orte und Geometrien sind zusammen
// schnell ein paar Megabyte, und der Spielstand soll davon frei bleiben. Die Schlüssel
// sind gewöhnliche Pfade, damit sich der Bestand notfalls im Browser ansehen lässt.

import { areaContains, areaBounds } from './constraints.js';
import { distance } from './geo.js';

export const BUNDLE_CACHE = 'jetlag-bundle-v1';
const PREFIX = './_bundle/';

let meta = null;

function keyFor(path) {
  return new URL(PREFIX + path + '.json', location.href).toString();
}

export async function bundlePut(path, data) {
  const cache = await caches.open(BUNDLE_CACHE);
  await cache.put(keyFor(path), new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  }));
}

export async function bundleGet(path) {
  if (!('caches' in window)) return null;
  const cache = await caches.open(BUNDLE_CACHE);
  const hit = await cache.match(keyFor(path));
  if (!hit) return null;
  try { return await hit.json(); } catch (e) { return null; }
}

export async function initBundle() {
  meta = await bundleGet('meta');
  return meta;
}

export function bundleMeta() {
  return meta;
}

export async function setBundleMeta(next) {
  meta = next;
  await bundlePut('meta', next);
}

// Deckt der vorhandene Bestand diesen Punkt ab? Entscheidet, ob eine Abfrage
// offline beantwortet werden kann oder ans Netz muss.
export function bundleCovers(point) {
  if (!meta || !meta.area || !point) return false;
  return areaContains(meta.area, point);
}

export async function clearBundle() {
  await caches.delete(BUNDLE_CACHE);
  meta = null;
}

export async function bundleStats() {
  if (!('caches' in window)) return { entries: 0, bytes: 0 };
  const cache = await caches.open(BUNDLE_CACHE);
  const keys = await cache.keys();
  let bytes = 0;
  for (const k of keys) {
    const res = await cache.match(k);
    if (!res) continue;
    const buf = await res.clone().arrayBuffer();
    bytes += buf.byteLength;
  }
  return { entries: keys.length, bytes };
}

// Wie weit reicht das Gebiet vom Mittelpunkt aus? Für Suchradien beim Vorabladen.
export function areaRadius(area) {
  const b = areaBounds(area);
  if (!b) return 0;
  const c = { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 };
  return Math.max(
    distance(c, { lat: b.south, lng: b.west }),
    distance(c, { lat: b.north, lng: b.east }),
  );
}

export function areaCenter(area) {
  if (area && area.type === 'circle') return area.center;
  const b = areaBounds(area);
  if (!b) return null;
  return { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 };
}

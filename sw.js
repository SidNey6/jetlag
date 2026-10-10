// Service Worker: App-Shell offline halten, Kartenkacheln aus dem vorgeladenen
// Cache bedienen, Overpass niemals cachen (veraltete Geodaten wären schlimmer als
// eine ehrliche Fehlermeldung).

const VERSION = 'v1.10.1';
const APP_CACHE = `jetlag-app-${VERSION}`;
const TILE_CACHE = 'jetlag-tiles-v1';
const REGION_CACHE = 'jetlag-region-v1';   // wie in js/region.js

const SHELL = [
  './',
  './index.html',
  './offline.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/state.js',
  './js/geo.js',
  './js/constraints.js',
  './js/mask.js',
  './js/map.js',
  './js/location.js',
  './js/questions.js',
  './js/overpass.js',
  './js/timers.js',
  './js/rounds.js',
  './js/random.js',
  './js/share.js',
  './js/tiles.js',
  './js/tilemath.js',
  './js/more.js',
  './js/rules.js',
  './js/sources.js',
  './js/elevation.js',
  './js/phases.js',
  './js/zone.js',
  './js/bundle.js',
  './js/prefetch.js',
  './js/streets.js',
  './js/endgame.js',
  './js/wakelock.js',
  './js/osmgeo.js',
  './js/region.js',
  './js/compute.js',
  './js/worker.js',
  './rules/lifack.json',
  './js/ui/ui.js',
  './js/ui/icons.js',
  './vendor/leaflet/LICENSE',
  './vendor/lucide/LICENSE',
  './vendor/qrcode/LICENSE',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './vendor/qrcode/qrcode.js',
  './vendor/protomaps-leaflet/protomaps-leaflet.js',
  './vendor/protomaps-leaflet/LICENSE',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon.png',
];

const TILE_PATH = /\/\d{1,2}\/\d+\/\d+(@2x)?\.(png|jpe?g|webp|avif)$/i;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    // Einzeln statt addAll: eine fehlende Datei soll nicht die ganze Installation kippen
    await Promise.all(SHELL.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (e) { console.warn('[sw] nicht vorgeladen:', url); }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith('jetlag-app-') && n !== APP_CACHE)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'VERSION') event.source?.postMessage({ type: 'VERSION', version: VERSION });
  if (event.data?.type === 'MAP_CHANGED') mapBlobs.clear();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Overpass & andere APIs: immer direkt ans Netz
  if (url.hostname.includes('overpass')) return;

  // Kartenkacheln: erst Cache, dann Netz (und dabei nachlegen)
  if (url.origin !== location.origin && TILE_PATH.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req.url);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req.url, res.clone());
        return res;
      } catch (e) {
        // Ohne Netz und ohne Kachel: transparentes Bild statt kaputtem Symbol
        return new Response(TRANSPARENT_PNG(), { headers: { 'Content-Type': 'image/png' } });
      }
    })());
    return;
  }

  if (url.origin !== location.origin) return;

  // Vorgebaute Karte: die Kartenbibliothek fragt einzelne Bytebereiche an. Liegt die
  // Datei auf dem Gerät, werden sie hier herausgeschnitten – sonst geht es ans Netz.
  if (url.pathname.includes('/data/') && url.pathname.endsWith('.pmtiles')) {
    event.respondWith(serveMap(req));
    return;
  }

  // Regionsdaten verwaltet region.js selbst (eigener Cache, versionierte Adressen)
  if (url.pathname.includes('/data/')) return;

  // Seitenaufrufe: Netz zuerst, damit Updates sofort greifen; offline die Shell
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (e) {
        const cache = await caches.open(APP_CACHE);
        return (await cache.match('./index.html')) || (await cache.match('./offline.html')) || Response.error();
      }
    })());
    return;
  }

  // Eigene Dateien: aus dem Cache ausliefern und im Hintergrund auffrischen
  event.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await network) || Response.error();
  })());
});

// Geöffnete Kartendateien bleiben im Speicher; Blob-Ausschnitte kosten dann nichts mehr
const mapBlobs = new Map();

async function serveMap(req) {
  let blob = mapBlobs.get(req.url);
  if (!blob) {
    const hit = await (await caches.open(REGION_CACHE)).match(req.url);
    if (!hit) return fetch(req);
    blob = await hit.blob();
    mapBlobs.clear();
    mapBlobs.set(req.url, blob);
  }
  const size = blob.size;
  const range = /^bytes=(\d*)-(\d*)$/.exec((req.headers.get('Range') || '').trim());
  if (!range) {
    return new Response(blob, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  }
  let start, end;
  if (range[1] === '') { start = Math.max(0, size - Number(range[2])); end = size - 1; }
  else { start = Number(range[1]); end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1); }
  if (!(start <= end) || start >= size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

function TRANSPARENT_PNG() {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

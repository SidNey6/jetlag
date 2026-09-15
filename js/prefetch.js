// Spielgebiet vorbereiten: alles einmal herunterladen, was im Spiel gebraucht wird,
// damit unterwegs weder Empfang noch Wartezeit nötig sind.
//
// Bewusst als einzelner, angekündigter Vorgang mit Pausen zwischen den Abfragen:
// Overpass ist gespendete Infrastruktur, und ein Schwall von 30 Abfragen wäre unfein.
// Dafür läuft danach die ganze Runde ohne eine einzige weitere Abfrage.

import { areaBounds } from './constraints.js';
import { CATEGORIES, REFERENCES, poisInBox, areasInBox, findNearestFeatures } from './overpass.js';
import { bundlePut, setBundleMeta, areaCenter, areaRadius } from './bundle.js';
import { tileList, downloadTiles } from './tiles.js';
import * as Rules from './rules.js';

const PAUSE_MS = 900;

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('abgebrochen')); }, { once: true });
    }
  });
}

function expand(bounds, meters) {
  const dLat = meters / 111320;
  const mid = (bounds.south + bounds.north) / 2;
  const dLng = meters / (111320 * Math.max(0.2, Math.cos(mid * Math.PI / 180)));
  return {
    south: bounds.south - dLat, north: bounds.north + dLat,
    west: bounds.west - dLng, east: bounds.east + dLng,
  };
}

// Welche Kategorien und Bezugsobjekte braucht das aktive Regelwerk wirklich?
export function neededSources() {
  const rules = Rules.getRules();
  const pois = new Set();
  const refs = new Set();
  if (rules) {
    for (const q of rules.questions) {
      for (const o of q.options) {
        if (!o.osm) continue;
        if (q.id === 'measuring') refs.add(o.osm); else pois.add(o.osm);
      }
    }
  }
  // Ohne Regelwerk das Nötigste für die freien Werkzeuge
  if (!pois.size) ['station', 'museum', 'park', 'hospital', 'library'].forEach((x) => pois.add(x));
  if (!refs.size) ['motorway', 'river', 'station', 'park'].forEach((x) => refs.add(x));
  return {
    pois: [...pois].filter((id) => CATEGORIES.some((c) => c.id === id)),
    refs: [...refs].filter((id) => REFERENCES.some((r) => r.id === id)),
  };
}

export function planSteps(area, { withTiles = true, zoomExtra = 3 } = {}) {
  const { pois, refs } = neededSources();
  return {
    pois, refs,
    schritte: pois.length + refs.length + 1 + (withTiles ? 1 : 0),
    kacheln: withTiles ? estimateTiles(area, zoomExtra) : 0,
  };
}

export function estimateTiles(area, zoomExtra = 3) {
  const b = areaBounds(area);
  if (!b) return 0;
  const z = zoomForArea(area);
  return tileList(b, Math.max(1, z - 1), Math.min(19, z + zoomExtra), 4000).length;
}

// Grundzoom nach Gebietsgröße: ein 5-km-Gebiet lohnt mehr Detail als ein 200-km-Gebiet.
export function zoomForArea(area) {
  const r = areaRadius(area);
  if (r < 3000) return 14;
  if (r < 8000) return 13;
  if (r < 20000) return 12;
  if (r < 60000) return 11;
  return 10;
}

export async function prepareArea(area, { onProgress = () => {}, signal, withTiles = true, zoomExtra = 3 } = {}) {
  const center = areaCenter(area);
  const bounds = areaBounds(area);
  if (!center || !bounds) throw new Error('Kein Spielgebiet gesetzt');

  const { pois, refs } = neededSources();
  // Was viel weiter weg liegt als das Spielgebiet groß ist, wird nicht vorgeladen –
  // dafür bliebe es online abrufbar. Sonst zöge eine ferne Küste halbe Länder herunter.
  const reichweiteKm = Math.round(areaRadius(area) / 1000 * 4 + 80);
  const gesamt = pois.length + refs.length + 1 + (withTiles ? 1 : 0);
  let erledigt = 0;
  const fehler = [];
  const zaehler = { pois: 0, refs: 0, orte: 0, kacheln: 0 };

  const schritt = (text) => onProgress({ erledigt, gesamt, text });
  const weiter = () => { erledigt++; };

  // Orte je Kategorie – im Rechteck, damit das ganze Gebiet abgedeckt ist
  const box = expand(bounds, 2000);
  for (const id of pois) {
    if (signal?.aborted) throw new Error('abgebrochen');
    const label = CATEGORIES.find((c) => c.id === id)?.label || id;
    schritt(`Orte: ${label}`);
    try {
      const found = await poisInBox(box, id);
      await bundlePut(`pois/${id}`, found.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, name: p.name })));
      zaehler.pois += found.length;
    } catch (e) {
      fehler.push(`${label}: ${e.message || e}`);
    }
    weiter();
    await pause(PAUSE_MS, signal);
  }

  // Bezugsobjekte mit Geometrie
  for (const id of refs) {
    if (signal?.aborted) throw new Error('abgebrochen');
    const label = REFERENCES.find((r) => r.id === id)?.label || id;
    schritt(`Bezugsobjekt: ${label}`);
    try {
      const res = await findNearestFeatures(center, id, { area, maxKm: reichweiteKm });
      await bundlePut(`refs/${id}`, res.features);
      zaehler.refs += res.features.length;
    } catch (e) {
      fehler.push(`${label}: ${e.message || e}`);
    }
    weiter();
    await pause(PAUSE_MS, signal);
  }

  // Orts- und Gebietsliste für die Gebietsauswahl
  if (!signal?.aborted) {
    schritt('Orte und Grenzen');
    try {
      const areas = await areasInBox(box);
      await bundlePut('areas', areas);
      zaehler.orte = areas.length;
    } catch (e) {
      fehler.push(`Gebiete: ${e.message || e}`);
    }
    weiter();
  }

  // Kartenkacheln
  if (withTiles && !signal?.aborted) {
    const z = zoomForArea(area);
    const liste = tileList(bounds, Math.max(1, z - 1), Math.min(19, z + zoomExtra), 4000);
    try {
      const res = await downloadTiles(liste, (done, total) => {
        onProgress({ erledigt, gesamt, text: `Kartenkacheln ${done} / ${total}` });
      }, signal || new AbortController().signal);
      zaehler.kacheln = res.done - res.failed;
    } catch (e) {
      fehler.push(`Kacheln: ${e.message || e}`);
    }
    weiter();
  }

  const meta = {
    area,
    at: Date.now(),
    regelwerk: Rules.getRules()?.name || null,
    kategorien: pois,
    bezugsobjekte: refs,
    zaehler,
    fehler,
  };
  await setBundleMeta(meta);
  onProgress({ erledigt: gesamt, gesamt, text: 'fertig' });
  return meta;
}

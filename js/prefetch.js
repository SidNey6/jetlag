// Spielgebiet vorbereiten: alles einmal herunterladen, was im Spiel gebraucht wird,
// damit unterwegs weder Empfang noch Wartezeit nötig sind.
//
// Bewusst als einzelner, angekündigter Vorgang mit Pausen zwischen den Abfragen:
// Overpass ist gespendete Infrastruktur, und ein Schwall von 30 Abfragen wäre unfein.
// Dafür läuft danach die ganze Runde ohne eine einzige weitere Abfrage.

import { areaBounds } from './constraints.js';
import { poisInBox, areasInBox, findNearestFeatures, adminAreasInBox, bundleKey, STOP_CATEGORIES } from './overpass.js';
import { POI_CATEGORIES, REFERENCES, poiCategory, reference } from './sources.js';
import { fetchElevationGrid } from './elevation.js';
import { bundlePut, setBundleMeta, areaCenter, areaRadius } from './bundle.js';
import { tileList, downloadTiles } from './tiles.js';
import * as Rules from './rules.js';
import * as Region from './region.js';
import { getState } from './state.js';

// Unterhalb dieser Zoomstufe bleibt es auch in Regionen bei OSM-Kacheln (siehe map.js)
const VECTOR_MIN_ZOOM = 10;

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

// Welche Daten braucht das aktive Regelwerk wirklich? Entschieden wird über den
// Fragetyp jeder Option, nicht über Kategorienamen – damit gilt das für jedes Regelwerk.
export function neededSources() {
  const rules = Rules.getRules();
  const pois = new Set();
  const refs = new Map();       // Schlüssel → { id, params }
  const adminLevels = new Set();
  let elevation = false;

  const addRef = (id, params = {}) => {
    const spec = reference(id);
    if (!spec || spec.kind === 'elevation') { if (spec) elevation = true; return; }
    if (spec.param && params[spec.param] == null) return;
    // Nahbereichsquellen lassen sich nicht fürs ganze Gebiet vorladen
    if (spec.localKm) return;
    refs.set(bundleKey(id, params), { id, params });
  };

  if (rules) {
    for (const q of rules.questions) {
      for (const o of q.options) {
        const typ = 'appType' in o ? o.appType : q.appType;
        const ids = o.osm == null ? [] : (Array.isArray(o.osm) ? o.osm : [o.osm]);
        const params = o.adminLevel ? { adminLevel: o.adminLevel } : {};
        if (typ === 'elevation') elevation = true;
        if (typ === 'area' && o.adminLevel) adminLevels.add(o.adminLevel);
        for (const id of ids) {
          if (typ === 'compare' || typ === 'side' || typ === 'area') addRef(id, params);
          else if (typ === 'nearest') {
            if (poiCategory(id) && o.match !== 'shape') pois.add(id); else addRef(id, params);
          } else if (poiCategory(id)) pois.add(id);
        }
      }
    }
    const anker = rules.hidingZone && rules.hidingZone.anchorCategory;
    if (anker) pois.add(anker);
  }
  // Ohne Regelwerk das Nötigste für die freien Werkzeuge
  if (!pois.size) ['station', 'museum', 'park', 'hospital', 'library'].forEach((x) => pois.add(x));
  if (!refs.size) ['motorway', 'river', 'station', 'park'].forEach((x) => addRef(x));
  // Haltestellen immer: das Endgame startet mit langem Drücken auf eine davon, und
  // das soll auch im Funkloch gehen
  STOP_CATEGORIES.forEach((x) => pois.add(x));

  return {
    pois: [...pois].filter((id) => POI_CATEGORIES.some((c) => c.id === id)),
    refs: [...refs.values()].filter((r) => REFERENCES.some((x) => x.id === r.id)),
    adminLevels: [...adminLevels].sort((a, b) => a - b),
    elevation,
  };
}

// Liegt das Spielgebiet in einer Region mit vorgebauten Daten, werden statt der
// OSM-Abfragen nur deren Dateien in den Offline-Speicher geholt.
export function regionFor(area) {
  const b = areaBounds(area);
  return b ? Region.regionForBounds(expand(b, 2000)) : null;
}

// Region, deren vorgebaute Karte das ganze Spielgebiet zeigt – dann wird statt Hunderter
// Kacheln eine einzige Datei geladen
export function mapRegionFor(area) {
  if (getState().settings.regionMap === false) return null;
  const b = areaBounds(area);
  const r = b ? Region.regionForBounds(expand(b, 1000)) : null;
  return Region.hasMap(r) ? r : null;
}

// Übersichtskacheln unterhalb der Regionskarte: nur eine Handvoll
function overviewTiles(bounds) {
  return tileList(bounds, 6, VECTOR_MIN_ZOOM - 1, 200);
}

export function planSteps(area, { withTiles = true, zoomExtra = 3, withStreets = true } = {}) {
  const { pois, refs, adminLevels, elevation } = neededSources();
  const region = regionFor(area);
  const regionFiles = region ? Region.filesFor(region, expand(areaBounds(area), 2000), { streets: withStreets }) : [];
  const osmSchritte = region ? 1 : pois.length + refs.length + adminLevels.length + 1;
  return {
    pois, refs, adminLevels, elevation, region, regionFiles,
    regionBytes: region ? Region.bytesFor(region, regionFiles) : 0,
    schritte: osmSchritte + (elevation ? 1 : 0) + (withTiles ? 1 : 0),
    kacheln: withTiles ? estimateTiles(area, zoomExtra) : 0,
    karte: withTiles ? mapRegionFor(area) : null,
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

export async function prepareArea(area, { onProgress = () => {}, signal, withTiles = true, zoomExtra = 3, withStreets = true } = {}) {
  const center = areaCenter(area);
  const bounds = areaBounds(area);
  if (!center || !bounds) throw new Error('Kein Spielgebiet gesetzt');

  const region = regionFor(area);
  const { pois, refs, adminLevels, elevation } = region
    ? { ...neededSources(), pois: [], refs: [], adminLevels: [] }
    : neededSources();
  // Was viel weiter weg liegt als das Spielgebiet groß ist, wird nicht vorgeladen –
  // dafür bliebe es online abrufbar. Sonst zöge eine ferne Küste halbe Länder herunter.
  const reichweiteKm = Math.round(areaRadius(area) / 1000 * 4 + 80);
  const gesamt = (region ? 1 : pois.length + refs.length + adminLevels.length + 1) + (elevation ? 1 : 0) + (withTiles ? 1 : 0);
  let erledigt = 0;
  const fehler = [];
  const zaehler = { pois: 0, refs: 0, orte: 0, gebiete: 0, hoehe: 0, kacheln: 0, region: 0, karte: 0 };

  // Kartenkacheln kommen von einem anderen Server als die Ortsdaten – deshalb gleich zu
  // Beginn starten und parallel laufen lassen, statt hinterher. Der Fortschritt zählt
  // den Kachelanteil anteilig mit.
  let kacheln = { done: 0, total: 0 };
  let kachelText = () => (kacheln.total && kacheln.done < kacheln.total ? ` · Karte ${kacheln.done} / ${kacheln.total}` : '');
  const stand = () => erledigt + (withTiles && kacheln.total ? kacheln.done / kacheln.total : 0);
  let letzterText = '';
  const melde = (text) => { letzterText = text; onProgress({ erledigt: Math.min(stand(), gesamt), gesamt, text: text + kachelText() }); };
  const schritt = (text) => melde(text);
  const weiter = () => { erledigt++; };

  let kachelLauf = null;
  const karte = withTiles ? mapRegionFor(area) : null;
  if (karte && !signal?.aborted) {
    // Vorgebaute Regionskarte: eine Datei, ein Abruf – dazu die paar Übersichtskacheln
    const mb = (b) => (b / 1048576).toFixed(1).replace('.', ',');
    kacheln = { done: 0, total: karte.map.bytes };
    kachelText = () => (kacheln.done < kacheln.total ? ` · Karte ${mb(kacheln.done)} / ${mb(kacheln.total)} MB` : '');
    kachelLauf = Promise.all([
      Region.downloadMap(karte, {
        signal,
        onProgress: (done, total) => { kacheln = { done, total }; melde(letzterText || 'Karte'); },
      }).then((res) => { zaehler.karte = res.bytes; }),
      downloadTiles(overviewTiles(bounds), () => {}, signal || new AbortController().signal)
        .then((res) => { zaehler.kacheln = res.done - res.failed; }),
    ]).catch((e) => { if (!signal?.aborted) fehler.push(`Karte: ${e.message || e}`); });
  } else if (withTiles && !signal?.aborted) {
    const z = zoomForArea(area);
    const liste = tileList(bounds, Math.max(1, z - 1), Math.min(19, z + zoomExtra), 4000);
    kacheln = { done: 0, total: liste.length };
    kachelLauf = downloadTiles(liste, (done, total) => {
      kacheln = { done, total };
      melde(letzterText || 'Kartenkacheln');
    }, signal || new AbortController().signal)
      .then((res) => { zaehler.kacheln = res.done - res.failed; })
      .catch((e) => { fehler.push(`Kacheln: ${e.message || e}`); });
  }

  // Vorgebaute Regionsdaten: ein paar Megabyte statischer Dateien statt dutzender
  // Overpass-Abfragen
  if (region) {
    const paths = Region.filesFor(region, expand(bounds, 2000), { streets: withStreets });
    schritt(`Regionsdaten ${region.name}`);
    try {
      const res = await Region.warm(region, paths, {
        signal,
        onProgress: (d, t) => melde(`Regionsdaten ${d} / ${t}`),
      });
      zaehler.region = res.done - res.failed;
      if (res.failed) fehler.push(`Regionsdaten: ${res.failed} Dateien nicht geladen`);
    } catch (e) {
      if (signal?.aborted) throw e;
      fehler.push(`Regionsdaten: ${e.message || e}`);
    }
    weiter();
  }

  // Orte je Kategorie – im Rechteck, damit das ganze Gebiet abgedeckt ist
  const box = expand(bounds, 2000);
  for (const id of pois) {
    if (signal?.aborted) throw new Error('abgebrochen');
    const label = poiCategory(id)?.label || id;
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

  // Bezugsobjekte mit Geometrie (auch Linien für "nächste Buslinie" und
  // Verwaltungsgrenzen einer bestimmten Ebene)
  for (const { id, params } of refs) {
    if (signal?.aborted) throw new Error('abgebrochen');
    const spec = reference(id);
    const label = spec.label + (params.adminLevel ? ` (Ebene ${params.adminLevel})` : '');
    schritt(`Bezugsobjekt: ${label}`);
    try {
      const res = await findNearestFeatures(center, id, { area, maxKm: reichweiteKm, params });
      await bundlePut(bundleKey(id, params), res.features);
      zaehler.refs += res.features.length;
    } catch (e) {
      fehler.push(`${label}: ${e.message || e}`);
    }
    weiter();
    await pause(PAUSE_MS, signal);
  }

  // Verwaltungsgebiete je Ebene samt Umriss ("ist dein Stadtteil derselbe?")
  for (const level of adminLevels) {
    if (signal?.aborted) throw new Error('abgebrochen');
    schritt(`Verwaltungsgebiete Ebene ${level}`);
    try {
      const liste = await adminAreasInBox(box, level);
      await bundlePut(`admin/${level}`, liste);
      zaehler.gebiete += liste.length;
    } catch (e) {
      fehler.push(`Ebene ${level}: ${e.message || e}`);
    }
    weiter();
    await pause(PAUSE_MS, signal);
  }

  // Geländehöhen für Fragen nach dem Meeresspiegel
  if (elevation && !signal?.aborted) {
    schritt('Geländehöhen');
    try {
      const grid = await fetchElevationGrid(expand(bounds, 1500), { signal });
      await bundlePut('elevation', grid);
      zaehler.hoehe = grid.values.length;
    } catch (e) {
      fehler.push(`Höhen: ${e.message || e}`);
    }
    weiter();
  }

  // Orts- und Gebietsliste für die Gebietsauswahl
  if (!region && !signal?.aborted) {
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

  // Auf die Karte warten, die parallel geladen wird
  if (kachelLauf) {
    if (erledigt < gesamt - 1) erledigt = gesamt - 1;
    melde(karte ? 'Karte' : 'Kartenkacheln');
    await kachelLauf;
    weiter();
  }

  const meta = {
    area,
    at: Date.now(),
    region: region ? { id: region.id, name: region.name, version: region.version } : null,
    karte: karte ? { id: karte.id, version: karte.map.version, bytes: karte.map.bytes } : null,
    regelwerk: Rules.getRules()?.name || null,
    kategorien: pois,
    bezugsobjekte: refs.map((r) => bundleKey(r.id, r.params)),
    ebenen: adminLevels,
    hoehe: elevation,
    zaehler,
    fehler,
  };
  await setBundleMeta(meta);
  onProgress({ erledigt: gesamt, gesamt, text: 'fertig' });
  return meta;
}

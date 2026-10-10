// OpenStreetMap-Abfragen über Overpass: Orte im Umkreis, nächstgelegenes Objekt,
// Verwaltungsgrenzen. Alles optional – ohne Netz bleibt die App voll bedienbar,
// die Dialoge sagen dann nur klar, dass hier Empfang nötig ist.

import { getState } from './state.js';
import { areaBounds } from './constraints.js';
import { bundleGet, bundleCovers } from './bundle.js';
import * as Region from './region.js';
import { distance, formatDistance, destination, circle, distanceToFeatures, pointInPolygon, simplify } from './geo.js';
import { el, clear, openSheet, toast } from './ui/ui.js';
import { POI_CATEGORIES, REFERENCES, poiCategory, reference, referenceStatements, poiStatements } from './sources.js';
import {
  toPoints, stopKind, STOP_CATEGORIES, STOP_LABEL, STREET_FILTER, featuresFrom, routeFeaturesFrom, mergeLines, fitBudget,
  stitchOuterRing, PLACE_RE, ADMIN_RE, GROUPS, areaCandidate, dedupeAreas, slimRing,
} from './osmgeo.js';

export { POI_CATEGORIES, REFERENCES, reference, STOP_CATEGORIES, GROUPS };

// Reihenfolge = Vorzug. overpass.osm.jp fiel raus: ungültiges Zertifikat.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const cache = new Map();
const STAGGER_MS = 6000; // so lange bekommt ein Spiegel Vorsprung, bevor der nächste mitläuft

// Spiegel gestaffelt statt nacheinander abfragen: ein hängender Server hat sonst
// bis zu drei volle Zeitlimits blockiert, bevor überhaupt eine Antwort kam.
// Der erste brauchbare Treffer gewinnt, die übrigen Anfragen werden abgebrochen.
// Overpass ist geteilte Infrastruktur und drosselt; die Meldung soll das sagen,
// statt nur eine Statusnummer zu zeigen.
function httpHint(status) {
  if (status === 429) return 'Zu viele Anfragen – Overpass bittet um eine kurze Pause';
  if (status === 504) return 'Overpass ist gerade überlastet';
  if (status === 400) return 'Abfrage wurde abgelehnt (HTTP 400)';
  return `HTTP ${status}`;
}

function query(ql) {
  if (cache.has(ql)) return Promise.resolve(cache.get(ql));
  const timeout = (getState().settings.overpassTimeout || 25) * 1000;

  return new Promise((resolve, reject) => {
    const controllers = [];
    const timers = [];
    let started = 0, failures = 0, settled = false, lastErr = null;

    const cleanup = (winner) => {
      timers.forEach(clearTimeout);
      controllers.forEach((c) => { if (c !== winner) c.abort(); });
    };

    const startNext = () => {
      if (settled || started >= ENDPOINTS.length) return;
      const url = ENDPOINTS[started++];
      const ctrl = new AbortController();
      controllers.push(ctrl);
      timers.push(setTimeout(() => ctrl.abort(), timeout));
      timers.push(setTimeout(startNext, STAGGER_MS));

      fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(ql), signal: ctrl.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(httpHint(res.status));
          const json = await res.json();
          if (settled) return;
          settled = true;
          cleanup(ctrl);
          cache.set(ql, json);
          resolve(json);
        })
        .catch((err) => {
          if (settled) return;
          failures++;
          lastErr = err;
          if (failures >= ENDPOINTS.length) {
            settled = true;
            cleanup(null);
            reject(new Error(lastErr?.name === 'AbortError'
              ? 'Zeitüberschreitung – Overpass antwortet gerade nicht (oft Drosselung nach vielen Abfragen)'
              : String(lastErr?.message || lastErr)));
          } else {
            startNext();
          }
        });
    };

    startNext();
  });
}

function aroundUnion(statements, center, radiusM) {
  const around = `(around:${Math.round(radiusM)},${center.lat.toFixed(6)},${center.lng.toFixed(6)})`;
  return '(' + statements.map((st) => `${st}${around};`).join('') + ')';
}

function boxUnion(statements, bounds) {
  const box = `(${bounds.south.toFixed(6)},${bounds.west.toFixed(6)},${bounds.north.toFixed(6)},${bounds.east.toFixed(6)})`;
  return '(' + statements.map((st) => `${st}${box};`).join('') + ')';
}

export async function findPois(center, categoryId, radiusM, namedOnly = true) {
  await Region.initRegions();
  const cat = poiCategory(categoryId);
  if (!cat) throw new Error(`Unbekannte Kategorie "${categoryId}"`);

  // Vorgebaute Regionsdaten und vorab geladener Vorrat kosten kein Netz und keine Wartezeit
  const region = Region.regionForCircle(center, radiusM);
  const vorrat = (region ? await Region.regionTry(region, `pois/${categoryId}`) : null)
    || (bundleCovers(center) ? await bundleGet(`pois/${categoryId}`) : null);
  if (vorrat) {
    return vorrat
      .map((p) => ({ ...p, distance: distance(center, p) }))
      .filter((p) => p.distance <= radiusM)
      .sort((a, b) => a.distance - b.distance);
  }
  const ql = `[out:json][timeout:${getState().settings.overpassTimeout || 25}];`
    + `${aroundUnion(poiStatements(cat), center, radiusM)};out center tags;`;
  const json = await query(ql);
  return toPoints(json, { namedOnly })
    .map((p) => ({ ...p, distance: distance(center, p) }))
    .sort((a, b) => a.distance - b.distance);
}

// Orte mehrerer Kategorien in einem großen Umkreis – etwa alle Stationen fürs ganze
// Spielgebiet. coveredM sagt, bis wohin sicher alle geladen sind: in der Region bis zu
// ihrem Rand, sonst der ganze Umkreis.
export async function findPoisCovering(center, categoryIds, radiusM) {
  await Region.initRegions();
  const region = Region.regionAt(center);
  let liste = null;
  let coveredM = radiusM;
  if (region && categoryIds.every((id) => Region.has(region, `pois/${id}`))) {
    coveredM = Math.min(radiusM, Region.edgeDistance(region, center));
    liste = [];
    for (const id of categoryIds) {
      const vorrat = await Region.regionTry(region, `pois/${id}`);
      if (!vorrat) { liste = null; break; }
      for (const p of vorrat) liste.push({ ...p, kind: id });
    }
  }
  if (!liste) {
    coveredM = radiusM;
    liste = [];
    for (const id of categoryIds) liste.push(...(await findPois(center, id, radiusM)).map((p) => ({ ...p, kind: id })));
  }
  const gesehen = new Set();
  const pois = liste
    .map((p) => ({ ...p, distance: distance(center, p) }))
    .filter((p) => p.distance <= radiusM && !gesehen.has(p.id) && gesehen.add(p.id))
    .sort((a, b) => a.distance - b.distance);
  return { pois, coveredM };
}

/* ---------- Endgame: Haltestellen und Straßennetz ---------- */

// Haltestellen aller Art um einen angetippten Punkt – eine Abfrage statt drei, damit
// das lange Drücken auf der Karte nicht in Overpass' Drosselung läuft.
export async function findStopsNear(center, radiusM) {
  await Region.initRegions();
  const label = STOP_LABEL;
  let found = [];
  const region = Region.regionForCircle(center, radiusM);
  for (const id of STOP_CATEGORIES) {
    const vorrat = (region ? await Region.regionTry(region, `pois/${id}`) : null)
      || (bundleCovers(center) ? await bundleGet(`pois/${id}`) : null);
    if (vorrat) found.push(...vorrat.map((p) => ({ ...p, kind: id })));
  }
  if (!found.length) {
    const statements = STOP_CATEGORIES.flatMap((id) => poiStatements(poiCategory(id)));
    const ql = `[out:json][timeout:${getState().settings.overpassTimeout || 25}];`
      + `${aroundUnion(statements, center, radiusM)};out center tags;`;
    found = toPoints(await query(ql), { kindOf: stopKind });
  }
  const nah = found
    .map((p) => ({ ...p, distance: distance(center, p), kindLabel: p.kind ? label[p.kind] : null }))
    .filter((p) => p.distance <= radiusM)
    .sort((a, b) => a.distance - b.distance);
  // Dieselbe Station steht oft als Bahnhof und als Bahnsteig der Stadtbahn darin
  const out = [];
  for (const p of nah) {
    if (!out.some((q) => q.name === p.name && distance(p, q) < 150)) out.push(p);
  }
  return out;
}

// Begehbare Wege im Umkreis. Gehwege neben der Fahrbahn, Querungen, Einfahrten und
// Parkplatzgassen bleiben draußen (Filter in osmgeo.js).
export async function loadStreets(center, radiusM) {
  await Region.initRegions();
  const region = Region.regionAt(center);
  if (Region.streetsCover(region, center, radiusM)) {
    try { return await Region.regionStreets(region, center, radiusM); } catch (e) { /* weiter mit Overpass */ }
  }
  const ql = `[out:json][timeout:${getState().settings.overpassTimeout || 25}];`
    + `${STREET_FILTER}(around:${Math.round(radiusM)},${center.lat.toFixed(6)},${center.lng.toFixed(6)});out geom;`;
  const json = await query(ql);
  return (json.elements || [])
    .filter((e) => e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length > 1)
    .map((e) => ({
      id: e.id,
      nodes: Array.isArray(e.nodes) && e.nodes.length === e.geometry.length ? e.nodes : null,
      pts: e.geometry.map((g) => [+g.lat.toFixed(7), +g.lon.toFixed(7)]),
      h: e.tags && e.tags.highway,
    }));
}

/* ---------- Bezugsobjekte: Geometrie für Abstands- und Linienfragen ---------- */

// Vergleichsfragen ("näher oder weiter als ich?") beziehen sich oft auf ausgedehnte
// Objekte: Autobahnen, Grenzen, Küsten, Flüsse, Buslinien. Dafür gibt es keinen
// sinnvollen Punkt – deshalb wird die echte Geometrie geholt und der Abstand zum
// nächstgelegenen Punkt des Objekts gerechnet. Die Registry steht in sources.js.
const KM = 1000;

function aroundQuery(statements, center, km, timeout) {
  return `[out:json][timeout:${timeout}];${aroundUnion(statements, center, km * KM)};out geom 2000;`;
}

// Linienrelationen (Bus, Tram, Zug) reichen oft durch die halbe Region. Statt ihre
// komplette Geometrie zu laden, werden die Relationen nur mit Mitgliederliste geholt
// und davon ausschließlich die Wegstücke im benötigten Umkreis mit Koordinaten.
function routeQuery(statements, center, km, coverM, timeout) {
  const around = (r) => `(around:${Math.round(r)},${center.lat.toFixed(6)},${center.lng.toFixed(6)})`;
  return `[out:json][timeout:${timeout}];`
    + `(${statements.map((st) => `${st}${around(km * KM)};`).join('')})->.routes;`
    + '.routes out body;'
    + `way(r.routes)${around(coverM)};out geom;`;
}

export function bundleKey(refId, params) {
  const p = Object.entries(params || {}).map(([k, v]) => `${k}=${v}`).join(',');
  return p ? `refs/${refId}@${p}` : `refs/${refId}`;
}

// Geometrie einer Referenz holen: erst das nächste Exemplar finden, dann so weit
// nachladen, dass das ganze Spielgebiet plus der gemessene Abstand abgedeckt ist –
// sonst läge ein Punkt am anderen Ende des Gebiets scheinbar weit vom Objekt weg,
// nur weil dessen Teilstücke dort nicht mitgeladen wurden.
async function loadReference(center, refId, { area = null, maxKm = null, params = {}, partOfMany = false } = {}) {
  const spec = reference(refId);
  if (!spec) throw new Error(`Unbekanntes Bezugsobjekt "${refId}"`);
  if (spec.kind === 'elevation') throw new Error(`"${spec.label}" ist ein Höhenwert, keine Geometrie`);
  const statements = referenceStatements(spec, params);
  if (!statements.length) throw new Error(`Für "${spec.label}" ist keine Abfrage hinterlegt`);
  const timeout = getState().settings.overpassTimeout || 25;

  if (spec.localKm) return loadLocal(center, spec, statements, timeout);

  // Eine von mehreren Quellen, die es in der Region nicht gibt: nicht online suchen –
  // die anderen Quellen tragen die Frage
  if (partOfMany) {
    await Region.initRegions();
    const region = Region.regionAt(center);
    if (Region.knownEmpty(region, bundleKey(refId, params))) throw new Error(`${spec.label}: in ${region.name} nicht vorhanden`);
  }

  // Vorgebaute Regionsdaten: reicht die Region weit genug, ist das die Antwort. Sonst
  // dient sie als Rückfall, falls Overpass nicht erreichbar ist.
  const ausRegion = await referenceFromRegion(center, spec, bundleKey(refId, params), area);
  if (ausRegion && ausRegion.complete) return ausRegion.result;

  const vorrat = bundleCovers(center) ? await bundleGet(bundleKey(refId, params)) : null;
  if (vorrat && vorrat.length) {
    return {
      spec,
      feats: vorrat.map((f) => ({ ...f, distance: distanceToFeatures(center, [f]) }))
        .sort((a, b) => a.distance - b.distance),
      coveredKm: null,
      coveredM: Infinity,
      offline: true,
    };
  }

  try {
    return await referenceOnline(center, spec, statements, { area, maxKm, timeout });
  } catch (e) {
    if (ausRegion) return ausRegion.result;
    throw e;
  }
}

async function referenceFromRegion(center, spec, key, area) {
  await Region.initRegions();
  const region = Region.regionAt(center);
  if (!region || !Region.has(region, key)) return null;
  const all = await Region.regionTry(region, key);
  if (!all || !all.length) return null;
  const mit = all.map((f) => ({ ...f, distance: distanceToFeatures(center, [f]) }))
    .sort((a, b) => a.distance - b.distance);

  // Vollständig ist die Antwort, wenn für jeden Punkt des Spielgebiets das nächste
  // Objekt näher liegt als der Rand der Region – dann kann außerhalb nichts Näheres
  // fehlen. Geprüft an Ecken, Kantenmitten und Mitte des Gebiets und am Standort.
  // (Vorher zählte der Kreis vom Standort bis zur fernsten Gebietsecke – der ragte bei
  // einem Bonner Spielgebiet fast immer über die Region hinaus, und jede Frage ging
  // unnötig an Overpass.)
  let complete = true;
  let reichweite = mit[0].distance;
  for (const p of samplePoints(center, area)) {
    const d = distanceToFeatures(p, mit);
    if (!Number.isFinite(d) || !Region.circleInside(region.bounds, p, d)) complete = false;
    reichweite = Math.max(reichweite, distance(center, p) + d);
  }
  // Nur, was für irgendeinen Punkt im Gebiet das nächste sein kann
  const kept = mit.filter((f) => f.distance <= reichweite * 1.05 + 100);
  const slim = fitBudget(kept).map((f) => ({
    type: f.type, name: f.name, key: f.key, distance: f.distance, points: f.points,
  }));
  return {
    complete,
    result: {
      spec, feats: slim, coveredKm: Math.ceil(reichweite / KM), offline: true, region: region.name,
      // Bis hierhin ist nichts weggelassen; ist die Region vollständig, gilt sie überall
      coveredM: complete ? Infinity : reichweite * 1.05 + 100,
    },
  };
}

function samplePoints(center, area) {
  const b = area ? areaBounds(area) : boxAround(center, 5 * KM);
  const midLat = (b.south + b.north) / 2, midLng = (b.west + b.east) / 2;
  return [
    center,
    { lat: midLat, lng: midLng },
    { lat: b.south, lng: b.west }, { lat: b.south, lng: b.east }, { lat: b.north, lng: b.west }, { lat: b.north, lng: b.east },
    { lat: b.south, lng: midLng }, { lat: b.north, lng: midLng }, { lat: midLat, lng: b.west }, { lat: midLat, lng: b.east },
  ];
}

function boxAround(center, radiusM) {
  const n = destination(center, 0, radiusM), s = destination(center, 180, radiusM);
  const e = destination(center, 90, radiusM), w = destination(center, 270, radiusM);
  return { south: s.lat, north: n.lat, west: w.lng, east: e.lng };
}

async function referenceOnline(center, spec, statements, { area, maxKm, timeout }) {
  // Bus- und Bahnlinien sind lokale Bezüge: "dieselbe nächste Tram?" ist in einem
  // Stadtspiel sinnlos, wenn die nächste Tram 60 km entfernt fährt – und genau diese
  // Stufen ziehen ganze Verkehrsnetze. Deshalb enden Linien-Suchen nahe am Gebiet.
  let obergrenze = maxKm;
  if (spec.geom === 'lines') {
    const lokal = Math.max(8, (radiusToCover(center, area) / KM) * 3);
    obergrenze = obergrenze ? Math.min(obergrenze, lokal) : lokal;
  }
  const leiter = obergrenze ? spec.ladder.filter((km) => km <= obergrenze) : spec.ladder;
  if (!leiter.length) throw new Error(`${spec.label}: liegt weiter als ${Math.round(obergrenze)} km entfernt`);

  let hitKm = null;
  let feats = [];
  const flaeche = radiusToCover(center, area);
  for (const km of leiter) {
    feats = spec.geom === 'lines'
      ? routeFeaturesFrom(await query(routeQuery(statements, center, km, (flaeche + km * KM) * 1.1, timeout)), center)
      : featuresFrom(await query(aroundQuery(statements, center, km, timeout)), spec, center);
    if (feats.length) { hitKm = km; break; }
  }
  if (!feats.length) throw new Error(`${spec.label}: nichts im Umkreis von ${leiter[leiter.length - 1]} km gefunden`);

  // Linienrelationen sind oben schon mit Gebietsabdeckung geladen
  const neededKm = (flaeche + feats[0].distance) / KM * 1.1;
  if (spec.geom !== 'lines' && neededKm > hitKm) {
    const wider = featuresFrom(await query(aroundQuery(statements, center, Math.ceil(neededKm), timeout)), spec, center);
    if (wider.length) feats = wider;
  }

  // Linienrelationen in ihren Wegen lassen (gemeinsame Stücke, siehe compactCandidates)
  const merged = (spec.geom === 'lines' ? feats : mergeLines(feats, !!spec.directed))
    .map((f) => ({ ...f, distance: distanceToFeatures(center, [f]) }))
    .sort((a, b) => a.distance - b.distance);
  const slim = fitBudget(merged).map((f) => ({
    type: f.type, name: f.name, key: f.key, distance: f.distance, points: f.points,
  }));
  const coveredKm = Math.max(hitKm, Math.ceil(neededKm));
  return { spec, feats: slim, coveredKm, coveredM: coveredKm * KM, offline: false };
}

// Für Vergleichsfragen: alle Geometrie einer oder mehrerer Referenzen als ein Satz.
// "Bus-, Bahn-, Zug-Linie oder Autobahn" ist eine Option mit mehreren Quellen –
// gemessen wird dann zum nächsten Objekt irgendeiner davon.
export async function findNearestFeatures(center, refIds, opts = {}) {
  const ids = Array.isArray(refIds) ? refIds : [refIds];
  // Quellen parallel laden; eine fehlende Quelle ("keine Stadtbahn hier") ist kein
  // Fehler, solange eine andere etwas liefert
  const settled = await Promise.allSettled(ids.map((id) => loadReference(center, id, { ...opts, partOfMany: ids.length > 1 })));
  const results = settled.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  const fehler = settled.filter((x) => x.status === 'rejected').map((x) => x.reason);
  if (!results.length) throw fehler[0] || new Error('Keine Geometrie gefunden');

  const features = results.flatMap((r) => r.feats).sort((a, b) => a.distance - b.distance);
  const label = results.map((r) => r.spec.label).join(' / ');
  return {
    label,
    features,
    distance: features[0].distance,
    name: features[0].name,
    coveredKm: Math.max(...results.map((r) => r.coveredKm || 0)) || null,
    // Umkreis, in dem garantiert alle Objekte geladen sind
    coveredM: Math.min(...results.map((r) => r.coveredM ?? Infinity)),
    offline: results.every((r) => r.offline),
  };
}

// Benannte Straßen und andere dichte Quellen: nur im Nahbereich, dafür vollständig.
// Mit Regionsdaten aus den Straßenkacheln, sonst eine Overpass-Abfrage.
async function loadLocal(center, spec, statements, timeout) {
  await Region.initRegions();
  const radius = spec.localKm * KM;
  let feats = null;
  let offline = false;
  const region = Region.regionAt(center);
  if (spec.id === 'street' && Region.streetsCover(region, center, radius)) {
    try {
      const wege = await Region.regionStreets(region, center, radius);
      feats = wege.filter((w) => w.name).map((w) => ({
        type: 'line', name: w.name, key: `n:${w.name}`,
        points: w.pts.map(([lat, lng]) => ({ lat, lng })),
      }));
      offline = true;
    } catch (e) { feats = null; }
  }
  if (!feats) {
    feats = featuresFrom(await query(aroundQuery(statements, center, spec.localKm, timeout)), spec, center);
  }
  // Fein vereinfachen: Straßen liegen oft nur 30 m auseinander
  const merged = mergeLines(feats)
    .map((f) => ({ ...f, points: f.points.length > 4 ? simplify(f.points, 0.00002) : f.points }))
    .map((f) => ({ type: f.type, name: f.name, key: f.key, points: f.points, distance: distanceToFeatures(center, [f]) }))
    .filter((f) => f.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
  if (!merged.length) throw new Error(`${spec.label}: nichts im Umkreis von ${spec.localKm} km`);
  return { spec, feats: merged, coveredKm: spec.localKm, coveredM: radius, offline };
}

// Für "ist dein nächstes X dasselbe wie meines?" bei Linien und Flächen: Objekte mit
// Identität, jeweils alle zugehörigen Teilstücke gebündelt.
export async function findCandidates(center, refIds, { limit = 40, ...opts } = {}) {
  const res = await findNearestFeatures(center, refIds, opts);
  const byKey = new Map();
  for (const f of res.features) {
    const key = f.key || `${f.type}:${f.points[0].lat},${f.points[0].lng}`;
    if (!byKey.has(key)) byKey.set(key, { id: key, name: f.name || 'ohne Namen', features: [], distance: f.distance });
    const c = byKey.get(key);
    c.features.push({ type: f.type, points: f.points });
    if (f.distance < c.distance) c.distance = f.distance;
  }
  const alle = [...byKey.values()].sort((a, b) => a.distance - b.distance);
  const candidates = alle.slice(0, limit);
  // Was nicht in der Liste ist, liegt mindestens so weit weg – bis dahin ist sie vollständig
  const cutoffM = Math.min(res.coveredM ?? Infinity, alle.length > limit ? alle[limit].distance : Infinity);
  return { label: res.label, candidates, offline: res.offline, cutoffM };
}

// Für "gleiche Flussseite?": Gesucht ist kein nächstes Objekt, sondern ein Fluss, an
// dem man sich orientiert – der Rhein, auch wenn ein Bach näher liegt. Deshalb alle
// benannten Flüsse samt ihrem ganzen Verlauf, ohne Abschneiden nach Entfernung.
// Unbenannte Gewässer fallen weg: nach denen kann man nicht fragen.
const SEITE_UMKREIS_KM = 20;

export async function findSideCandidates(center, refIds, { limit = 8 } = {}) {
  await Region.initRegions();
  const ids = Array.isArray(refIds) ? refIds : [refIds];
  const region = Region.regionAt(center);
  let feats = [];
  let offline = false;
  if (region) {
    for (const id of ids) {
      const liste = await Region.regionTry(region, bundleKey(id));
      if (liste) feats.push(...liste);
    }
    offline = feats.length > 0;
  }
  if (!feats.length) {
    const timeout = getState().settings.overpassTimeout || 25;
    for (const id of ids) {
      const spec = reference(id);
      const json = await query(aroundQuery(referenceStatements(spec), center, SEITE_UMKREIS_KM, timeout));
      feats.push(...mergeLines(featuresFrom(json, spec, center), !!spec.directed));
    }
  }

  const byKey = new Map();
  for (const f of feats) {
    if (!f.name || f.type !== 'line') continue;
    if (!byKey.has(f.key)) byKey.set(f.key, { id: f.key, name: f.name, features: [], distance: Infinity });
    const c = byKey.get(f.key);
    c.features.push({ type: f.type, points: f.points });
  }
  const candidates = [...byKey.values()]
    .map((c) => ({ ...c, distance: distanceToFeatures(center, c.features) }))
    .filter((c) => c.distance <= SEITE_UMKREIS_KM * KM)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((c) => ({ ...c, features: fitBudget(c.features, 4000).map((f) => ({ type: f.type, points: f.points })) }));
  if (!candidates.length) throw new Error(`Kein benannter Fluss im Umkreis von ${SEITE_UMKREIS_KM} km`);
  return { candidates, offline };
}

// Wie weit reicht das Spielgebiet von hier aus? Danach richtet sich die Abdeckung.
function radiusToCover(center, area) {
  const b = area ? areaBounds(area) : null;
  if (!b) return 5 * KM;
  const ecken = [
    { lat: b.south, lng: b.west }, { lat: b.south, lng: b.east },
    { lat: b.north, lng: b.west }, { lat: b.north, lng: b.east },
  ];
  return Math.max(...ecken.map((c) => distance(center, c)));
}

/* ---------- Gebiete: Verwaltungsgrenzen, Orte, Ortsteile, Dörfer ---------- */

// Nicht jedes Dorf ist eine Verwaltungsgrenze. In OSM stecken kleine Orte je nach
// Gegend als boundary=administrative (Ebene 9–11), als place-Fläche oder nur als
// place-Knoten ohne Umriss. Gesucht wird deshalb über beide Schienen.
function bboxAround(center, radius) {
  const n = destination(center, 0, radius), e = destination(center, 90, radius);
  const sth = destination(center, 180, radius), w = destination(center, 270, radius);
  return { south: sth.lat, north: n.lat, west: w.lng, east: e.lng };
}

// Alle Gebiete im Umkreis – nicht nur die, in denen man gerade steht.
// Genau daran scheiterte das Auswählen einzelner Dörfer vorher.
export async function findAreas(center, radius) {
  await Region.initRegions();
  const region = Region.regionForCircle(center, radius);
  const vorrat = (region ? await Region.regionTry(region, 'areas') : null)
    || (bundleCovers(center) ? await bundleGet('areas') : null);
  if (vorrat) {
    return vorrat
      .map((c) => ({ ...c, distance: distance(center, c) }))
      .filter((c) => c.distance <= radius)
      .sort((a, b) => (a.tier - b.tier) || (a.distance - b.distance));
  }

  const b = bboxAround(center, radius);
  const box = `(${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)})`;
  const ql = `[out:json][timeout:${getState().settings.overpassTimeout || 25}];`
    + '('
    + `relation["boundary"="administrative"]["admin_level"~"${ADMIN_RE}"]${box};`
    + `relation["place"~"${PLACE_RE}"]${box};`
    + `way["place"~"${PLACE_RE}"]${box};`
    + `node["place"~"${PLACE_RE}"]${box};`
    + ');out tags center;';
  const json = await query(ql);

  const list = (json.elements || []).map(areaCandidate).filter(Boolean)
    .map((c) => ({ ...c, distance: distance(center, c) }));
  return dedupeAreas(list).sort((a, b2) => (a.tier - b2.tier) || (a.distance - b2.distance)).slice(0, 120);
}

// Welche Gebiete enthalten den Punkt? Nur zum Markieren in der Liste.
export async function areaKeysAt(point) {
  await Region.initRegions();
  // Mit Regionsdaten: in welchen Verwaltungsgebieten liegt der Punkt?
  const region = Region.regionAt(point);
  if (region) {
    const keys = new Set();
    for (const path of Object.keys(region.files).filter((p) => p.startsWith('admin/'))) {
      const liste = await Region.regionTry(region, path);
      for (const a of liste || []) if (pointInPolygon(point, a.ring)) keys.add(`relation/${a.id}`);
    }
    if (keys.size) return keys;
  }
  const ql = `[out:json][timeout:${getState().settings.overpassTimeout || 25}];`
    + `is_in(${point.lat.toFixed(6)},${point.lng.toFixed(6)})->.a;`
    + '(relation(pivot.a);way(pivot.a););out ids;';
  const json = await query(ql);
  return new Set((json.elements || []).map((e) => `${e.type}/${e.id}`));
}

export async function areaGeometry(cand) {
  await Region.initRegions();
  if (cand.type === 'node') return null;
  const region = Region.regionAt(cand);
  const ausRegion = region ? await Region.regionTry(region, `geom/${cand.type}-${cand.id}`) : null;
  if (ausRegion) return ausRegion;
  const ql = `[out:json][timeout:60];${cand.type}(${cand.id});out geom;`;
  const json = await query(ql);
  const el0 = (json.elements || []).find((e) => e.type === cand.type);
  if (!el0) throw new Error('Keine Geometrie erhalten');

  const ring = el0.type === 'way'
    ? (el0.geometry || []).map((g) => ({ lat: g.lat, lng: g.lon }))
    : stitchOuterRing(el0.members || []);
  if (!ring || ring.length < 3) throw new Error('Umriss ließ sich nicht zusammensetzen');

  return slimRing(ring);
}

// Gebiet einer bestimmten Verwaltungsebene am Standort – für Regeloptionen wie
// "Stadtteil" oder "Gemeinde", ohne dass jemand aus einer Liste wählen muss.
// Welche Ebene was bedeutet, ist regional verschieden (Bonn: 8 Stadt, 9 Stadtbezirk,
// 10 Ortsteil) und steht deshalb im Regelwerk, nicht hier.
export async function adminAreaAt(point, level) {
  await Region.initRegions();
  const region = Region.regionAt(point);
  const ausRegion = region ? await Region.regionTry(region, `admin/${level}`) : null;
  for (const vorrat of [ausRegion, bundleCovers(point) ? await bundleGet(`admin/${level}`) : null]) {
    const hit = (vorrat || []).find((a) => pointInPolygon(point, a.ring));
    if (hit) return { ...hit, offline: true };
  }
  // Kreise, Gemeinden und Ortsteile sind in den Regionsdaten vollständig – fehlt dort
  // eins, gibt es keins (Bonn hat z. B. keine Ebene 8). Landes- und Bezirksgrenzen
  // reichen über den Auszug hinaus und werden deshalb online nachgefragt.
  if (ausRegion && level >= 6) throw new Error(`Hier gibt es kein Gebiet der Verwaltungsebene ${level}`);
  const ql = `[out:json][timeout:${getState().settings.overpassTimeout || 25}];`
    + `is_in(${point.lat.toFixed(6)},${point.lng.toFixed(6)})->.a;`
    + `relation(pivot.a)["boundary"="administrative"]["admin_level"="${level}"];out ids tags;`;
  const json = await query(ql);
  const rel = (json.elements || [])[0];
  if (!rel) throw new Error(`Hier gibt es kein Gebiet der Verwaltungsebene ${level}`);
  const ring = await areaGeometry({ type: 'relation', id: rel.id });
  return { id: rel.id, name: rel.tags?.name || `Ebene ${level}`, level, ring, offline: false };
}

// Für das Vorabladen: alle Gebiete einer Ebene samt Umriss.
export async function adminAreasInBox(bounds, level) {
  const box = `(${bounds.south.toFixed(6)},${bounds.west.toFixed(6)},${bounds.north.toFixed(6)},${bounds.east.toFixed(6)})`;
  const ql = `[out:json][timeout:60];relation["boundary"="administrative"]["admin_level"="${level}"]${box};out geom;`;
  const json = await query(ql);
  const out = [];
  for (const e of json.elements || []) {
    const ring = stitchOuterRing(e.members || []);
    if (!ring || ring.length < 3) continue;
    out.push({ id: e.id, name: e.tags?.name || `Ebene ${level}`, level, ring: slimRing(ring) });
  }
  return out;
}

// Für das Vorabladen: alles in einem Rechteck statt im Umkreis eines Punktes.
export async function poisInBox(bounds, categoryId, namedOnly = true) {
  const cat = poiCategory(categoryId);
  if (!cat) throw new Error(`Unbekannte Kategorie "${categoryId}"`);
  const ql = `[out:json][timeout:${getState().settings.overpassTimeout || 25}];`
    + `${boxUnion(poiStatements(cat), bounds)};out center tags;`;
  return toPoints(await query(ql), { namedOnly });
}

export async function areasInBox(bounds) {
  const box = `(${bounds.south.toFixed(6)},${bounds.west.toFixed(6)},${bounds.north.toFixed(6)},${bounds.east.toFixed(6)})`;
  const ql = `[out:json][timeout:${getState().settings.overpassTimeout || 25}];`
    + '('
    + `relation["boundary"="administrative"]["admin_level"~"${ADMIN_RE}"]${box};`
    + `relation["place"~"${PLACE_RE}"]${box};`
    + `way["place"~"${PLACE_RE}"]${box};`
    + `node["place"~"${PLACE_RE}"]${box};`
    + ');out tags center;';
  const json = await query(ql);
  return (json.elements || []).map(areaCandidate).filter(Boolean);
}

/* ---------- Dialoge ---------- */

function busyBox(text) {
  return el('div', { class: 'card' }, el('div', { class: 'card-title', text }), el('div', { class: 'progress' }, el('i', { style: { width: '35%' } })));
}

function netErrorBox(e) {
  return el('div', { class: 'card' },
    el('div', { class: 'card-title', text: 'Abfrage fehlgeschlagen' }),
    el('div', { class: 'card-sub', text: String(e && e.message || e) }),
    el('div', { class: 'hint', text: 'Ohne Empfang: Punkte per „Auf Karte" selbst setzen – alles andere funktioniert offline.' }));
}

export function poiSheet(center, onResult) {
  if (!center) return toast('Erst einen Standort brauchen', 'error');
  let category = 'station';
  let radius = 3000;
  openSheet('Orte im Umkreis laden', (body, close) => {
    const cats = el('div', { class: 'pills' }, POI_CATEGORIES.map((c) => el('button', {
      class: `pill ${c.id === category ? 'on' : ''}`,
      onclick: (e) => {
        category = c.id;
        body.querySelectorAll('.pills .pill').forEach((p) => p.classList.remove('on'));
        e.target.classList.add('on');
      },
    }, c.label)));
    const radiusSel = el('select', {}, [300, 500, 1000, 2000, 3000, 5000, 10000, 15000, 25000, 50000].map((r) =>
      el('option', { value: String(r), selected: r === radius }, formatDistance(r))));
    radiusSel.addEventListener('change', () => { radius = parseInt(radiusSel.value, 10); });
    const out = el('div', { class: 'panel-body', style: { padding: '0', maxHeight: '40vh' } });

    body.append(
      el('label', { class: 'field' }, 'Kategorie', cats),
      el('label', { class: 'field' }, 'Umkreis', radiusSel),
      out,
    );

    return [
      el('button', { class: 'btn grow', onclick: () => close() }, 'Schließen'),
      el('button', {
        class: 'btn grow btn-primary',
        onclick: async (ev) => {
          const btn = ev.target;
          btn.disabled = true;
          clear(out).append(busyBox('Suche läuft …'));
          try {
            const found = await findPois(center, category, radius);
            clear(out);
            if (!found.length) { out.append(el('div', { class: 'empty', text: 'Nichts gefunden – größeren Umkreis probieren.' })); return; }
            out.append(el('div', { class: 'hint', text: `${found.length} Orte gefunden` }));
            for (const p of found.slice(0, 60)) {
              out.append(el('div', { class: 'row' },
                el('div', { class: 'grow' }, el('div', { text: p.name }), el('div', { class: 'card-sub', text: formatDistance(p.distance) }))));
            }
            out.append(el('button', {
              class: 'btn btn-primary btn-wide', style: { marginTop: '10px' },
              onclick: () => { close(); onResult(found.slice(0, 60).map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, name: p.name }))); },
            }, `${Math.min(found.length, 60)} Orte übernehmen`));
          } catch (e) {
            clear(out).append(netErrorBox(e));
          } finally {
            btn.disabled = false;
          }
        },
      }, 'Suchen'),
    ];
  });
}

export function areaPickerSheet(center, onPick) {
  if (!center) return toast('Erst einen Standort brauchen', 'error');
  let radius = 5000;
  let filter = '';
  let found = [];
  let here = new Set();

  openSheet('Gebiet wählen', (body, close) => {
    const out = el('div', { class: 'panel-body', style: { padding: '0', maxHeight: '46vh' } });

    const radiusSel = el('select', {}, [1000, 2000, 3000, 5000, 10000, 20000, 50000].map((r) =>
      el('option', { value: String(r), selected: r === radius }, formatDistance(r))));
    radiusSel.addEventListener('change', () => { radius = parseInt(radiusSel.value, 10); run(); });

    const search = el('input', { placeholder: 'Name filtern …' });
    search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); paint(); });

    function paint() {
      clear(out);
      const rows = found.filter((c) => !filter || c.name.toLowerCase().includes(filter));
      if (!rows.length) {
        out.append(el('div', { class: 'empty', text: found.length ? 'Kein Treffer für den Filter.' : 'Nichts gefunden – größeren Umkreis wählen.' }));
        return;
      }
      let tier = null;
      for (const c of rows) {
        if (c.tier !== tier) {
          tier = c.tier;
          out.append(el('div', { class: 'hint', style: { marginTop: '10px', fontWeight: '600' }, text: GROUPS[tier] || 'Weitere' }));
        }
        const inside = here.has(c.key);
        out.append(el('button', {
          class: 'card', style: { textAlign: 'left' },
          onclick: (ev) => choose(c, ev.currentTarget),
        },
          el('div', { class: 'card-title' },
            el('span', { class: 'grow', text: c.name }),
            inside ? el('span', { class: 'card-sub', text: 'hier' }) : null),
          el('div', { class: 'card-sub', text: `${c.kind} · ${formatDistance(c.distance)}${c.hasGeometry ? '' : ' · ohne Umriss'}` })));
      }
    }

    async function choose(c, card) {
      if (!c.hasGeometry) { close(); circleForPlace(c, onPick); return; }
      card.style.opacity = '.5';
      try {
        const ring = await areaGeometry(c);
        close();
        onPick({ ring, name: c.name, level: c.kind });
        toast(`${c.name} geladen (${ring.length} Punkte)`, 'ok');
      } catch (e) {
        card.style.opacity = '';
        toast(String(e.message || e), 'error');
      }
    }

    async function run() {
      clear(out).append(busyBox('Frage OpenStreetMap …'));
      const [a, h] = await Promise.allSettled([findAreas(center, radius), areaKeysAt(center)]);
      if (a.status === 'rejected') { clear(out).append(netErrorBox(a.reason)); return; }
      found = a.value;
      here = h.status === 'fulfilled' ? h.value : new Set();
      paint();
    }

    body.append(
      el('div', { class: 'hint', text: 'Dörfer, Ortsteile und Stadtviertel stehen oben, größere Gebiete darunter.' }),
      el('label', { class: 'field' }, 'Umkreis', radiusSel),
      el('label', { class: 'field' }, 'Suchen', search),
      out,
    );
    run();

    return [el('button', { class: 'btn grow', onclick: () => close() }, 'Schließen')];
  });
}

// Kleine Orte stehen in OSM oft nur als Punkt ohne Umriss. Statt sie wegzulassen,
// wird daraus ein Kreis – für eine Frage nach „bist du in X?" reicht das meist.
function circleForPlace(c, onPick) {
  let radius = 800;
  openSheet(c.name, (body, close) => {
    body.append(
      el('div', { class: 'card-sub', text: `${c.kind} – in OpenStreetMap ohne Umriss hinterlegt. Als Kreis um den Ortsmittelpunkt verwenden?` }),
      el('label', { class: 'field' }, 'Radius',
        el('div', { class: 'pills' }, [300, 500, 800, 1200, 2000, 3000, 5000].map((r) => el('button', {
          class: `pill ${r === radius ? 'on' : ''}`,
          onclick: (ev) => {
            radius = r;
            ev.target.parentElement.querySelectorAll('.pill').forEach((p) => p.classList.remove('on'));
            ev.target.classList.add('on');
          },
        }, formatDistance(r))))),
    );
    return [
      el('button', { class: 'btn grow', onclick: () => close() }, 'Abbrechen'),
      el('button', {
        class: 'btn grow btn-primary',
        onclick: () => {
          close();
          onPick({ ring: circle({ lat: c.lat, lng: c.lng }, radius, 64), name: c.name, level: `${c.kind} (Kreis)` });
        },
      }, 'Übernehmen'),
    ];
  });
}

// OpenStreetMap-Abfragen über Overpass: Orte im Umkreis, nächstgelegenes Objekt,
// Verwaltungsgrenzen. Alles optional – ohne Netz bleibt die App voll bedienbar,
// die Dialoge sagen dann nur klar, dass hier Empfang nötig ist.

import { getState } from './state.js';
import { areaBounds } from './constraints.js';
import { bundleGet, bundleCovers } from './bundle.js';
import { distance, formatDistance, simplify, destination, circle, distanceToFeatures } from './geo.js';
import { el, clear, openSheet, toast } from './ui/ui.js';

// Reihenfolge = Vorzug. overpass.osm.jp fiel raus: ungültiges Zertifikat.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export const CATEGORIES = [
  { id: 'station',    label: 'Bahnhöfe',      filter: '["railway"="station"]' },
  { id: 'tram',       label: 'Tram/U-Bahn',   filter: '["railway"~"^(tram_stop|subway_entrance)$"]' },
  { id: 'bus',        label: 'Bushaltestellen', filter: '["highway"="bus_stop"]' },
  { id: 'museum',     label: 'Museen',        filter: '["tourism"="museum"]' },
  { id: 'park',       label: 'Parks',         filter: '["leisure"="park"]' },
  { id: 'hospital',   label: 'Krankenhäuser', filter: '["amenity"="hospital"]' },
  { id: 'worship',    label: 'Kirchen',       filter: '["amenity"="place_of_worship"]' },
  { id: 'school',     label: 'Schulen',       filter: '["amenity"="school"]' },
  { id: 'university', label: 'Hochschulen',   filter: '["amenity"="university"]' },
  { id: 'library',    label: 'Bibliotheken',  filter: '["amenity"="library"]' },
  { id: 'supermarket', label: 'Supermärkte',   filter: '["shop"="supermarket"]' },
  { id: 'zoo',        label: 'Zoos',          filter: '["tourism"="zoo"]' },
  { id: 'aquarium',   label: 'Aquarien',      filter: '["tourism"="aquarium"]' },
  { id: 'theme_park', label: 'Freizeitparks', filter: '["tourism"="theme_park"]' },
  { id: 'cinema',     label: 'Kinos',         filter: '["amenity"="cinema"]' },
  { id: 'golf',       label: 'Golfplätze',    filter: '["leisure"="golf_course"]' },
  { id: 'viewpoint',  label: 'Aussichtspunkte', filter: '["tourism"="viewpoint"]' },
  { id: 'tower',      label: 'Türme',         filter: '["man_made"="tower"]' },
  { id: 'peak',       label: 'Berggipfel',    filter: '["natural"="peak"]' },
  { id: 'consulate',  label: 'Konsulate',     filter: '["diplomatic"~"consulate|embassy"]' },
  { id: 'stadium',    label: 'Stadien',       filter: '["leisure"="stadium"]' },
  { id: 'airport',    label: 'Flughäfen',     filter: '["aeroway"="aerodrome"]' },
  { id: 'townhall',   label: 'Rathäuser',     filter: '["amenity"="townhall"]' },
  { id: 'castle',     label: 'Burgen/Schlösser', filter: '["historic"="castle"]' },
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

function toPoints(json, { namedOnly = true } = {}) {
  const out = [];
  for (const e of json.elements || []) {
    const lat = e.lat ?? e.center?.lat;
    const lng = e.lon ?? e.center?.lon;
    if (lat == null || lng == null) continue;
    const name = e.tags?.name || null;
    if (namedOnly && !name) continue;
    out.push({ id: `${e.type[0]}${e.id}`, lat, lng, name: name || 'ohne Namen' });
  }
  // Gleichnamige Einträge zusammenfassen: OSM führt dieselbe Station oft mehrfach
  // (Relation, Node, zwei Bahnsteige). Zwei Einträge „Alexanderplatz" in einer
  // Auswahlliste wären für eine Frage nach dem nächsten Ort nicht beantwortbar.
  const seen = [];
  return out.filter((p) => {
    const dup = seen.find((q) => q.name === p.name && distance(p, q) < 400);
    if (dup) return false;
    seen.push(p);
    return true;
  });
}

export async function findPois(center, categoryId, radiusM, namedOnly = true) {
  const cat = CATEGORIES.find((c) => c.id === categoryId);
  if (!cat) throw new Error('Unbekannte Kategorie');

  // Vorab geladene Daten kosten kein Netz und keine Wartezeit
  const vorrat = bundleCovers(center) ? await bundleGet(`pois/${categoryId}`) : null;
  if (vorrat) {
    return vorrat
      .map((p) => ({ ...p, distance: distance(center, p) }))
      .filter((p) => p.distance <= radiusM)
      .sort((a, b) => a.distance - b.distance);
  }
  const ql = `[out:json][timeout:${getState().settings.overpassTimeout || 25}];`
    + `nwr${cat.filter}(around:${Math.round(radiusM)},${center.lat.toFixed(6)},${center.lng.toFixed(6)});out center tags;`;
  const json = await query(ql);
  return toPoints(json, { namedOnly })
    .map((p) => ({ ...p, distance: distance(center, p) }))
    .sort((a, b) => a.distance - b.distance);
}

/* ---------- Bezugsobjekte für Vergleichsfragen ---------- */

// Vergleichsfragen ("näher oder weiter als ich?") beziehen sich oft auf ausgedehnte
// Objekte: Autobahnen, Grenzen, Küsten, Flüsse, Parks. Für die gibt es keinen
// sinnvollen Punkt, den man von Hand setzen könnte – deshalb wird hier die echte
// Geometrie geholt und der Abstand zum nächstgelegenen Punkt des Objekts gerechnet.
// "ladder" ist die Suchradius-Leiter: klein anfangen, bis etwas gefunden wird.
const KM = 1000;

function poiFilter(id) {
  const c = CATEGORIES.find((x) => x.id === id);
  return c ? `nwr${c.filter}` : null;
}

export const REFERENCES = [
  { id: 'motorway',      label: 'Autobahn',                  q: 'way["highway"="motorway"]', geom: 'line',  ladder: [3, 10, 30, 80, 200] },
  { id: 'trunk',         label: 'Schnellstraße',             q: 'way["highway"~"^(motorway|trunk)$"]', geom: 'line', ladder: [3, 10, 30, 80] },
  { id: 'rail',          label: 'Bahnstrecke',               q: 'way["railway"="rail"]["service"!~"."]', geom: 'line', ladder: [2, 8, 25, 80] },
  { id: 'highspeed',     label: 'Schnellfahrstrecke',        q: 'way["railway"="rail"]["highspeed"="yes"]', geom: 'line', ladder: [10, 40, 120, 300] },
  { id: 'border_country', label: 'Staatsgrenze',              q: 'way["boundary"="administrative"]["admin_level"="2"]', geom: 'line', ladder: [15, 50, 120, 300] },
  { id: 'border_admin1', label: 'Grenze Verwaltungsebene 1', q: 'way["boundary"="administrative"]["admin_level"="4"]', geom: 'line', ladder: [8, 30, 90, 250] },
  { id: 'border_admin2', label: 'Grenze Verwaltungsebene 2', q: 'way["boundary"="administrative"]["admin_level"="6"]', geom: 'line', ladder: [4, 15, 50, 150] },
  { id: 'coastline',     label: 'Küstenlinie',               q: 'way["natural"="coastline"]', geom: 'line', ladder: [25, 60, 150, 350, 600] },
  { id: 'river',         label: 'Fluss',                     q: 'way["waterway"="river"]', geom: 'line', ladder: [2, 8, 25, 80] },
  { id: 'water',         label: 'Gewässer',                  q: 'nwr["natural"="water"]', geom: 'auto', ladder: [2, 8, 25, 80] },
  { id: 'mountain',      label: 'Berg',                      q: 'node["natural"="peak"]', geom: 'point', ladder: [5, 20, 60, 180] },
  { id: 'forest',        label: 'Wald',                      q: 'nwr["landuse"="forest"]', geom: 'auto', ladder: [2, 8, 25, 80] },
  { id: 'consulate',     label: 'Ausländische Vertretung',   q: 'nwr["diplomatic"~"consulate|embassy"]', geom: 'auto', ladder: [10, 40, 120, 350] },
  // aus der POI-Liste abgeleitet, damit die Filter nur an einer Stelle stehen
  { id: 'airport',    label: 'Verkehrsflughafen', from: 'airport',    geom: 'auto', ladder: [10, 40, 120, 350] },
  { id: 'station',    label: 'Bahnhof',           from: 'station',    geom: 'auto', ladder: [2, 8, 25, 80] },
  { id: 'park',       label: 'Park',              from: 'park',       geom: 'auto', ladder: [1.5, 5, 15, 50] },
  { id: 'museum',     label: 'Museum',            from: 'museum',     geom: 'auto', ladder: [2, 8, 25, 80] },
  { id: 'cinema',     label: 'Kino',              from: 'cinema',     geom: 'auto', ladder: [3, 12, 40, 120] },
  { id: 'hospital',   label: 'Krankenhaus',       from: 'hospital',   geom: 'auto', ladder: [3, 12, 40, 120] },
  { id: 'library',    label: 'Bibliothek',        from: 'library',    geom: 'auto', ladder: [2, 8, 25, 80] },
  { id: 'zoo',        label: 'Zoo',               from: 'zoo',        geom: 'auto', ladder: [10, 40, 120, 350] },
  { id: 'aquarium',   label: 'Aquarium',          from: 'aquarium',   geom: 'auto', ladder: [10, 40, 120, 350] },
  { id: 'theme_park', label: 'Freizeitpark',      from: 'theme_park', geom: 'auto', ladder: [10, 40, 120, 350] },
  { id: 'golf',       label: 'Golfplatz',         from: 'golf',       geom: 'auto', ladder: [5, 20, 60, 180] },
  { id: 'stadium',    label: 'Stadion',           from: 'stadium',    geom: 'auto', ladder: [5, 20, 60, 180] },
  { id: 'worship',    label: 'Gotteshaus',        from: 'worship',    geom: 'auto', ladder: [1.5, 5, 15, 50] },
];

export function reference(id) {
  return REFERENCES.find((r) => r.id === id) || null;
}

function elementToFeature(e, geomHint) {
  if (e.type === 'node') return { type: 'point', points: [{ lat: e.lat, lng: e.lon }] };
  if (e.type === 'way' && Array.isArray(e.geometry)) {
    const pts = e.geometry.map((g) => ({ lat: g.lat, lng: g.lon }));
    if (pts.length < 2) return null;
    const first = pts[0], last = pts[pts.length - 1];
    const closed = Math.abs(first.lat - last.lat) < 1e-9 && Math.abs(first.lng - last.lng) < 1e-9;
    const type = geomHint === 'line' ? 'line' : (closed ? 'polygon' : 'line');
    return { type, points: closed && type === 'polygon' ? pts.slice(0, -1) : pts };
  }
  if (e.type === 'relation' && Array.isArray(e.members)) {
    const ring = stitchOuterRing(e.members);
    if (ring && ring.length >= 3) return { type: 'polygon', points: ring };
    const line = e.members.find((m) => Array.isArray(m.geometry) && m.geometry.length > 1);
    if (line) return { type: 'line', points: line.geometry.map((g) => ({ lat: g.lat, lng: g.lon })) };
  }
  return null;
}

function featuresFrom(json, spec, center) {
  const out = [];
  for (const e of json.elements || []) {
    const f = elementToFeature(e, spec.geom);
    if (!f || !f.points.length) continue;
    // Autobahnen tragen ihre Nummer in "ref", nicht in "name"
    f.name = e.tags?.name || e.tags?.ref || e.tags?.int_ref || null;
    f.distance = distanceToFeatures(center, [f]);
    out.push(f);
  }
  return out.sort((a, b) => a.distance - b.distance);
}

function aroundQuery(q, center, km, timeout) {
  return `[out:json][timeout:${timeout}];`
    + `(${q}(around:${Math.round(km * KM)},${center.lat.toFixed(6)},${center.lng.toFixed(6)}););`
    + 'out geom 2000;';
}

// OSM zerlegt lange Wege an jeder Kreuzung. Für Abstandsrechnung und Zeichnung sind
// zusammenhängende Linien besser: weniger Zustand, weniger Zeichenoperationen je Bild.
function mergeLines(feats) {
  const lines = feats.filter((f) => f.type === 'line');
  const rest = feats.filter((f) => f.type !== 'line');
  const near = (a, b) => Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;
  const pool = lines.map((f) => ({ points: f.points.slice(), name: f.name }));
  const out = [];

  while (pool.length) {
    const cur = pool.shift();
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < pool.length; i++) {
        const A = cur.points, B = pool[i].points;
        if (near(A[A.length - 1], B[0])) cur.points = A.concat(B.slice(1));
        else if (near(A[A.length - 1], B[B.length - 1])) cur.points = A.concat(B.slice().reverse().slice(1));
        else if (near(A[0], B[B.length - 1])) cur.points = B.slice(0, -1).concat(A);
        else if (near(A[0], B[0])) cur.points = B.slice().reverse().slice(0, -1).concat(A);
        else continue;
        cur.name = cur.name || pool[i].name;
        pool.splice(i, 1);
        extended = true;
        break;
      }
    }
    out.push({ type: 'line', name: cur.name, points: cur.points });
  }
  return [...out, ...rest];
}

// Stützpunkte begrenzen: lieber gröber als einen Spielstand mit 50.000 Koordinaten.
function fitBudget(features, budget = 6000) {
  let eps = 0.0003;
  let out = features;
  const count = (fs) => fs.reduce((n, f) => n + f.points.length, 0);
  while (count(out) > budget && eps < 0.02) {
    out = features.map((f) => ({ ...f, points: f.points.length > 4 ? simplify(f.points, eps) : f.points }));
    eps *= 2;
  }
  return out.map((f) => ({ ...f, points: f.points.length > 8 ? simplify(f.points, 0.0003) : f.points }));
}

// Bezugsobjekt samt Geometrie holen.
//
// Zwei Schritte, und der zweite ist der wichtige: Erst wird das nächstgelegene
// Exemplar gesucht. Dann wird so weit nachgeladen, dass die Geometrie das ganze
// Spielgebiet plus den gemessenen Abstand abdeckt – sonst läge ein Punkt am anderen
// Ende des Gebiets scheinbar weit von der Autobahn weg, nur weil deren Teilstücke
// dort nicht mitgeladen wurden. OSM zerlegt lange Wege in viele kurze Stücke.
export async function findNearestFeatures(center, refId, { area = null, maxKm = null } = {}) {
  const spec = reference(refId);
  if (!spec) throw new Error(`Unbekanntes Bezugsobjekt "${refId}"`);
  const q = spec.q || poiFilter(spec.from);
  if (!q) throw new Error(`Für "${spec.label}" ist keine Abfrage hinterlegt`);
  const timeout = getState().settings.overpassTimeout || 25;

  const vorrat = bundleCovers(center) ? await bundleGet(`refs/${refId}`) : null;
  if (vorrat && vorrat.length) {
    const sortiert = vorrat
      .map((f) => ({ ...f, distance: distanceToFeatures(center, [f]) }))
      .sort((a, b) => a.distance - b.distance);
    return {
      label: spec.label, features: sortiert,
      distance: sortiert[0].distance, name: sortiert[0].name,
      coveredKm: null, offline: true,
    };
  }

  // maxKm begrenzt die Suchleiter – beim Vorabladen soll eine 400 km entfernte
  // Küste nicht das halbe Land herunterziehen.
  const leiter = maxKm ? spec.ladder.filter((km) => km <= maxKm) : spec.ladder;
  if (!leiter.length) {
    throw new Error(`${spec.label}: liegt weiter als ${Math.round(maxKm)} km entfernt`);
  }

  let hitKm = null;
  let feats = [];
  for (const km of leiter) {
    feats = featuresFrom(await query(aroundQuery(q, center, km, timeout)), spec, center);
    if (feats.length) { hitKm = km; break; }
  }
  if (!feats.length) {
    throw new Error(`${spec.label}: nichts im Umkreis von ${leiter[leiter.length - 1]} km gefunden`);
  }

  const nearest = feats[0].distance;
  const neededKm = (radiusToCover(center, area) + nearest) / KM * 1.1;
  if (neededKm > hitKm) {
    const wider = featuresFrom(await query(aroundQuery(q, center, Math.ceil(neededKm), timeout)), spec, center);
    if (wider.length) feats = wider;
  }

  const merged = mergeLines(feats)
    .map((f) => ({ ...f, distance: distanceToFeatures(center, [f]) }))
    .sort((a, b) => a.distance - b.distance);
  const features = fitBudget(merged).map((f) => ({
    type: f.type, name: f.name, distance: f.distance, points: f.points,
  }));
  return {
    label: spec.label,
    features,
    distance: features[0].distance,
    name: features[0].name,
    coveredKm: Math.max(hitKm, Math.ceil(neededKm)),
  };
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
const PLACE_RE = '^(city|borough|town|suburb|village|quarter|neighbourhood|hamlet|isolated_dwelling)$';
const ADMIN_RE = '^(4|5|6|7|8|9|10|11|12)$';

const ADMIN_LABEL = {
  4: 'Bundesland', 5: 'Regierungsbezirk', 6: 'Kreis', 7: 'Amt / Verbandsgemeinde',
  8: 'Gemeinde / Stadt', 9: 'Stadtbezirk', 10: 'Ortsteil', 11: 'Stadtviertel', 12: 'Quartier',
};
const PLACE_LABEL = {
  city: 'Großstadt', borough: 'Stadtbezirk', town: 'Stadt', suburb: 'Stadtteil', village: 'Dorf',
  quarter: 'Quartier', neighbourhood: 'Nachbarschaft', hamlet: 'Weiler',
  isolated_dwelling: 'Einzellage',
};
// Je höher der Rang, desto kleiner das Gebiet – danach wird sortiert, damit Dörfer
// und Ortsteile oben stehen und nicht hinter Bundesland und Kreis verschwinden.
const PLACE_RANK = {
  city: 8, borough: 9, town: 9, suburb: 10, village: 10,
  quarter: 11, neighbourhood: 12, hamlet: 11, isolated_dwelling: 12,
};

const SETTLEMENT = new Set(['city', 'borough', 'town', 'suburb', 'village', 'quarter', 'neighbourhood', 'hamlet', 'isolated_dwelling']);

export const GROUPS = [
  null,
  'Orte, Ortsteile und Viertel',
  'Ganze Gemeinden und Städte',
  'Nur als Punkt erfasst – wird zum Kreis',
  'Größere Gebiete',
];

// Sortiert wird danach, was für eine Spielfrage taugt, nicht danach, was klein ist:
// ein Dorf mit Umriss schlägt einen bloßen Ortspunkt, und Kreis oder Bundesland
// gehören ans Ende statt dazwischen.
export function areaTier(c) {
  const lvl = c.tags.admin_level ? parseInt(c.tags.admin_level, 10) : null;
  const settlement = SETTLEMENT.has(c.tags.place);
  const wide = c.tags.place === 'city' || c.tags.place === 'town';
  const small = (lvl != null && lvl >= 9) || (settlement && !wide);
  if (c.hasGeometry && small) return 1;
  if (c.hasGeometry && (lvl === 8 || wide)) return 2;
  if (!c.hasGeometry && settlement) return 3;
  return 4;
}

export function areaRank(tags = {}) {
  if (tags.admin_level) return parseInt(tags.admin_level, 10) || 13;
  return PLACE_RANK[tags.place] ?? 13;
}

export function areaKindLabel(tags = {}) {
  const parts = [];
  if (PLACE_LABEL[tags.place]) parts.push(PLACE_LABEL[tags.place]);
  if (ADMIN_LABEL[tags.admin_level]) parts.push(ADMIN_LABEL[tags.admin_level]);
  else if (tags.admin_level) parts.push(`Ebene ${tags.admin_level}`);
  return parts.join(' · ') || 'Gebiet';
}

function bboxAround(center, radius) {
  const n = destination(center, 0, radius), e = destination(center, 90, radius);
  const sth = destination(center, 180, radius), w = destination(center, 270, radius);
  return { south: sth.lat, north: n.lat, west: w.lng, east: e.lng };
}

// Alle Gebiete im Umkreis – nicht nur die, in denen man gerade steht.
// Genau daran scheiterte das Auswählen einzelner Dörfer vorher.
export async function findAreas(center, radius) {
  const vorrat = bundleCovers(center) ? await bundleGet('areas') : null;
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

  const list = [];
  for (const e of json.elements || []) {
    const tags = e.tags || {};
    if (!tags.name) continue;
    const lat = e.lat ?? e.center?.lat;
    const lng = e.lon ?? e.center?.lon;
    if (lat == null || lng == null) continue;
    const c = {
      key: `${e.type}/${e.id}`, type: e.type, id: e.id, tags,
      name: tags.name, kind: areaKindLabel(tags), rank: areaRank(tags),
      lat, lng, distance: distance(center, { lat, lng }),
      hasGeometry: e.type !== 'node',
    };
    c.tier = areaTier(c);
    list.push(c);
  }

  // Derselbe Ort taucht oft doppelt auf (Grenzrelation + place-Knoten).
  // Der Eintrag mit Umriss gewinnt, sonst wäre nur der Kreis-Notbehelf übrig.
  const preference = { relation: 3, way: 2, node: 1 };
  const kept = [];
  for (const c of list.sort((a, b2) => preference[b2.type] - preference[a.type])) {
    const dup = kept.find((k) => k.name === c.name && Math.abs(k.rank - c.rank) <= 1 && distance(k, c) < 3000);
    if (!dup) kept.push(c);
  }
  return kept.sort((a, b2) => (a.tier - b2.tier) || (a.distance - b2.distance)).slice(0, 120);
}

// Welche Gebiete enthalten den Punkt? Nur zum Markieren in der Liste.
export async function areaKeysAt(point) {
  const ql = `[out:json][timeout:${getState().settings.overpassTimeout || 25}];`
    + `is_in(${point.lat.toFixed(6)},${point.lng.toFixed(6)})->.a;`
    + '(relation(pivot.a);way(pivot.a););out ids;';
  const json = await query(ql);
  return new Set((json.elements || []).map((e) => `${e.type}/${e.id}`));
}

export async function areaGeometry(cand) {
  if (cand.type === 'node') return null;
  const ql = `[out:json][timeout:60];${cand.type}(${cand.id});out geom;`;
  const json = await query(ql);
  const el0 = (json.elements || []).find((e) => e.type === cand.type);
  if (!el0) throw new Error('Keine Geometrie erhalten');

  const ring = el0.type === 'way'
    ? (el0.geometry || []).map((g) => ({ lat: g.lat, lng: g.lon }))
    : stitchOuterRing(el0.members || []);
  if (!ring || ring.length < 3) throw new Error('Umriss ließ sich nicht zusammensetzen');

  // Fein genug für ein Dorf, grob genug für ein Bundesland: erst scharf vereinfachen,
  // dann nur so weit nachlassen, bis die Punktzahl handhabbar ist.
  let eps = 0.00005;
  let out = simplify(ring, eps);
  while (out.length > 1200 && eps < 0.01) { eps *= 2; out = simplify(ring, eps); }
  return out;
}

// Die Grenzwege einer Relation kommen unsortiert und teils verdreht.
// Hier werden sie an den Endpunkten aneinandergehängt; von mehreren geschlossenen
// Ringen (Exklaven) gewinnt der flächenmäßig größte.
function stitchOuterRing(members) {
  const segs = members
    .filter((m) => m.type === 'way' && Array.isArray(m.geometry) && (m.role === 'outer' || !m.role))
    .map((m) => m.geometry.map((g) => ({ lat: g.lat, lng: g.lon })));
  if (!segs.length) return null;

  const rings = [];
  const pool = segs.slice();
  const near = (a, b) => Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;

  while (pool.length) {
    let ring = pool.shift().slice();
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < pool.length; i++) {
        const seg = pool[i];
        const head = ring[0], tail = ring[ring.length - 1];
        if (near(tail, seg[0])) { ring = ring.concat(seg.slice(1)); pool.splice(i, 1); extended = true; break; }
        if (near(tail, seg[seg.length - 1])) { ring = ring.concat(seg.slice().reverse().slice(1)); pool.splice(i, 1); extended = true; break; }
        if (near(head, seg[seg.length - 1])) { ring = seg.slice(0, -1).concat(ring); pool.splice(i, 1); extended = true; break; }
        if (near(head, seg[0])) { ring = seg.slice().reverse().slice(0, -1).concat(ring); pool.splice(i, 1); extended = true; break; }
      }
    }
    rings.push(ring);
  }
  rings.sort((a, b) => bboxArea(b) - bboxArea(a));
  return rings[0];
}

function bboxArea(ring) {
  let s = 90, n = -90, w = 180, e = -180;
  for (const p of ring) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng); }
  return (n - s) * (e - w);
}

// Für das Vorabladen: alles in einem Rechteck statt im Umkreis eines Punktes.
export async function poisInBox(bounds, categoryId, namedOnly = true) {
  const cat = CATEGORIES.find((c) => c.id === categoryId);
  if (!cat) throw new Error('Unbekannte Kategorie');
  const box = `(${bounds.south.toFixed(6)},${bounds.west.toFixed(6)},${bounds.north.toFixed(6)},${bounds.east.toFixed(6)})`;
  const ql = `[out:json][timeout:${getState().settings.overpassTimeout || 25}];`
    + `nwr${cat.filter}${box};out center tags;`;
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
  const list = [];
  for (const e of json.elements || []) {
    const tags = e.tags || {};
    if (!tags.name) continue;
    const lat = e.lat ?? e.center?.lat;
    const lng = e.lon ?? e.center?.lon;
    if (lat == null || lng == null) continue;
    const c = {
      key: `${e.type}/${e.id}`, type: e.type, id: e.id, tags,
      name: tags.name, kind: areaKindLabel(tags), rank: areaRank(tags),
      lat, lng, hasGeometry: e.type !== 'node',
    };
    c.tier = areaTier(c);
    list.push(c);
  }
  return list;
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
    const cats = el('div', { class: 'pills' }, CATEGORIES.map((c) => el('button', {
      class: `pill ${c.id === category ? 'on' : ''}`,
      onclick: (e) => {
        category = c.id;
        body.querySelectorAll('.pills .pill').forEach((p) => p.classList.remove('on'));
        e.target.classList.add('on');
      },
    }, c.label)));
    const radiusSel = el('select', {}, [300, 500, 1000, 2000, 3000, 5000, 10000, 15000, 25000, 50000].map((r) =>
      el('option', { value: String(r), selected: r === radius }, formatDistance(r, getState().settings.unit))));
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
                el('div', { class: 'grow' }, el('div', { text: p.name }), el('div', { class: 'card-sub', text: formatDistance(p.distance, getState().settings.unit) }))));
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
      el('option', { value: String(r), selected: r === radius }, formatDistance(r, getState().settings.unit))));
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
          el('div', { class: 'card-sub', text: `${c.kind} · ${formatDistance(c.distance, getState().settings.unit)}${c.hasGeometry ? '' : ' · ohne Umriss'}` })));
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
        }, formatDistance(r, getState().settings.unit))))),
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

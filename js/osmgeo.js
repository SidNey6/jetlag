// Reine OSM-Geometrie: aus Overpass-artigen Elementen Punkte, Linien und Flächen machen.
// Ohne DOM und ohne Netz – dieselben Funktionen nutzen die App (overpass.js, Antworten
// von Overpass) und das Bau-Skript für die Regionsdaten (scripts/region, Elemente aus
// einer PBF-Datei). So ergibt dieselbe Quelle offline wie online dieselben Formen.
//
// "Element" heißt hier das Format von Overpass mit "out geom":
//   { type: 'node', id, lat, lon, tags }
//   { type: 'way', id, tags, geometry: [{ lat, lon }, …], center? }
//   { type: 'relation', id, tags, members: [{ type, ref, role, geometry? }], center? }

import { distance, distanceToFeatures, simplify } from './geo.js';

/* ---------- Overpass-Filter auswerten ---------- */

// Zerlegt eine Anweisung wie  way["highway"~"^(a|b)$"]["area"!="yes"]  in Typen und
// Bedingungen. Verstanden werden =, !=, ~, !~ sowie ["k"] und [!"k"] – mehr nutzen die
// Quellen in sources.js nicht.
export function parseStatement(st) {
  const m = /^(node|way|relation|nwr|nw|wr|nr)/.exec(st);
  if (!m) throw new Error(`Unbekannte Anweisung: ${st}`);
  const types = {
    node: ['node'], way: ['way'], relation: ['relation'], nwr: ['node', 'way', 'relation'],
    nw: ['node', 'way'], wr: ['way', 'relation'], nr: ['node', 'relation'],
  }[m[1]];
  const conds = [];
  const re = /\[(!?)"([^"]+)"(?:(=|!=|~|!~)"([^"]*)")?\]/g;
  let c;
  let rest = st.slice(m[1].length);
  while ((c = re.exec(rest))) {
    const [, not, k, op, v] = c;
    if (!op) conds.push({ k, op: not ? 'absent' : 'present' });
    else conds.push({ k, op, v, re: op.includes('~') ? new RegExp(v) : null });
  }
  rest = rest.replace(re, '').trim();
  if (rest) throw new Error(`Nicht verstandener Teil "${rest}" in ${st}`);
  return { types: new Set(types), conds };
}

export function matchesTags(statement, tags) {
  const t = tags || {};
  for (const c of statement.conds) {
    const v = t[c.k];
    switch (c.op) {
      case 'present': if (v == null) return false; break;
      case 'absent': if (v != null) return false; break;
      case '=': if (v !== c.v) return false; break;
      case '!=': if (v === c.v) return false; break;
      case '~': if (v == null || !c.re.test(v)) return false; break;
      case '!~': if (v != null && c.re.test(v)) return false; break;
      default: return false;
    }
  }
  return true;
}

export function matchesElement(statement, type, tags) {
  return statement.types.has(type) && matchesTags(statement, tags);
}

/* ---------- Punkte ---------- */

export function toPoints(json, { namedOnly = true, kindOf = null } = {}) {
  const out = [];
  for (const e of json.elements || []) {
    const lat = e.lat ?? e.center?.lat;
    const lng = e.lon ?? e.center?.lon;
    if (lat == null || lng == null) continue;
    const name = e.tags?.name || null;
    if (namedOnly && !name) continue;
    const p = { id: `${e.type[0]}${e.id}`, lat, lng, name: name || 'ohne Namen' };
    if (kindOf) p.kind = kindOf(e.tags || {});
    out.push(p);
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


/* ---------- Haltestellen und Straßennetz ---------- */

// Haltestellen aller Art – für das Endgame per langem Drücken auf der Karte
export const STOP_CATEGORIES = ['station', 'tram_subway', 'bus'];
export const STOP_LABEL = { station: 'Bahnhof', tram_subway: 'Straßen-/U-Bahn', bus: 'Bushaltestelle' };

export function stopKind(t) {
  if (t.railway === 'station' && !/^(subway|light_rail)$/.test(t.station || '')) return 'station';
  if (t.highway === 'bus_stop') return 'bus';
  return 'tram_subway';
}

// Begehbare Wege im Umkreis. Gehwege neben der Fahrbahn, Querungen, Einfahrten und
// Parkplatzgassen bleiben draußen: sie würden dieselbe Straße doppelt zählen oder
// Hunderte Mini-Stücke erzeugen, die niemand "abgeht".
export const WALKABLE = '^(primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|service|track|footway|path|cycleway|steps|bridleway|primary_link|secondary_link|tertiary_link|road)$';

// Vollständige Anweisung für begehbare Wege
export const STREET_FILTER = `way["highway"~"${WALKABLE}"]["area"!="yes"]["access"!~"^(private|no)$"]`
  + '["footway"!~"^(sidewalk|crossing)$"]["service"!~"^(driveway|parking_aisle|drive-through)$"]["indoor"!="yes"]';

// Kacheln des vorgebauten Straßennetzes (Regionsdaten): Schlüssel "zeile_spalte"
export function streetTileKey(lat, lng, tile) {
  return `${Math.floor(lat / tile.lat)}_${Math.floor(lng / tile.lng)}`;
}

export function streetTilesIn(bounds, tile) {
  const keys = [];
  for (let r = Math.floor(bounds.south / tile.lat); r <= Math.floor(bounds.north / tile.lat); r++) {
    for (let c = Math.floor(bounds.west / tile.lng); c <= Math.floor(bounds.east / tile.lng); c++) keys.push(`${r}_${c}`);
  }
  return keys;
}

/* ---------- Linien und Flächen ---------- */

export const ROUTE_LABEL = { bus: 'Bus', tram: 'Tram', subway: 'U-Bahn', light_rail: 'Stadtbahn', train: 'Zug' };

// Identität eines Objekts: gleiche Linie = gleicher Schlüssel, auch wenn OSM sie in
// Hin- und Rückrichtung oder in viele Teilstücke zerlegt. Wichtig für Fragen der Art
// "ist deine nächste Linie dieselbe wie meine?".
export function identityOf(e) {
  return identitiesOf(e)[0];
}

const ROAD = /^(motorway|trunk|primary|secondary|tertiary|unclassified)(_link)?$/;

// Straßennummer vereinheitlichen: "B9" → "B 9"
function normRef(r) {
  return r.trim().replace(/^([A-Z]{1,2})\s*(\d)/, '$1 $2');
}

// Alle Identitäten eines Elements. Meist genau eine; ein Straßenstück mit mehreren
// Nummern ("A 1;A 61") gehört aber zu beiden Autobahnen – im Grenzfall sind beide gleich
// nah. prefix (aus sources.js: refPrefix) beschränkt auf die gesuchte Straßenklasse.
export function identitiesOf(e, prefix = null) {
  const t = e.tags || {};
  if (t.route) {
    const nr = t.ref || t.name || `#${e.id}`;
    return [{ key: `${t.route}:${nr}`, name: t.ref ? `${ROUTE_LABEL[t.route] || t.route} ${t.ref}` : (t.name || nr) }];
  }
  if (t.highway && t.ref && ROAD.test(t.highway)) {
    const refs = t.ref.split(';').map(normRef).filter(Boolean);
    const passend = prefix ? refs.filter((r) => r.startsWith(`${prefix} `)) : refs;
    const liste = passend.length ? passend : refs;
    if (liste.length) return liste.map((r) => ({ key: `road:${r}`, name: r }));
  }
  const name = t.name || t.ref || t.int_ref || null;
  return [{ key: name ? `n:${name}` : `${e.type}:${e.id}`, name }];
}

// Ein OSM-Element in Features zerlegen. Relationen vom Typ Linie ('lines') liefern
// alle Mitgliedswege, Flächen werden zu einem Ring zusammengesetzt.
export function elementToFeatures(e, geomHint) {
  if (e.type === 'node') return [{ type: 'point', points: [{ lat: e.lat, lng: e.lon }] }];
  if (e.type === 'way' && Array.isArray(e.geometry)) {
    const pts = e.geometry.map((g) => ({ lat: g.lat, lng: g.lon }));
    if (pts.length < 2) return [];
    const first = pts[0], last = pts[pts.length - 1];
    const closed = Math.abs(first.lat - last.lat) < 1e-9 && Math.abs(first.lng - last.lng) < 1e-9;
    const linear = geomHint === 'line' || geomHint === 'lines';
    const type = linear ? 'line' : (closed ? 'polygon' : 'line');
    return [{ type, points: closed && type === 'polygon' ? pts.slice(0, -1) : pts }];
  }
  if (e.type === 'relation' && Array.isArray(e.members)) {
    const ways = e.members.filter((m) => m.type === 'way' && Array.isArray(m.geometry) && m.geometry.length > 1);
    if (geomHint === 'lines' || geomHint === 'line') {
      return ways.map((m) => ({ type: 'line', points: m.geometry.map((g) => ({ lat: g.lat, lng: g.lon })) }));
    }
    const ring = stitchOuterRing(e.members);
    if (ring && ring.length >= 3) return [{ type: 'polygon', points: ring }];
    return ways.slice(0, 1).map((m) => ({ type: 'line', points: m.geometry.map((g) => ({ lat: g.lat, lng: g.lon })) }));
  }
  return [];
}

export function featuresFrom(json, spec, center) {
  const out = [];
  for (const e of json.elements || []) {
    const ids = identitiesOf(e, spec.refPrefix);
    for (const f of elementToFeatures(e, spec.geom)) {
      if (!f.points.length) continue;
      f.distance = distanceToFeatures(center, [f]);
      for (const id of ids) out.push({ ...f, name: id.name, key: id.key });
    }
  }
  return out.sort((a, b) => a.distance - b.distance);
}

// Wegstücke ihren Linien zuordnen. Teilen sich zwei Linien ein Gleis, gehört das
// Stück beiden – im Grenzfall sind sie dann eben gleich nah.
export function routeFeaturesFrom(json, center) {
  const ways = new Map();
  const routes = [];
  for (const e of json.elements || []) {
    if (e.type === 'way' && Array.isArray(e.geometry)) ways.set(e.id, e);
    else if (e.type === 'relation') routes.push(e);
  }
  const out = [];
  for (const rel of routes) {
    const id = identityOf(rel);
    for (const m of rel.members || []) {
      if (m.type !== 'way') continue;
      const w = ways.get(m.ref);
      if (!w || w.geometry.length < 2) continue;
      const f = { type: 'line', points: w.geometry.map((g) => ({ lat: g.lat, lng: g.lon })), name: id.name, key: id.key };
      f.distance = distanceToFeatures(center, [f]);
      out.push(f);
    }
  }
  return out.sort((a, b) => a.distance - b.distance);
}

// OSM zerlegt lange Wege an jeder Kreuzung. Für Abstandsrechnung und Zeichnung sind
// zusammenhängende Linien besser: weniger Zustand, weniger Zeichenoperationen je Bild.
// Zusammengefügt wird nur, was zum selben Objekt gehört – sonst verschmölze die A 565
// am Autobahnkreuz mit der A 59, und "dieselbe Autobahn?" wäre nicht mehr beantwortbar.
// directed: nur Ende an Anfang hängen, nie ein Stück umdrehen – sonst ginge die
// Fließrichtung verloren, an der die Flussseite hängt.
export function mergeLines(feats, directed = false) {
  const lines = feats.filter((f) => f.type === 'line');
  const rest = feats.filter((f) => f.type !== 'line');
  const near = (a, b) => Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;
  const pool = lines.map((f) => ({ points: f.points.slice(), name: f.name, key: f.key }));
  const out = [];

  while (pool.length) {
    const cur = pool.shift();
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < pool.length; i++) {
        if (pool[i].key !== cur.key) continue;
        const A = cur.points, B = pool[i].points;
        if (near(A[A.length - 1], B[0])) cur.points = A.concat(B.slice(1));
        else if (near(A[0], B[B.length - 1])) cur.points = B.slice(0, -1).concat(A);
        else if (directed) continue;
        else if (near(A[A.length - 1], B[B.length - 1])) cur.points = A.concat(B.slice().reverse().slice(1));
        else if (near(A[0], B[0])) cur.points = B.slice().reverse().slice(0, -1).concat(A);
        else continue;
        pool.splice(i, 1);
        extended = true;
        break;
      }
    }
    out.push({ type: 'line', name: cur.name, key: cur.key, points: cur.points });
  }
  return [...out, ...rest];
}

// Stützpunkte begrenzen: lieber gröber als einen Spielstand mit 50.000 Koordinaten.
export function fitBudget(features, budget = 6000) {
  let eps = 0.0003;
  let out = features;
  const count = (fs) => fs.reduce((n, f) => n + f.points.length, 0);
  while (count(out) > budget && eps < 0.02) {
    out = features.map((f) => ({ ...f, points: f.points.length > 4 ? simplify(f.points, eps) : f.points }));
    eps *= 2;
  }
  return out.map((f) => ({ ...f, points: f.points.length > 8 ? simplify(f.points, 0.0003) : f.points }));
}

/* ---------- Gebiete ---------- */

export const PLACE_RE = '^(city|borough|town|suburb|village|quarter|neighbourhood|hamlet|isolated_dwelling)$';
export const ADMIN_RE = '^(4|5|6|7|8|9|10|11|12)$';

export const ADMIN_LABEL = {
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

// Ein Gebiet für die Gebietsauswahl aus einem Element mit Mittelpunkt
export function areaCandidate(e) {
  const tags = e.tags || {};
  if (!tags.name) return null;
  const lat = e.lat ?? e.center?.lat;
  const lng = e.lon ?? e.center?.lon;
  if (lat == null || lng == null) return null;
  const c = {
    key: `${e.type}/${e.id}`, type: e.type, id: e.id, tags,
    name: tags.name, kind: areaKindLabel(tags), rank: areaRank(tags),
    lat, lng, hasGeometry: e.type !== 'node',
  };
  c.tier = areaTier(c);
  return c;
}

// Derselbe Ort taucht oft doppelt auf (Grenzrelation + place-Knoten).
// Der Eintrag mit Umriss gewinnt, sonst wäre nur der Kreis-Notbehelf übrig.
export function dedupeAreas(list) {
  const preference = { relation: 3, way: 2, node: 1 };
  const kept = [];
  for (const c of list.slice().sort((a, b) => preference[b.type] - preference[a.type])) {
    const dup = kept.find((k) => k.name === c.name && Math.abs(k.rank - c.rank) <= 1 && distance(k, c) < 3000);
    if (!dup) kept.push(c);
  }
  return kept;
}

// Umriss handhabbar machen: fein genug für ein Dorf, grob genug für ein Bundesland
export function slimRing(ring, max = 1200) {
  let eps = 0.00005;
  let out = simplify(ring, eps);
  while (out.length > max && eps < 0.01) { eps *= 2; out = simplify(ring, eps); }
  return out;
}

// Die Grenzwege einer Relation kommen unsortiert und teils verdreht.
// Hier werden sie an den Endpunkten aneinandergehängt; von mehreren geschlossenen
// Ringen (Exklaven) gewinnt der flächenmäßig größte.
export function stitchOuterRing(members) {
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

// Ist ein zusammengesetzter Ring wirklich geschlossen? In Regionsauszügen fehlen bei
// großen Gebieten (Bundesland) Teile der Grenze – ein offener Ring wäre als Fläche falsch.
export function ringClosed(ring) {
  if (!ring || ring.length < 4) return false;
  const a = ring[0], b = ring[ring.length - 1];
  return Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;
}

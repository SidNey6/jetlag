#!/usr/bin/env node
// Baut die Regionsdaten aus OpenStreetMap-Auszügen (PBF von Geofabrik).
//
//   node scripts/region/build.mjs bonn --pbf koeln-regbez-latest.osm.pbf --pbf rheinland-pfalz-latest.osm.pbf
//
// Ergebnis unter data/<region>/ plus data/regions.json. Die App liest diese Dateien statt
// Overpass zu fragen. Was gebaut wird, kommt aus denselben Filtern, die die App online
// verwendet (js/sources.js, js/osmgeo.js) – offline und online ergeben dieselben Formen.
//
// Ablauf je Datei, jeweils ein Durchlauf über die PBF:
//   1. Relationen: Linien (Bus, Bahn), Verwaltungsgrenzen, Orte, Flächen mit Mitgliedern
//   2. Knoten im Rahmen der Region: Koordinaten und getaggte Orte
//   3. Wege: was einen Filter trifft oder Mitglied einer gesuchten Relation ist
//   4. Knoten außerhalb, die Grenzen und Flächen zum Schließen brauchen
// Danach werden Overpass-artige Elemente gebaut und mit den Funktionen aus osmgeo.js
// in Orte, Linien, Flächen, Gebiete und Straßenkacheln verwandelt.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readPbf } from './pbf.mjs';
import { REGIONS, STREET_TILE } from './regions.mjs';
import { POI_CATEGORIES, REFERENCES, referenceStatements, poiStatements } from '../../js/sources.js';
import * as G from '../../js/osmgeo.js';
import { simplify } from '../../js/geo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADMIN_LEVELS = [4, 5, 6, 7, 8, 9, 10, 11, 12];
const BORDER_LEVELS = [4, 5, 6, 7, 8, 9, 10];
const RAND_GRAD = 0.05; // Knoten so weit über den Rahmen hinaus, damit Linien nicht am Rand abreißen

/* ---------- Aufruf ---------- */

function args() {
  const a = process.argv.slice(2);
  const out = { region: null, pbf: [], out: join(ROOT, 'data') };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--pbf') out.pbf.push(a[++i]);
    else if (a[i] === '--out') out.out = a[++i];
    else out.region = a[i];
  }
  if (!out.region || !REGIONS[out.region] || !out.pbf.length) {
    console.error(`Aufruf: build.mjs <${Object.keys(REGIONS).join('|')}> --pbf datei.osm.pbf [--pbf …] [--out data]`);
    process.exit(1);
  }
  return out;
}

let leise = false;
const log = (...x) => { if (!leise) console.log(`[${(process.uptime()).toFixed(1).padStart(6)} s]`, ...x); };

/* ---------- Was gesucht wird ---------- */

// Jede Ausgabe hat eine Liste von Anweisungen; ein Element gehört zu allen Ausgaben,
// deren Anweisung es erfüllt.
function outputs() {
  const list = [];
  for (const cat of POI_CATEGORIES) {
    list.push({ id: `pois/${cat.id}`, kind: 'pois', cat, statements: poiStatements(cat) });
  }
  for (const spec of REFERENCES) {
    if (spec.kind === 'elevation') continue;
    const variants = spec.param === 'adminLevel' ? BORDER_LEVELS.map((l) => ({ adminLevel: l })) : [{}];
    for (const params of variants) {
      const p = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',');
      list.push({
        id: p ? `refs/${spec.id}@${p}` : `refs/${spec.id}`,
        kind: 'refs', spec, statements: referenceStatements(spec, params),
      });
    }
  }
  list.push({
    id: 'areas', kind: 'areas',
    statements: [
      `relation["boundary"="administrative"]["admin_level"~"${G.ADMIN_RE}"]`,
      `relation["place"~"${G.PLACE_RE}"]`,
      `way["place"~"${G.PLACE_RE}"]`,
      `node["place"~"${G.PLACE_RE}"]`,
    ],
  });
  for (const level of ADMIN_LEVELS) {
    list.push({ id: `admin/${level}`, kind: 'admin', level, statements: [`relation["boundary"="administrative"]["admin_level"="${level}"]`] });
  }
  list.push({ id: 'streets', kind: 'streets', statements: [G.STREET_FILTER] });

  // Anweisungen nach Elementtyp sortieren und nach dem ersten Schlüssel vorfiltern
  const byType = { node: [], way: [], relation: [] };
  for (const o of list) {
    o.parsed = o.statements.map((st) => G.parseStatement(st));
    for (const st of o.parsed) {
      const first = st.conds.find((c) => c.op === '=' || c.op === '~' || c.op === 'present');
      for (const t of st.types) byType[t].push({ out: o, st, key: first ? first.k : null });
    }
  }
  return { list, byType };
}

function matchOutputs(byType, type, tags) {
  if (!tags) return null;
  let hits = null;
  for (const { out, st, key } of byType[type]) {
    if (key && tags[key] == null) continue;
    if (!G.matchesTags(st, tags)) continue;
    (hits || (hits = new Set())).add(out);
  }
  return hits;
}

/* ---------- Knotenspeicher ---------- */

// Knoten-IDs kommen in PBF-Dateien aufsteigend. Gespeichert wird in typisierten Feldern,
// gesucht per Halbierung – ein Map mit Millionen Einträgen wäre fünfmal so groß.
class NodeStore {
  constructor() {
    this.n = 0;
    this.ids = new Float64Array(1 << 20);
    this.lat = new Int32Array(1 << 20);
    this.lon = new Int32Array(1 << 20);
  }

  add(id, lat, lon) {
    if (this.n === this.ids.length) {
      const grow = (a, T) => { const b = new T(a.length * 2); b.set(a); return b; };
      this.ids = grow(this.ids, Float64Array);
      this.lat = grow(this.lat, Int32Array);
      this.lon = grow(this.lon, Int32Array);
    }
    this.ids[this.n] = id;
    this.lat[this.n] = Math.round(lat * 1e7);
    this.lon[this.n] = Math.round(lon * 1e7);
    this.n++;
  }

  index(id) {
    let lo = 0, hi = this.n - 1;
    const ids = this.ids;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = ids[mid];
      if (v === id) return mid;
      if (v < id) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  get(id) {
    const i = this.index(id);
    return i < 0 ? null : { lat: this.lat[i] / 1e7, lon: this.lon[i] / 1e7 };
  }
}

/* ---------- Eine Datei lesen ---------- */

function inBox(b, lat, lon) {
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

function readFile(file, region, matcher) {
  const buf = readFileSync(file);
  const rahmen = {
    south: region.bounds.south - RAND_GRAD, north: region.bounds.north + RAND_GRAD,
    west: region.bounds.west - RAND_GRAD * 1.5, east: region.bounds.east + RAND_GRAD * 1.5,
  };

  // 1. Relationen
  const relations = new Map();
  const memberOf = new Map(); // Weg-ID → 'complete' | 'route'
  readPbf(buf, {
    relations: (id, tags, members) => {
      const outs = matchOutputs(matcher.byType, 'relation', tags);
      if (!outs) return;
      const route = !!tags.route;
      relations.set(id, { type: 'relation', id, tags, members, outs, complete: !route });
      for (const m of members) {
        if (m.type !== 'way') continue;
        if (!route) memberOf.set(m.ref, 'complete');
        else if (!memberOf.has(m.ref)) memberOf.set(m.ref, 'route');
      }
    },
  });
  log(`${file.split('/').pop()}: ${relations.size} Relationen, ${memberOf.size} Mitgliedswege`);

  // 2. Knoten im Rahmen
  const store = new NodeStore();
  const nodes = new Map();
  readPbf(buf, {
    nodes: (id, lat, lon, tags) => {
      if (!inBox(rahmen, lat, lon)) return;
      store.add(id, lat, lon);
      const outs = matchOutputs(matcher.byType, 'node', tags);
      if (outs) nodes.set(id, { type: 'node', id, lat, lon, tags, outs });
    },
  });
  log(`  ${store.n} Knoten im Rahmen, ${nodes.size} davon gesucht`);

  // 3. Wege
  const ways = new Map();
  readPbf(buf, {
    ways: (id, tags, refs) => {
      const outs = matchOutputs(matcher.byType, 'way', tags);
      const member = memberOf.get(id);
      if (!outs && !member) return;
      let touches = false;
      for (const r of refs) { if (store.index(r) >= 0) { touches = true; break; } }
      // Grenz- und Flächenmitglieder auch außerhalb behalten: sonst schlösse sich der
      // Umriss von Rhein-Sieg-Kreis oder Kreis Ahrweiler nicht
      if (!touches && member !== 'complete') return;
      ways.set(id, { type: 'way', id, tags, refs, outs, touches });
    },
  });
  log(`  ${ways.size} Wege behalten`);

  // Nur Relationen, die den Rahmen wirklich berühren
  for (const [id, rel] of relations) {
    const hit = rel.members.some((m) => m.type === 'way' && ways.get(m.ref)?.touches);
    if (!hit) relations.delete(id);
  }
  const fehlend = new Set();
  for (const rel of relations.values()) {
    if (!rel.complete) continue;
    for (const m of rel.members) {
      const w = m.type === 'way' ? ways.get(m.ref) : null;
      if (!w) continue;
      for (const r of w.refs) if (store.index(r) < 0) fehlend.add(r);
    }
  }
  // Wege außerhalb, die keine verbliebene Relation braucht, wieder abwerfen
  const gebraucht = new Set();
  for (const rel of relations.values()) for (const m of rel.members) if (m.type === 'way') gebraucht.add(m.ref);
  for (const [id, w] of ways) if (!w.touches && !gebraucht.has(id)) ways.delete(id);

  // 4. Fehlende Knoten für geschlossene Umrisse
  const extra = new Map();
  if (fehlend.size) {
    readPbf(buf, {
      nodes: (id, lat, lon) => { if (fehlend.has(id)) extra.set(id, { lat, lon }); },
    });
  }
  log(`  ${relations.size} Relationen im Gebiet, ${extra.size} Knoten von außerhalb nachgeholt`);

  // Geometrie auflösen
  const coord = (id) => store.get(id) || extra.get(id) || null;
  const elements = new Map();
  for (const n of nodes.values()) elements.set(`node/${n.id}`, n);
  for (const w of ways.values()) {
    const geometry = [];
    const nodeIds = [];
    for (const r of w.refs) {
      const c = coord(r);
      if (c) { geometry.push(c); nodeIds.push(r); }
    }
    if (geometry.length < 2) continue;
    elements.set(`way/${w.id}`, { type: 'way', id: w.id, tags: w.tags, geometry, nodes: nodeIds, outs: w.outs, center: centerOf(geometry) });
  }
  for (const rel of relations.values()) {
    const members = rel.members.map((m) => {
      if (m.type !== 'way') return { type: m.type, ref: m.ref, role: m.role };
      const w = elements.get(`way/${m.ref}`);
      return { type: 'way', ref: m.ref, role: m.role, geometry: w ? w.geometry : undefined };
    });
    const pts = members.flatMap((m) => m.geometry || []);
    if (!pts.length) continue;
    elements.set(`relation/${rel.id}`, { type: 'relation', id: rel.id, tags: rel.tags, members, outs: rel.outs, center: centerOf(pts) });
  }
  return elements;
}

function centerOf(pts) {
  let s = 90, n = -90, w = 180, e = -180;
  for (const p of pts) {
    if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat;
    if (p.lon < w) w = p.lon; if (p.lon > e) e = p.lon;
  }
  return { lat: (s + n) / 2, lon: (w + e) / 2 };
}

// Zwei Dateien überlappen an der Landesgrenze: dasselbe Objekt kann in beiden stehen.
// Behalten wird die Fassung mit mehr Geometrie; bei Relationen werden Mitglieder ergänzt.
function mergeInto(all, elements) {
  for (const [key, e] of elements) {
    const prev = all.get(key);
    if (!prev) { all.set(key, e); continue; }
    if (e.type === 'way' && e.geometry.length > prev.geometry.length) all.set(key, e);
    if (e.type === 'relation') {
      prev.members = prev.members.map((m, i) => (m.geometry ? m : (e.members[i] && e.members[i].ref === m.ref ? e.members[i] : m)));
    }
  }
}

/* ---------- Ausgaben ---------- */

const R5 = (x) => Math.round(x * 1e5) / 1e5;
const R6 = (x) => Math.round(x * 1e6) / 1e6;

function flat(points, round = R5) {
  const out = [];
  for (const p of points) out.push(round(p.lat), round(p.lng ?? p.lon));
  return out;
}

function boxOf(points) {
  let s = 90, n = -90, w = 180, e = -180;
  for (const p of points) {
    const lng = p.lng ?? p.lon;
    if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat;
    if (lng < w) w = lng; if (lng > e) e = lng;
  }
  return { south: s, north: n, west: w, east: e };
}

function intersects(a, b) {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

const centerIn = (b, e) => inBox(b, e.lat ?? e.center?.lat, e.lon ?? e.center?.lon);

function buildPois(out, elements, region) {
  const els = elements.filter((e) => centerIn(region.bounds, e));
  const pts = G.toPoints({ elements: els });
  return { items: pts.map((p) => [p.id, R6(p.lat), R6(p.lng), p.name]) };
}

function buildRefs(out, elements, region) {
  const spec = out.spec;
  let feats;
  if (spec.geom === 'lines') {
    // Linienrelationen samt den Mitgliedswegen, wie sie routeQuery von Overpass liefert
    const rels = elements.filter((e) => e.type === 'relation');
    const wege = new Map();
    for (const r of rels) for (const m of r.members) if (m.type === 'way' && m.geometry) wege.set(m.ref, { type: 'way', id: m.ref, geometry: m.geometry });
    const mitte = { lat: (region.bounds.south + region.bounds.north) / 2, lng: (region.bounds.west + region.bounds.east) / 2 };
    feats = G.routeFeaturesFrom({ elements: [...rels, ...wege.values()] }, mitte);
  } else {
    feats = [];
    for (const e of elements) {
      const ids = G.identitiesOf(e, spec.refPrefix);
      let fs;
      if (e.type === 'relation' && spec.geom !== 'line') {
        // Ein Umriss, der sich nicht schließt (Teil eines großen Gebiets, das über den
        // Auszug hinausreicht), ist keine Fläche – dann zählen nur seine Linien
        const ring = G.stitchOuterRing(e.members);
        fs = G.ringClosed(ring)
          ? [{ type: 'polygon', points: ring }]
          : e.members.filter((m) => m.geometry && m.geometry.length > 1)
            .map((m) => ({ type: 'line', points: m.geometry.map((g) => ({ lat: g.lat, lng: g.lon })) }));
      } else {
        fs = G.elementToFeatures(e, spec.geom);
      }
      for (const f of fs) if (f.points.length) for (const id of ids) feats.push({ ...f, name: id.name, key: id.key });
    }
  }
  feats = G.mergeLines(feats, !!spec.directed)
    .filter((f) => intersects(boxOf(f.points), region.bounds));
  const eps = spec.geom === 'line' || spec.geom === 'lines' ? 0.00003 : 0.00005;
  return {
    features: feats.map((f) => ({
      t: f.type === 'polygon' ? 'p' : f.type === 'point' ? 'n' : 'l',
      n: f.name || null,
      k: f.key || null,
      c: flat(f.points.length > 4 ? simplify(f.points, eps) : f.points),
    })),
  };
}

function ringOf(e) {
  if (e.type === 'way') {
    const pts = e.geometry.map((g) => ({ lat: g.lat, lng: g.lon }));
    return G.ringClosed(pts) ? pts : null;
  }
  const ring = G.stitchOuterRing(e.members);
  return G.ringClosed(ring) ? ring : null;
}

function buildAdmin(out, elements, region) {
  const items = [];
  for (const e of elements) {
    const ring = ringOf(e);
    if (!ring || !intersects(boxOf(ring), region.bounds)) continue;
    items.push({ id: e.id, name: e.tags.name || `Ebene ${out.level}`, level: out.level, c: flat(G.slimRing(ring)) });
  }
  return { items };
}

function buildAreas(elements, region, geoms) {
  const list = [];
  for (const e of elements) {
    if (!centerIn(region.bounds, e)) continue;
    const c = G.areaCandidate(e);
    if (!c) continue;
    if (e.type !== 'node') {
      const ring = ringOf(e);
      if (ring) geoms.set(`geom/${e.type}-${e.id}`, { c: flat(G.slimRing(ring)) });
      else c.hasGeometry = false;
      c.tier = G.areaTier(c);
    }
    list.push(c);
  }
  return {
    items: G.dedupeAreas(list).map((c) => ({
      key: c.key, type: c.type, id: c.id, name: c.name, kind: c.kind, rank: c.rank, tier: c.tier,
      lat: R6(c.lat), lng: R6(c.lng), hasGeometry: c.hasGeometry,
      tags: { name: c.tags.name, place: c.tags.place, admin_level: c.tags.admin_level },
    })),
  };
}

// Straßen kachelweise. Kreuzungsknoten bleiben beim Vereinfachen erhalten, sonst
// hingen die Wege im Netz nicht mehr zusammen.
function buildStreets(elements, region) {
  const b = region.streets;
  const ways = elements.filter((e) => e.type === 'way' && e.geometry.some((g) => inBox(b, g.lat, g.lon)));
  const uses = new Map();
  for (const w of ways) for (const id of w.nodes) uses.set(id, (uses.get(id) || 0) + 1);

  const tiles = new Map();
  for (const w of ways) {
    const pts = w.geometry.map((g) => ({ lat: g.lat, lng: g.lon }));
    const keep = w.nodes.map((id, i) => i === 0 || i === w.nodes.length - 1 || uses.get(id) > 1);
    const slim = [];
    let start = 0;
    for (let i = 1; i < pts.length; i++) {
      if (!keep[i]) continue;
      const run = simplify(pts.slice(start, i + 1), 0.00001);
      slim.push(...(slim.length ? run.slice(1) : run));
      start = i;
    }
    const entry = { id: w.id, h: w.tags.highway, c: flat(slim, R6) };
    // In jede Kachel, die ein Abschnitt berührt
    const keys = new Set();
    for (let i = 0; i < slim.length; i++) {
      const a = slim[i], z = slim[Math.min(i + 1, slim.length - 1)];
      const box = { south: Math.min(a.lat, z.lat), north: Math.max(a.lat, z.lat), west: Math.min(a.lng, z.lng), east: Math.max(a.lng, z.lng) };
      for (const k of G.streetTilesIn(box, STREET_TILE)) keys.add(k);
    }
    for (const k of keys) {
      if (!tiles.has(k)) tiles.set(k, []);
      tiles.get(k).push(entry);
    }
  }
  return tiles;
}

/* ---------- Hauptteil ---------- */

// Auch aus Tests aufrufbar: region ist ein Eintrag wie in regions.mjs
export function buildRegion({ region, pbf, out, quiet = false }) {
  leise = quiet;
  const opt = { pbf, out };
  const matcher = outputs();
  log(`Region ${region.name}: ${matcher.list.length} Ausgaben`);

  const all = new Map();
  for (const file of opt.pbf) mergeInto(all, readFile(file, region, matcher));
  log(`${all.size} Elemente insgesamt`);

  // Elemente je Ausgabe
  const per = new Map(matcher.list.map((o) => [o, []]));
  for (const e of all.values()) for (const o of e.outs || []) per.get(o).push(e);

  const files = new Map();
  const counts = {};
  const geoms = new Map();
  for (const o of matcher.list) {
    const els = per.get(o);
    if (o.kind === 'pois') files.set(o.id, buildPois(o, els, region));
    else if (o.kind === 'refs') files.set(o.id, buildRefs(o, els, region));
    else if (o.kind === 'admin') files.set(o.id, buildAdmin(o, els, region));
    else if (o.kind === 'areas') files.set(o.id, buildAreas(els, region, geoms));
    else if (o.kind === 'streets') {
      for (const [k, list] of buildStreets(els, region)) files.set(`streets/${k}`, { ways: list });
    }
    const data = files.get(o.id);
    if (data) counts[o.id] = (data.items || data.features || []).length;
  }
  for (const [k, v] of geoms) files.set(k, v);
  // Leere Dateien weglassen: dann fragt die App gleich online
  for (const [k, v] of files) {
    const n = (v.items || v.features || v.ways || [v.c]).length;
    if (!n) files.delete(k);
  }

  // Schreiben
  const dir = join(opt.out, region.id);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  const hash = createHash('sha256');
  const sizes = {};
  let total = 0;
  for (const [path, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const text = JSON.stringify(data);
    const target = join(dir, `${path}.json`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    hash.update(path).update(text);
    sizes[path] = text.length;
    total += text.length;
  }

  const version = hash.digest('hex').slice(0, 12);
  const manifest = {
    id: region.id,
    name: region.name,
    bounds: region.bounds,
    streets: { bounds: region.streets, tile: STREET_TILE },
    version,
    built: new Date().toISOString(),
    source: 'OpenStreetMap-Mitwirkende (ODbL), Auszüge von Geofabrik',
    files: sizes,
  };
  const listPath = join(opt.out, 'regions.json');
  const bestehend = existsSync(listPath) ? JSON.parse(readFileSync(listPath, 'utf8')).regions || [] : [];
  const regions = [...bestehend.filter((r) => r.id !== region.id), manifest];
  writeFileSync(listPath, JSON.stringify({ regions }));

  const mb = (x) => `${(x / 1048576).toFixed(1)} MB`;
  const nach = (pref) => Object.entries(sizes).filter(([k]) => k.startsWith(pref)).reduce((s, [, v]) => s + v, 0);
  log(`Fertig: ${files.size} Dateien, ${mb(total)} (Straßen ${mb(nach('streets/'))}, Bezüge ${mb(nach('refs/'))}, `
    + `Orte ${mb(nach('pois/'))}, Grenzen ${mb(nach('admin/'))}, Gebiete ${mb(nach('areas') + nach('geom/'))}), Version ${version}`);
  if (!quiet) for (const [k, v] of Object.entries(counts).sort()) if (v) console.log(`  ${k.padEnd(36)} ${String(v).padStart(6)}`);
  return manifest;
}

function main() {
  const opt = args();
  buildRegion({ region: REGIONS[opt.region], pbf: opt.pbf, out: opt.out });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

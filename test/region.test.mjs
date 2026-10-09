// Prüft die vorgebauten Regionsdaten: PBF-Leser, Bau-Skript und das Lesen in der App.
// Die Testdaten werden hier selbst als winzige PBF-Datei geschrieben – so läuft der
// Test ohne Download und prüft trotzdem den ganzen Weg von OSM bis zur Datei.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { readPbf } = await import('../scripts/region/pbf.mjs');
const { buildRegion } = await import('../scripts/region/build.mjs');
const Region = await import('../js/region.js');
const G = await import('../js/osmgeo.js');
const { sideOfLines } = await import('../js/geo.js');

/* ---------- kleiner PBF-Schreiber ---------- */

const enc = new TextEncoder();
function varint(n) {
  const out = [];
  while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}
const zz = (n) => (n >= 0 ? n * 2 : -n * 2 - 1);
const key = (field, wire) => varint(field * 8 + wire);
const lenField = (field, bytes) => [...key(field, 2), ...varint(bytes.length), ...bytes];
const vField = (field, n) => [...key(field, 0), ...varint(n)];
const packed = (field, nums) => lenField(field, nums.flatMap(varint));
function delta(list) {
  let prev = 0;
  return list.map((x) => { const d = zz(x - prev); prev = x; return d; });
}

function block({ nodes = [], ways = [], relations = [] }) {
  const strings = [''];
  const sid = (s) => { let i = strings.indexOf(s); if (i < 0) { i = strings.length; strings.push(s); } return i; };
  const groups = [];
  if (nodes.length) {
    const kv = [];
    for (const n of nodes) {
      for (const [k, v] of Object.entries(n.tags || {})) kv.push(sid(k), sid(v));
      kv.push(0);
    }
    groups.push(lenField(2, [
      ...packed(1, delta(nodes.map((n) => n.id))),
      ...packed(8, delta(nodes.map((n) => Math.round(n.lat * 1e7)))),
      ...packed(9, delta(nodes.map((n) => Math.round(n.lon * 1e7)))),
      ...packed(10, kv),
    ]));
  }
  if (ways.length) {
    groups.push(ways.flatMap((w) => {
      const t = Object.entries(w.tags || {});
      return lenField(3, [...vField(1, w.id), ...packed(2, t.map(([k]) => sid(k))), ...packed(3, t.map(([, v]) => sid(v))), ...packed(8, delta(w.refs))]);
    }));
  }
  if (relations.length) {
    groups.push(relations.flatMap((r) => {
      const t = Object.entries(r.tags || {});
      return lenField(4, [
        ...vField(1, r.id), ...packed(2, t.map(([k]) => sid(k))), ...packed(3, t.map(([, v]) => sid(v))),
        ...packed(8, r.members.map((m) => sid(m.role || ''))),
        ...packed(9, delta(r.members.map((m) => m.ref))),
        ...packed(10, r.members.map((m) => ({ node: 0, way: 1, relation: 2 }[m.type]))),
      ]);
    }));
  }
  const table = strings.flatMap((s) => lenField(1, [...enc.encode(s)]));
  return Uint8Array.from([...lenField(1, table), ...groups.flatMap((g) => lenField(2, g))]);
}

function fileBlob(type, raw) {
  const blob = [...vField(2, raw.length), ...lenField(3, [...deflateSync(raw)])];
  const header = [...lenField(1, [...enc.encode(type)]), ...vField(3, blob.length)];
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([len, Buffer.from(header), Buffer.from(blob)]);
}

function pbf(data) {
  return Buffer.concat([
    fileBlob('OSMHeader', Uint8Array.from(lenField(4, [...enc.encode('OsmSchema-V0.6')]))),
    fileBlob('OSMData', block({ nodes: data.nodes })),
    fileBlob('OSMData', block({ ways: data.ways })),
    fileBlob('OSMData', block({ relations: data.relations })),
  ]);
}

/* ---------- Testgebiet ---------- */

const N = (id, lat, lon, tags) => ({ id, lat, lon, tags });
const DATA = {
  nodes: [
    N(1, 50.7300, 7.0900), N(2, 50.7300, 7.0920), N(3, 50.7300, 7.0940), N(5, 50.7320, 7.0920),
    N(6, 50.7301, 7.0900), N(7, 50.7301, 7.0940),
    N(10, 50.7305, 7.0905, { highway: 'bus_stop', name: 'Testhalt' }),
    N(11, 50.7310, 7.0930, { railway: 'station', name: 'Testbahnhof' }),
    N(20, 50.7250, 7.0850), N(21, 50.7350, 7.0850), N(22, 50.7350, 7.1000), N(23, 50.7250, 7.1000),
    N(30, 50.7500, 7.1100), N(31, 50.7100, 7.1100),
    N(50, 51.5000, 7.0000, { railway: 'station', name: 'Fernbahnhof' }),
    N(9000000001, 50.7330, 7.0950, { place: 'neighbourhood', name: 'Kleinviertel' }),
  ],
  ways: [
    { id: 100, refs: [1, 2, 3], tags: { highway: 'residential', name: 'Teststraße' } },
    { id: 101, refs: [6, 7], tags: { highway: 'footway', footway: 'sidewalk' } },
    { id: 102, refs: [2, 5], tags: { highway: 'residential', name: 'Querstraße' } },
    { id: 201, refs: [20, 21, 22] },
    { id: 202, refs: [22, 23, 20] },
    { id: 300, refs: [30, 31], tags: { waterway: 'river', name: 'Testfluss' } },
  ],
  relations: [
    {
      id: 200, tags: { type: 'boundary', boundary: 'administrative', admin_level: '10', name: 'Testviertel' },
      members: [{ type: 'way', ref: 201, role: 'outer' }, { type: 'way', ref: 202, role: 'outer' }],
    },
    { id: 400, tags: { type: 'route', route: 'bus', ref: '600' }, members: [{ type: 'way', ref: 100 }, { type: 'node', ref: 10, role: 'stop' }] },
  ],
};

const REGION = {
  id: 'test', name: 'Testregion',
  bounds: { south: 50.70, west: 7.06, north: 50.76, east: 7.14 },
  streets: { south: 50.70, west: 7.06, north: 50.76, east: 7.14 },
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jetlag-region-'));
  const file = join(dir, 'test.osm.pbf');
  writeFileSync(file, pbf(DATA));
  return { dir, file };
}

/* ---------- Tests ---------- */

test('PBF-Leser liest Knoten, Wege und Relationen samt Tags', () => {
  const { file } = setup();
  const nodes = [], ways = [], rels = [];
  readPbf(file, {
    nodes: (id, lat, lon, tags) => nodes.push({ id, lat, lon, tags }),
    ways: (id, tags, refs) => ways.push({ id, tags, refs }),
    relations: (id, tags, members) => rels.push({ id, tags, members }),
  });
  assert.equal(nodes.length, DATA.nodes.length);
  const halt = nodes.find((n) => n.id === 10);
  assert.ok(Math.abs(halt.lat - 50.7305) < 1e-7 && Math.abs(halt.lon - 7.0905) < 1e-7);
  assert.deepEqual(halt.tags, { highway: 'bus_stop', name: 'Testhalt' });
  // IDs jenseits von 2^32 bleiben exakt
  assert.ok(nodes.some((n) => n.id === 9000000001));
  assert.deepEqual(ways.find((w) => w.id === 202).refs, [22, 23, 20]);
  assert.equal(ways.find((w) => w.id === 201).tags, null);
  const grenze = rels.find((r) => r.id === 200);
  assert.deepEqual(grenze.members.map((m) => [m.type, m.ref, m.role]), [['way', 201, 'outer'], ['way', 202, 'outer']]);
});

test('Bau-Skript: Orte, Grenzen, Linien und Straßen aus derselben Quelle', () => {
  const { dir, file } = setup();
  const out = join(dir, 'data');
  const manifest = buildRegion({ region: REGION, pbf: [file], out, quiet: true });
  const read = (p) => Region.decode(p, JSON.parse(readFileSync(join(out, 'test', `${p}.json`), 'utf8')));

  // Orte – nur innerhalb der Region
  assert.deepEqual(read('pois/bus').map((p) => p.name), ['Testhalt']);
  assert.deepEqual(read('pois/station').map((p) => p.name), ['Testbahnhof']);

  // Verwaltungsgebiet: aus zwei ungetaggten Wegen zum geschlossenen Ring zusammengesetzt
  const admin = read('admin/10');
  assert.equal(admin.length, 1);
  assert.equal(admin[0].name, 'Testviertel');
  assert.ok(G.ringClosed(admin[0].ring));

  // Fluss behält seine Richtung (Norden → Süden), damit die Flussseite stimmt
  const fluss = read('refs/river');
  assert.equal(fluss[0].name, 'Testfluss');
  assert.ok(fluss[0].points[0].lat > fluss[0].points[1].lat);
  assert.equal(sideOfLines({ lat: 50.73, lng: 7.12 }, fluss).side, 1, 'östlich eines südwärts fließenden Flusses ist links');

  // Buslinie als Linie mit Kennung
  const bus = read('refs/bus_route');
  assert.equal(bus[0].key, 'bus:600');
  assert.equal(bus[0].name, 'Bus 600');

  // Straßen: Gehweg neben der Fahrbahn bleibt draußen, die Kreuzung bleibt erhalten
  const kacheln = readdirSync(join(out, 'test', 'streets'));
  assert.ok(kacheln.length >= 1);
  const wege = kacheln.flatMap((k) => read(`streets/${k.replace('.json', '')}`));
  const ids = new Set(wege.map((w) => w.id));
  assert.ok(ids.has(100) && ids.has(102) && !ids.has(101));
  const teststrasse = wege.find((w) => w.id === 100);
  assert.ok(teststrasse.pts.some(([lat, lng]) => Math.abs(lat - 50.73) < 1e-6 && Math.abs(lng - 7.092) < 1e-6), 'Kreuzungsknoten fehlt');

  // Gebiete mit Umriss und als Punkt
  const areas = read('areas');
  const viertel = areas.find((a) => a.name === 'Testviertel');
  assert.ok(viertel.hasGeometry);
  assert.ok(existsSync(join(out, 'test', 'geom', 'relation-200.json')));
  assert.equal(areas.find((a) => a.name === 'Kleinviertel').hasGeometry, false);

  // Verzeichnis
  const liste = JSON.parse(readFileSync(join(out, 'regions.json'), 'utf8'));
  assert.equal(liste.regions[0].id, 'test');
  assert.equal(liste.regions[0].version, manifest.version);
  assert.ok(manifest.files['pois/bus'] > 0);
  assert.ok(!('pois/zoo' in manifest.files), 'leere Dateien werden weggelassen');
  assert.ok(manifest.empty.includes('pois/zoo'), 'aber als leer vermerkt');
  assert.ok(manifest.empty.every((k) => !(k in manifest.files)));
});

test('Gleiche Daten ergeben denselben Datenstand', () => {
  const a = setup(), b = setup();
  const v1 = buildRegion({ region: REGION, pbf: [a.file], out: join(a.dir, 'data'), quiet: true }).version;
  const v2 = buildRegion({ region: REGION, pbf: [b.file], out: join(b.dir, 'data'), quiet: true }).version;
  assert.equal(v1, v2);
});

test('Abdeckung: nur was ganz in der Region liegt, kommt aus ihr', () => {
  const b = REGION.bounds;
  assert.ok(Region.circleInside(b, { lat: 50.73, lng: 7.10 }, 2000));
  assert.ok(!Region.circleInside(b, { lat: 50.73, lng: 7.10 }, 5000), '5 km reichen über den Rand');
  assert.ok(!Region.circleInside(b, { lat: 51.0, lng: 7.10 }, 10));
  assert.ok(Region.boundsInside(b, { south: 50.71, north: 50.75, west: 7.07, east: 7.13 }));
});

test('Filter aus sources.js werden wie bei Overpass ausgewertet', () => {
  const st = G.parseStatement(G.STREET_FILTER);
  assert.ok(G.matchesTags(st, { highway: 'residential' }));
  assert.ok(!G.matchesTags(st, { highway: 'footway', footway: 'sidewalk' }));
  assert.ok(!G.matchesTags(st, { highway: 'service', service: 'driveway' }));
  assert.ok(!G.matchesTags(st, { highway: 'motorway' }));
  const rail = G.parseStatement('way["railway"="rail"]["service"!~"."]');
  assert.ok(G.matchesTags(rail, { railway: 'rail' }));
  assert.ok(!G.matchesTags(rail, { railway: 'rail', service: 'siding' }));
  assert.throws(() => G.parseStatement('way["a"="b"](around:5)'), /Nicht verstanden/);
});

test('Straßenkacheln decken den Kreis um eine Haltestelle ab', () => {
  const tile = { lat: 0.01, lng: 0.015 };
  const keys = G.streetTilesIn({ south: 50.728, north: 50.736, west: 7.093, east: 7.103 }, tile);
  assert.ok(keys.includes(G.streetTileKey(50.732, 7.098, tile)));
  assert.equal(new Set(keys).size, keys.length);
});

test('Straßen gehören über ihre Nummer zusammen, nicht über den Namen', () => {
  // Gemeinsame Strecke zweier Autobahnen zählt für beide
  assert.deepEqual(G.identitiesOf({ type: 'way', id: 1, tags: { highway: 'motorway', ref: 'A 1;A61' } }, 'A').map((i) => i.key),
    ['road:A 1', 'road:A 61']);
  // Die B 9 heißt in Bonn mal Adenauerallee, mal Bonner Straße – bleibt aber die B 9
  const a = G.identitiesOf({ type: 'way', id: 2, tags: { highway: 'primary', ref: 'B9', name: 'Adenauerallee' } }, 'B');
  const b = G.identitiesOf({ type: 'way', id: 3, tags: { highway: 'primary', ref: 'B 9', name: 'Bonner Straße' } }, 'B');
  assert.equal(a[0].key, b[0].key);
  assert.equal(a[0].name, 'B 9');
  // Bei Doppelnummern zählt nur die gesuchte Klasse
  assert.deepEqual(G.identitiesOf({ type: 'way', id: 4, tags: { highway: 'secondary', ref: 'B 56;L 113' } }, 'L').map((i) => i.name), ['L 113']);
  // Gewöhnliche Straßen ohne Nummer behalten ihren Namen
  assert.equal(G.identitiesOf({ type: 'way', id: 5, tags: { highway: 'residential', name: 'Poststraße' } })[0].key, 'n:Poststraße');
});

// Leser für OpenStreetMap-PBF-Dateien, ohne Abhängigkeiten (nur zlib aus Node).
//
// Aufbau einer PBF-Datei: eine Folge von Blöcken, je
//   [4 Byte Länge][BlobHeader][Blob]  – Blob meist zlib-komprimiert,
// darin ein PrimitiveBlock mit Stringtabelle und Gruppen aus Knoten, Wegen oder
// Relationen. Spezifikation: https://wiki.openstreetmap.org/wiki/PBF_Format
//
// readPbf(datei, { nodes, ways, relations }) ruft für jedes Objekt der gewünschten Art
// einen Rückruf auf. Gruppen, für die kein Rückruf da ist, werden gar nicht erst
// dekodiert – mehrere Durchläufe über dieselbe Datei kosten so vor allem das Entpacken.

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/* ---------- Protobuf-Grundlagen ---------- */

class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }

  // Varint bis 2^53 exakt: oberhalb von 32 Bit wird multipliziert statt geschoben
  varint() {
    const b = this.buf;
    let byte = b[this.pos++];
    let val = byte & 0x7f;
    if (byte < 0x80) return val;
    byte = b[this.pos++]; val |= (byte & 0x7f) << 7; if (byte < 0x80) return val;
    byte = b[this.pos++]; val |= (byte & 0x7f) << 14; if (byte < 0x80) return val;
    byte = b[this.pos++]; val |= (byte & 0x7f) << 21; if (byte < 0x80) return val >>> 0;
    val >>>= 0;
    let mul = 268435456; // 2^28
    do {
      byte = b[this.pos++];
      val += (byte & 0x7f) * mul;
      mul *= 128;
    } while (byte >= 0x80);
    return val;
  }

  // sint64 (ZigZag); als Zahl, für Koordinaten und Delta-IDs genau genug
  svarint() {
    const v = this.varint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }

  bytes() {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    return [start, this.pos];
  }

  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) { const len = this.varint(); this.pos += len; }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`Unbekannter Protobuf-Feldtyp ${wire}`);
  }

  get more() {
    return this.pos < this.end;
  }
}

function packedVarints(buf, [start, end], fn) {
  const r = new Reader(buf, start, end);
  while (r.more) fn(r.varint());
}

function packedSvarints(buf, [start, end], fn) {
  const r = new Reader(buf, start, end);
  while (r.more) fn(r.svarint());
}

const decoder = new TextDecoder();

/* ---------- Blöcke ---------- */

function* blobs(buf) {
  let pos = 0;
  while (pos < buf.length) {
    const headerLen = buf.readUInt32BE(pos);
    pos += 4;
    const h = new Reader(buf, pos, pos + headerLen);
    let type = '', dataSize = 0;
    while (h.more) {
      const key = h.varint();
      const field = key >>> 3, wire = key & 7;
      if (field === 1 && wire === 2) { const [s, e] = h.bytes(); type = decoder.decode(buf.subarray(s, e)); }
      else if (field === 3 && wire === 0) dataSize = h.varint();
      else h.skip(wire);
    }
    pos += headerLen;
    const blobStart = pos;
    pos += dataSize;
    yield { type, blob: buf.subarray(blobStart, pos) };
  }
}

function unpack(blob) {
  const r = new Reader(blob);
  while (r.more) {
    const key = r.varint();
    const field = key >>> 3, wire = key & 7;
    if (field === 1 && wire === 2) { const [s, e] = r.bytes(); return blob.subarray(s, e); }
    if (field === 3 && wire === 2) { const [s, e] = r.bytes(); return inflateSync(blob.subarray(s, e)); }
    if ((field === 4 || field === 6 || field === 7) && wire === 2) throw new Error('PBF mit lzma/lz4/zstd wird nicht unterstützt');
    r.skip(wire);
  }
  throw new Error('Leerer PBF-Block');
}

/* ---------- PrimitiveBlock ---------- */

const GROUP_DENSE = 2, GROUP_NODES = 1, GROUP_WAYS = 3, GROUP_RELS = 4;
const MEMBER_TYPES = ['node', 'way', 'relation'];

function readBlock(buf, want, cb) {
  const r = new Reader(buf);
  let strings = null;
  const groups = [];
  let granularity = 100, latOffset = 0, lonOffset = 0;
  while (r.more) {
    const key = r.varint();
    const field = key >>> 3, wire = key & 7;
    if (field === 1 && wire === 2) strings = r.bytes();
    else if (field === 2 && wire === 2) groups.push(r.bytes());
    else if (field === 17) granularity = r.varint();
    else if (field === 19) latOffset = r.varint();
    else if (field === 20) lonOffset = r.varint();
    else r.skip(wire);
  }

  // Erst schauen, ob irgendeine Gruppe gebraucht wird – sonst Stringtabelle sparen
  const kinds = groups.map(([s, e]) => {
    const g = new Reader(buf, s, e);
    return g.more ? (g.varint() >>> 3) : 0;
  });
  const needed = kinds.some((k) => (k === GROUP_DENSE || k === GROUP_NODES) ? want.nodes
    : k === GROUP_WAYS ? want.ways : k === GROUP_RELS ? want.relations : false);
  if (!needed) return;

  const table = [];
  if (strings) {
    const st = new Reader(buf, strings[0], strings[1]);
    while (st.more) {
      const key = st.varint();
      if ((key >>> 3) === 1) { const [s, e] = st.bytes(); table.push(decoder.decode(buf.subarray(s, e))); }
      else st.skip(key & 7);
    }
  }
  const lat = (v) => (latOffset + granularity * v) / 1e9;
  const lon = (v) => (lonOffset + granularity * v) / 1e9;

  groups.forEach(([s, e], i) => {
    const k = kinds[i];
    if (k === GROUP_DENSE && want.nodes) readDense(buf, s, e, table, lat, lon, cb.nodes);
    else if (k === GROUP_NODES && want.nodes) readNodes(buf, s, e, table, lat, lon, cb.nodes);
    else if (k === GROUP_WAYS && want.ways) readWays(buf, s, e, table, cb.ways);
    else if (k === GROUP_RELS && want.relations) readRelations(buf, s, e, table, cb.relations);
  });
}

function tagsFrom(table, keys, vals) {
  if (!keys.length) return null;
  const t = {};
  for (let i = 0; i < keys.length; i++) t[table[keys[i]]] = table[vals[i]];
  return t;
}

function readDense(buf, s, e, table, lat, lon, fn) {
  const g = new Reader(buf, s, e);
  while (g.more) {
    const key = g.varint();
    if ((key >>> 3) !== GROUP_DENSE) { g.skip(key & 7); continue; }
    const [ds, de] = g.bytes();
    const d = new Reader(buf, ds, de);
    let ids = null, lats = null, lons = null, kv = null;
    while (d.more) {
      const k = d.varint();
      const f = k >>> 3;
      if (f === 1) ids = d.bytes();
      else if (f === 8) lats = d.bytes();
      else if (f === 9) lons = d.bytes();
      else if (f === 10) kv = d.bytes();
      else d.skip(k & 7);
    }
    const ri = new Reader(buf, ids[0], ids[1]);
    const rla = new Reader(buf, lats[0], lats[1]);
    const rlo = new Reader(buf, lons[0], lons[1]);
    const rkv = kv ? new Reader(buf, kv[0], kv[1]) : null;
    let id = 0, la = 0, lo = 0;
    while (ri.more) {
      id += ri.svarint();
      la += rla.svarint();
      lo += rlo.svarint();
      let tags = null;
      if (rkv) {
        let kIdx = rkv.varint();
        while (kIdx !== 0) {
          const vIdx = rkv.varint();
          (tags || (tags = {}))[table[kIdx]] = table[vIdx];
          kIdx = rkv.varint();
        }
      }
      fn(id, lat(la), lon(lo), tags);
    }
  }
}

function readNodes(buf, s, e, table, lat, lon, fn) {
  const g = new Reader(buf, s, e);
  while (g.more) {
    const key = g.varint();
    if ((key >>> 3) !== GROUP_NODES) { g.skip(key & 7); continue; }
    const [ns, ne] = g.bytes();
    const n = new Reader(buf, ns, ne);
    let id = 0, la = 0, lo = 0;
    const keys = [], vals = [];
    while (n.more) {
      const k = n.varint();
      const f = k >>> 3;
      if (f === 1) id = n.svarint();
      else if (f === 2) packedVarints(buf, n.bytes(), (v) => keys.push(v));
      else if (f === 3) packedVarints(buf, n.bytes(), (v) => vals.push(v));
      else if (f === 8) la = n.svarint();
      else if (f === 9) lo = n.svarint();
      else n.skip(k & 7);
    }
    fn(id, lat(la), lon(lo), tagsFrom(table, keys, vals));
  }
}

function readWays(buf, s, e, table, fn) {
  const g = new Reader(buf, s, e);
  while (g.more) {
    const key = g.varint();
    if ((key >>> 3) !== GROUP_WAYS) { g.skip(key & 7); continue; }
    const [ws, we] = g.bytes();
    const w = new Reader(buf, ws, we);
    let id = 0;
    const keys = [], vals = [], refs = [];
    while (w.more) {
      const k = w.varint();
      const f = k >>> 3;
      if (f === 1) id = w.varint();
      else if (f === 2) packedVarints(buf, w.bytes(), (v) => keys.push(v));
      else if (f === 3) packedVarints(buf, w.bytes(), (v) => vals.push(v));
      else if (f === 8) { let ref = 0; packedSvarints(buf, w.bytes(), (v) => { ref += v; refs.push(ref); }); }
      else w.skip(k & 7);
    }
    fn(id, tagsFrom(table, keys, vals), refs);
  }
}

function readRelations(buf, s, e, table, fn) {
  const g = new Reader(buf, s, e);
  while (g.more) {
    const key = g.varint();
    if ((key >>> 3) !== GROUP_RELS) { g.skip(key & 7); continue; }
    const [rs, re] = g.bytes();
    const r = new Reader(buf, rs, re);
    let id = 0;
    const keys = [], vals = [], roles = [], memids = [], types = [];
    while (r.more) {
      const k = r.varint();
      const f = k >>> 3;
      if (f === 1) id = r.varint();
      else if (f === 2) packedVarints(buf, r.bytes(), (v) => keys.push(v));
      else if (f === 3) packedVarints(buf, r.bytes(), (v) => vals.push(v));
      else if (f === 8) packedVarints(buf, r.bytes(), (v) => roles.push(v));
      else if (f === 9) { let m = 0; packedSvarints(buf, r.bytes(), (v) => { m += v; memids.push(m); }); }
      else if (f === 10) packedVarints(buf, r.bytes(), (v) => types.push(v));
      else r.skip(k & 7);
    }
    const members = memids.map((ref, i) => ({ type: MEMBER_TYPES[types[i]] || 'node', ref, role: table[roles[i]] || '' }));
    fn(id, tagsFrom(table, keys, vals), members);
  }
}

/* ---------- Einstieg ---------- */

// Eine Datei einmal lesen. buf kann wiederverwendet werden, um sie nicht für jeden
// Durchlauf neu von der Platte zu holen.
export function readPbf(fileOrBuffer, cb) {
  const buf = typeof fileOrBuffer === 'string' ? readFileSync(fileOrBuffer) : fileOrBuffer;
  const want = { nodes: !!cb.nodes, ways: !!cb.ways, relations: !!cb.relations };
  let header = null;
  for (const { type, blob } of blobs(buf)) {
    if (type === 'OSMHeader') { header = true; continue; }
    if (type !== 'OSMData') continue;
    readBlock(unpack(blob), want, cb);
  }
  if (!header) throw new Error('Keine gültige PBF-Datei (OSMHeader fehlt)');
}

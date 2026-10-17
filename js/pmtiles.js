// Vorgebaute Regionskarte (PMTiles v3) lesen – für protomaps-leaflet, das je Kachel
// getZxy(z, x, y) aufruft. Liegt die Datei im Offline-Speicher (region.js), werden die
// Bytes daraus geschnitten; sonst kommen sie per Bereichsanfrage aus dem Netz. So geht
// die Karte offline ohne Service Worker – den hat die Android-App nicht.
//
// Kachel-IDs und Verzeichnisse teilt sich das Modul mit dem Bau-Skript
// (scripts/region/pmtiles.mjs).

/* ---------- Format ---------- */

export function zxyToTileId(z, x, y) {
  let acc = 0;
  for (let t = 0; t < z; t++) acc += 4 ** t;
  const n = 2 ** z;
  let d = 0, xx = x, yy = y;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (xx & s) > 0 ? 1 : 0;
    const ry = (yy & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { xx = s - 1 - xx; yy = s - 1 - yy; }
      [xx, yy] = [yy, xx];
    }
  }
  return acc + d;
}

// Entpacktes Verzeichnis → Einträge {tileId, runLength, length, offset}
export function parseDirectory(d) {
  let p = 0;
  const v = () => {
    let val = 0, mul = 1, b;
    do { b = d[p++]; val += (b & 0x7f) * mul; mul *= 128; } while (b >= 128);
    return val;
  };
  const n = v();
  const entries = new Array(n);
  let id = 0;
  for (let i = 0; i < n; i++) { id += v(); entries[i] = { tileId: id, runLength: 0, length: 0, offset: 0 }; }
  for (let i = 0; i < n; i++) entries[i].runLength = v();
  for (let i = 0; i < n; i++) entries[i].length = v();
  for (let i = 0; i < n; i++) {
    const o = v();
    entries[i].offset = o === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : o - 1;
  }
  return entries;
}

export function parseHeader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (new TextDecoder().decode(bytes.subarray(0, 7)) !== 'PMTiles' || bytes[7] !== 3) throw new Error('Keine PMTiles-v3-Datei');
  const u64 = (o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 2 ** 32;
  return {
    rootOffset: u64(8), rootLength: u64(16), leafOffset: u64(40), dataOffset: u64(56),
    internalCompression: bytes[97], tileCompression: bytes[98], minZoom: bytes[100], maxZoom: bytes[101],
  };
}

// Eintrag für eine Kachel in einem sortierten Verzeichnis (oder null)
export function findEntry(entries, tileId) {
  let lo = 0, hi = entries.length - 1, hit = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (entries[m].tileId <= tileId) { hit = entries[m]; lo = m + 1; } else hi = m - 1;
  }
  if (!hit) return null;
  if (hit.runLength === 0) return hit;   // Verweis auf ein Blattverzeichnis
  return tileId < hit.tileId + hit.runLength ? hit : null;
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unpack(bytes, compression) {
  if (compression === 2) return gunzip(bytes);
  if (compression === 0 || compression === 1) return bytes;
  throw new Error(`Komprimierung ${compression} wird nicht unterstützt`);
}

/* ---------- Quelle ---------- */

export class RegionMap {
  constructor(url, cacheName) {
    this.url = url;
    this.cacheName = cacheName;
    this.blob = null;
    this.geprueft = 0;
    this.kopf = null;
    this.blaetter = new Map();
  }

  // Liegt die ganze Datei auf dem Gerät? Nachgesehen wird höchstens alle paar Sekunden –
  // ein Download während der Sitzung greift so gleich, ohne dass jede Kachel fragt.
  async gespeichert() {
    if (this.blob || Date.now() - this.geprueft < 5000) return this.blob;
    this.geprueft = Date.now();
    try {
      const hit = await (await caches.open(this.cacheName)).match(this.url);
      if (hit) this.blob = await hit.blob();
    } catch (e) { /* kein Cache-Speicher */ }
    return this.blob;
  }

  vergessen() {
    this.blob = null;
    this.geprueft = 0;
  }

  async bytes(offset, length, signal) {
    const blob = await this.gespeichert();
    if (blob) return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    const res = await fetch(this.url, { headers: { range: `bytes=${offset}-${offset + length - 1}` }, signal });
    if (!res.ok) throw new Error(`Karte: HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // Server ohne Bereichsanfragen schickt alles – dann den Ausschnitt selbst nehmen
    return res.status === 200 && buf.length > length ? buf.slice(offset, offset + length) : buf;
  }

  header() {
    if (!this.kopf) {
      this.kopf = (async () => {
        const start = await this.bytes(0, 16384);
        const h = parseHeader(start);
        const rootBytes = h.rootOffset + h.rootLength <= start.length
          ? start.subarray(h.rootOffset, h.rootOffset + h.rootLength)
          : await this.bytes(h.rootOffset, h.rootLength);
        h.root = parseDirectory(await unpack(rootBytes, h.internalCompression));
        return h;
      })().catch((e) => { this.kopf = null; throw e; });
    }
    return this.kopf;
  }

  async leaf(h, offset, length, signal) {
    const key = `${offset}:${length}`;
    if (!this.blaetter.has(key)) {
      this.blaetter.set(key, this.bytes(h.leafOffset + offset, length, signal)
        .then((b) => unpack(b, h.internalCompression)).then(parseDirectory)
        .catch((e) => { this.blaetter.delete(key); throw e; }));
    }
    return this.blaetter.get(key);
  }

  // Schnittstelle für protomaps-leaflet: {data: ArrayBuffer} oder undefined
  async getZxy(z, x, y, signal) {
    const h = await this.header();
    if (z < h.minZoom || z > h.maxZoom) return undefined;
    const id = zxyToTileId(z, x, y);
    let dir = h.root;
    for (let tiefe = 0; tiefe < 4; tiefe++) {
      const e = findEntry(dir, id);
      if (!e) return undefined;
      if (e.runLength === 0) { dir = await this.leaf(h, e.offset, e.length, signal); continue; }
      const roh = await this.bytes(h.dataOffset + e.offset, e.length, signal);
      const data = await unpack(roh, h.tileCompression);
      return { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
    }
    return undefined;
  }
}

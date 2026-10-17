// PMTiles v3 lesen und schreiben – so viel, wie das Ausschneiden einer Region aus der
// Protomaps-Weltkarte braucht. Spezifikation: https://github.com/protomaps/PMTiles
//
// Eine PMTiles-Datei: 127 Byte Kopf, Wurzelverzeichnis, Metadaten, Blattverzeichnisse,
// Kacheldaten. Verzeichniseinträge sind nach Kachel-ID (Hilbert-Kurve je Zoomstufe)
// sortiert und varint-kodiert; ein Eintrag mit runLength 0 verweist auf ein
// Blattverzeichnis.

import { gzipSync, gunzipSync } from 'node:zlib';
import { zxyToTileId, parseDirectory } from '../../js/pmtiles.js';

/* ---------- Kachel-IDs ---------- */

// Kachel-IDs und Verzeichnisformat teilt sich das Skript mit der App (js/pmtiles.js)
export { zxyToTileId };

export function lonToX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function latToY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

/* ---------- Kopf und Verzeichnisse ---------- */

export function readHeader(buf) {
  if (buf.toString('latin1', 0, 7) !== 'PMTiles' || buf[7] !== 3) throw new Error('Keine PMTiles-v3-Datei');
  const u64 = (o) => Number(buf.readBigUInt64LE(o));
  return {
    rootOffset: u64(8), rootLength: u64(16), metadataOffset: u64(24), metadataLength: u64(32),
    leafOffset: u64(40), leafLength: u64(48), dataOffset: u64(56), dataLength: u64(64),
    addressedTiles: u64(72), tileEntries: u64(80), tileContents: u64(88),
    clustered: buf[96], internalCompression: buf[97], tileCompression: buf[98], tileType: buf[99],
    minZoom: buf[100], maxZoom: buf[101],
    minLon: buf.readInt32LE(102) / 1e7, minLat: buf.readInt32LE(106) / 1e7,
    maxLon: buf.readInt32LE(110) / 1e7, maxLat: buf.readInt32LE(114) / 1e7,
    centerZoom: buf[118], centerLon: buf.readInt32LE(119) / 1e7, centerLat: buf.readInt32LE(123) / 1e7,
  };
}

export function writeHeader(h) {
  const b = Buffer.alloc(127);
  b.write('PMTiles', 0, 'latin1');
  b[7] = 3;
  const u64 = (o, v) => b.writeBigUInt64LE(BigInt(v), o);
  u64(8, h.rootOffset); u64(16, h.rootLength); u64(24, h.metadataOffset); u64(32, h.metadataLength);
  u64(40, h.leafOffset); u64(48, h.leafLength); u64(56, h.dataOffset); u64(64, h.dataLength);
  u64(72, h.addressedTiles); u64(80, h.tileEntries); u64(88, h.tileContents);
  b[96] = h.clustered; b[97] = h.internalCompression; b[98] = h.tileCompression; b[99] = h.tileType;
  b[100] = h.minZoom; b[101] = h.maxZoom;
  b.writeInt32LE(Math.round(h.minLon * 1e7), 102); b.writeInt32LE(Math.round(h.minLat * 1e7), 106);
  b.writeInt32LE(Math.round(h.maxLon * 1e7), 110); b.writeInt32LE(Math.round(h.maxLat * 1e7), 114);
  b[118] = h.centerZoom;
  b.writeInt32LE(Math.round(h.centerLon * 1e7), 119); b.writeInt32LE(Math.round(h.centerLat * 1e7), 123);
  return b;
}

function unpack(buf, compression) {
  if (compression === 2) return gunzipSync(buf);
  if (compression === 1 || compression === 0) return buf;
  throw new Error(`Komprimierung ${compression} wird nicht unterstützt`);
}

export function readDirectory(buf, compression) {
  return parseDirectory(unpack(buf, compression));
}

export function writeDirectory(entries) {
  const out = [];
  const v = (n) => { while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); };
  v(entries.length);
  let last = 0;
  for (const e of entries) { v(e.tileId - last); last = e.tileId; }
  for (const e of entries) v(e.runLength);
  for (const e of entries) v(e.length);
  entries.forEach((e, i) => {
    if (i > 0 && e.offset === entries[i - 1].offset + entries[i - 1].length) v(0);
    else v(e.offset + 1);
  });
  return gzipSync(Buffer.from(out));
}

/* ---------- Lesen über eine Bytequelle ---------- */

// source.get(offset, length) → Promise<Buffer>; die Quelle kann eine Datei, ein Puffer
// oder ein HTTP-Server mit Range-Anfragen sein.
export async function openArchive(source) {
  const header = readHeader(await source.get(0, 127));
  const root = readDirectory(await source.get(header.rootOffset, header.rootLength), header.internalCompression);
  const leaves = new Map();
  async function find(tileId) {
    let entries = root;
    for (let depth = 0; depth < 4; depth++) {
      let lo = 0, hi = entries.length - 1, hit = null;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (entries[m].tileId <= tileId) { hit = entries[m]; lo = m + 1; } else hi = m - 1;
      }
      if (!hit) return null;
      if (hit.runLength === 0) {
        if (!leaves.has(hit.offset)) {
          leaves.set(hit.offset, readDirectory(await source.get(header.leafOffset + hit.offset, hit.length), header.internalCompression));
        }
        entries = leaves.get(hit.offset);
        continue;
      }
      return tileId < hit.tileId + hit.runLength ? hit : null;
    }
    return null;
  }
  const metadata = header.metadataLength
    ? JSON.parse(unpack(await source.get(header.metadataOffset, header.metadataLength), header.internalCompression).toString('utf8'))
    : {};
  return { header, metadata, find };
}

/* ---------- Ausschneiden ---------- */

// Alle Kacheln im Rahmen bis maxZoom aus einem Archiv in ein neues, kleines Archiv.
// Kacheldaten werden in zusammenhängenden Stücken gelesen, nicht einzeln.
export async function extract(source, bounds, { maxZoom = 14, onProgress = () => {} } = {}) {
  const arch = await openArchive(source);
  const h = arch.header;
  const wanted = [];
  for (let z = h.minZoom; z <= Math.min(maxZoom, h.maxZoom); z++) {
    for (let x = lonToX(bounds.west, z); x <= lonToX(bounds.east, z); x++) {
      for (let y = latToY(bounds.north, z); y <= latToY(bounds.south, z); y++) {
        const tileId = zxyToTileId(z, x, y);
        const e = await arch.find(tileId);
        if (e) wanted.push({ tileId, offset: e.offset, length: e.length });
      }
    }
  }
  wanted.sort((a, b) => a.tileId - b.tileId);

  // Gleiche Inhalte (Meer, leere Flächen) liegen in der Quelle nur einmal – im neuen
  // Archiv auch
  const unique = [...new Map(wanted.map((t) => [t.offset, t])).values()].sort((a, b) => a.offset - b.offset);
  const chunks = [];
  for (const t of unique) {
    const last = chunks[chunks.length - 1];
    if (last && t.offset - (last.start + last.length) < 256 * 1024 && last.length < 16 * 1048576) {
      last.length = Math.max(last.length, t.offset + t.length - last.start);
      last.tiles.push(t);
    } else {
      chunks.push({ start: t.offset, length: t.length, tiles: [t] });
    }
  }
  const data = new Map();
  let geladen = 0;
  for (const c of chunks) {
    const buf = await source.get(h.dataOffset + c.start, c.length);
    for (const t of c.tiles) data.set(t.offset, buf.subarray(t.offset - c.start, t.offset - c.start + t.length));
    geladen += c.length;
    onProgress(geladen, chunks.reduce((s, x) => s + x.length, 0));
  }

  // Neues Archiv: Kopf, Wurzelverzeichnis, Metadaten, Kacheldaten
  const newOffset = new Map();
  const parts = [];
  let pos = 0;
  for (const t of wanted) {
    if (!newOffset.has(t.offset)) {
      newOffset.set(t.offset, pos);
      parts.push(data.get(t.offset));
      pos += t.length;
    }
  }
  const entries = wanted.map((t) => ({ tileId: t.tileId, runLength: 1, length: t.length, offset: newOffset.get(t.offset) }));
  const rootDir = writeDirectory(entries);
  const metadata = gzipSync(Buffer.from(JSON.stringify({ ...arch.metadata, bounds: undefined, name: 'Jetlag Regionskarte' })));
  const header = {
    ...h,
    rootOffset: 127, rootLength: rootDir.length,
    metadataOffset: 127 + rootDir.length, metadataLength: metadata.length,
    leafOffset: 127 + rootDir.length + metadata.length, leafLength: 0,
    dataOffset: 127 + rootDir.length + metadata.length, dataLength: pos,
    addressedTiles: entries.length, tileEntries: entries.length, tileContents: newOffset.size,
    clustered: 1, internalCompression: 2, maxZoom: Math.min(maxZoom, h.maxZoom),
    minLon: bounds.west, minLat: bounds.south, maxLon: bounds.east, maxLat: bounds.north,
    centerZoom: Math.min(12, maxZoom),
    centerLon: (bounds.west + bounds.east) / 2, centerLat: (bounds.south + bounds.north) / 2,
  };
  if (127 + rootDir.length > 16384) throw new Error('Wurzelverzeichnis zu groß für einen ersten Abruf');
  return { buffer: Buffer.concat([writeHeader(header), rootDir, metadata, ...parts]), tiles: entries.length, header };
}

/* ---------- Quellen ---------- */

export function bufferSource(buf) {
  return { get: async (offset, length) => buf.subarray(offset, offset + length) };
}

export function httpSource(url) {
  return {
    async get(offset, length) {
      for (let versuch = 0; versuch < 4; versuch++) {
        try {
          const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}`, 'User-Agent': 'jetlag-toolkit-region-build' } });
          if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          return res.status === 200 ? buf.subarray(offset, offset + length) : buf;
        } catch (e) {
          if (versuch === 3) throw e;
          await new Promise((r) => setTimeout(r, 2000 * (versuch + 1)));
        }
      }
      return null;
    },
  };
}

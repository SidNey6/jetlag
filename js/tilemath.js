// Slippy-Map-Kachelmathematik – rein rechnerisch, damit sie ohne Browser prüfbar ist.

export function lngToX(lng, z) { return Math.floor(((lng + 180) / 360) * 2 ** z); }

export function latToY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

export function tileList(bounds, minZ, maxZ, limit = 2000) {
  const out = [];
  for (let z = minZ; z <= maxZ; z++) {
    const x0 = lngToX(bounds.west, z), x1 = lngToX(bounds.east, z);
    const y0 = latToY(bounds.north, z), y1 = latToY(bounds.south, z);
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        out.push({ z, x, y });
        if (out.length > limit) return out;
      }
    }
  }
  return out;
}

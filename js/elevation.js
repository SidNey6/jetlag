// Geländehöhe über dem Meeresspiegel – für Fragen wie "bist du näher am Meeresspiegel
// als wir?". Quelle ist das Copernicus-Höhenmodell (90 m) über die offene
// Open-Meteo-Schnittstelle; ohne Schlüssel, bis 100 Punkte je Anfrage.

import { bundleGet, bundleCovers } from './bundle.js';
import { areaBounds } from './constraints.js';
import { distance, cropGrid } from './geo.js';
import * as Region from './region.js';

const API = 'https://api.open-meteo.com/v1/elevation';
const PRO_ANFRAGE = 100;
// Open-Meteo zählt jeden Koordinatenpunkt gegen ein Budget von 600 pro Minute.
// Ein Raster darf deshalb höchstens 20 × 20 Punkte haben, sonst kippt schon eine
// einzige Abfrage das Minutenbudget.
const MAX_SEITE = 20;

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('abgebrochen')); }, { once: true });
  });
}

// onWait(sekunden): Bescheid geben, wenn wegen Drosselung gewartet wird;
// noWait: bei Drosselung sofort aufgeben statt eine Minute zu warten
async function fetchPoints(points, { signal, onWait, noWait = false } = {}) {
  const out = [];
  for (let i = 0; i < points.length; i += PRO_ANFRAGE) {
    const chunk = points.slice(i, i + PRO_ANFRAGE);
    const url = `${API}?latitude=${chunk.map((p) => p.lat.toFixed(5)).join(',')}`
      + `&longitude=${chunk.map((p) => p.lng.toFixed(5)).join(',')}`;
    let res;
    for (let versuch = 0; versuch < 3; versuch++) {
      res = await fetch(url, { signal });
      if (res.status !== 429 || noWait) break;
      // Minutenbudget erschöpft: abwarten statt aufgeben
      if (onWait) onWait(61);
      await pause(61000, signal);
    }
    if (!res.ok) throw new Error(res.status === 429
      ? 'Höhendienst gedrosselt – bitte in ein paar Minuten erneut versuchen'
      : `Höhendaten nicht verfügbar (HTTP ${res.status})`);
    const json = await res.json();
    if (!Array.isArray(json.elevation)) throw new Error('Höhendaten unlesbar');
    out.push(...json.elevation);
    if (i + PRO_ANFRAGE < points.length) await pause(400, signal);
  }
  return out;
}

export async function fetchElevationAt(point) {
  const [h] = await fetchPoints([point]);
  if (h == null || Number.isNaN(h)) throw new Error('Keine Höhe für diesen Punkt');
  return h;
}

// Gitterweite nach Gebietsgröße: fein genug für Hügel, aber höchstens gut tausend Punkte.
export function gridSizeFor(bounds) {
  const mid = (bounds.south + bounds.north) / 2;
  const breite = distance({ lat: mid, lng: bounds.west }, { lat: mid, lng: bounds.east });
  const hoehe = distance({ lat: bounds.south, lng: bounds.west }, { lat: bounds.north, lng: bounds.west });
  const lang = Math.max(breite, hoehe);
  const n = Math.max(8, Math.min(MAX_SEITE, Math.round(lang / 150)));
  return {
    cols: breite >= hoehe ? n : Math.max(8, Math.round(n * breite / hoehe)),
    rows: hoehe >= breite ? n : Math.max(8, Math.round(n * hoehe / breite)),
  };
}

export async function fetchElevationGrid(bounds, { signal, onWait, noWait } = {}) {
  const { rows, cols } = gridSizeFor(bounds);
  const points = [];
  for (let r = 0; r < rows; r++) {
    const lat = bounds.south + (r / (rows - 1)) * (bounds.north - bounds.south);
    for (let c = 0; c < cols; c++) {
      points.push({ lat, lng: bounds.west + (c / (cols - 1)) * (bounds.east - bounds.west) });
    }
  }
  const values = await fetchPoints(points, { signal, onWait, noWait });
  return { ...bounds, rows, cols, values, source: 'Copernicus-Geländemodell (90 m)' };
}

// Rahmen mit 5 % Rand, damit auch Punkte knapp außerhalb interpoliert werden können
function withMargin(b) {
  const dLat = (b.north - b.south) * 0.05, dLng = (b.east - b.west) * 0.05;
  return { south: b.south - dLat, north: b.north + dLat, west: b.west - dLng, east: b.east + dLng };
}

// Raster aus den vorgebauten Regionsdaten, falls die Region das Gebiet abdeckt
export async function regionGridFor(bounds, maxSide = 64) {
  const region = Region.regionForBounds(bounds);
  if (!region || !Region.has(region, 'elevation')) return null;
  try {
    const grid = await Region.regionGet(region, 'elevation');
    return grid ? cropGrid(grid, bounds, maxSide) : null;
  } catch (e) {
    return null;   // offline und nicht auf dem Gerät: weiter mit Vorrat oder Online-Dienst
  }
}

// Gitter für ein Spielgebiet – aus dem Offline-Vorrat, wenn vorhanden.
// Reihenfolge: vorgebaute Region → Offline-Vorrat → Online-Höhendienst
export async function elevationGridFor(area, around = null, { onWait } = {}) {
  const b = area ? areaBounds(area) : null;
  if (b) {
    const regional = await regionGridFor(withMargin(b));
    if (regional) return { ...regional, offline: true };
  }
  const probe = around || (b ? { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 } : null);
  if (probe && bundleCovers(probe)) {
    const vorrat = await bundleGet('elevation');
    if (vorrat) return { ...vorrat, offline: true };
  }
  if (!b) throw new Error('Für Höhenfragen braucht es ein Spielgebiet');
  return fetchElevationGrid(withMargin(b), { onWait });
}

// Schwere Rechnungen im Hintergrund-Thread: das Raster für Linien-, Fluss- und
// Höhenfragen und die Restfläche. Im Vordergrund hätten sie die Karte beim Verschieben
// und jeden Tipp blockiert – auf älteren Handys sekundenlang.
//
// Fragen werden dem Worker einmal geschickt und dort unter ihrem Fingerabdruck (id und
// Revision) aufbewahrt; danach reicht der Fingerabdruck. Ohne Worker (alte Browser,
// Tests) wird wie früher direkt gerechnet.

import { rasterFor, remainingStats } from './constraints.js';

let worker = null;
let kaputt = false;
let seq = 0;
const offen = new Map();
const bekannt = new Set();
const raster = new Map();
const laufend = new Set();
const stats = new Map();

export function fingerprint(c) {
  return `${c.id}#${c.rev || 0}`;
}

function ensure() {
  if (worker || kaputt || typeof Worker === 'undefined') return worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const job = offen.get(data.id);
      if (!job) return;
      offen.delete(data.id);
      if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
    };
    worker.onerror = () => {
      // Modul-Worker nicht unterstützt oder abgestürzt: ab jetzt im Vordergrund
      kaputt = true;
      worker = null;
      for (const j of offen.values()) j.reject(new Error('Worker ausgefallen'));
      offen.clear();
    };
  } catch (e) {
    kaputt = true;
    worker = null;
  }
  return worker;
}

function post(kind, list, extra, nochmal = true) {
  const w = ensure();
  if (!w) return Promise.reject(new Error('kein Worker'));
  const id = ++seq;
  const constraints = list.map((c) => {
    const fp = fingerprint(c);
    if (bekannt.has(fp)) return [fp, null];
    bekannt.add(fp);
    return [fp, c];
  });
  return new Promise((resolve, reject) => {
    offen.set(id, { resolve, reject });
    w.postMessage({ id, kind, constraints, ...extra });
  }).catch((e) => {
    // Der Worker kennt eine Frage nicht (neu gestartet): vollständig nachschicken
    if (e.message === 'fehlt' && nochmal) {
      for (const c of list) bekannt.delete(fingerprint(c));
      return post(kind, list, extra, false);
    }
    throw e;
  });
}

function merke(map, key, value, max) {
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
}

function changed() {
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('jetlag:computed'));
}

/* ---------- Raster ---------- */

// Sofort das fertige Raster oder null; ist es noch nicht da, wird es im Hintergrund
// gerechnet und danach "jetlag:computed" gemeldet.
export function rasterOf(c, bounds, cols) {
  const key = `${fingerprint(c)}|${bounds.south.toFixed(5)},${bounds.west.toFixed(5)},${bounds.north.toFixed(5)},${bounds.east.toFixed(5)}|${cols}`;
  if (raster.has(key)) return raster.get(key);
  if (!ensure()) {
    const r = rasterFor(c, bounds, cols);
    merke(raster, key, r, 40);
    return r;
  }
  if (!laufend.has(key)) {
    laufend.add(key);
    post('raster', [c], { bounds, cols })
      .then((r) => merke(raster, key, r, 40))
      .catch(() => merke(raster, key, rasterFor(c, bounds, cols), 40))
      .finally(() => { laufend.delete(key); changed(); });
  }
  return null;
}

/* ---------- Restfläche ---------- */

// Gleiche Lage, gleiche Antwort: das Ergebnis wird je Gebiet und Fragenstand gemerkt.
export function remaining(area, list, samples = 4000, rounds = 3) {
  const key = `${JSON.stringify(area)}|${list.map(fingerprint).join(',')}|${samples}|${rounds}`;
  if (!stats.has(key)) {
    const job = (ensure() ? post('stats', list, { area, samples, rounds }) : Promise.reject(new Error('kein Worker')))
      .catch(() => remainingStats(area, list, samples, rounds))
      .finally(changed);
    merke(stats, key, job, 20);
  }
  return stats.get(key);
}

export function busy() {
  return laufend.size > 0 || offen.size > 0;
}

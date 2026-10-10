// Hintergrund-Thread für Raster und Restfläche (siehe compute.js). Hält die Fragen unter
// ihrem Fingerabdruck vor, damit große Geometrie nur einmal herübergeschickt wird – und
// damit die Indizes je Frage (constraints.js) erhalten bleiben.

import { rasterFor, remainingStats } from './constraints.js';

const store = new Map();

self.onmessage = ({ data }) => {
  const { id, kind, constraints } = data;
  try {
    const list = [];
    for (const [fp, c] of constraints) {
      if (c) store.set(fp, c);
      const bekannt = store.get(fp);
      if (!bekannt) { self.postMessage({ id, error: 'fehlt' }); return; }
      list.push(bekannt);
    }
    if (kind === 'raster') {
      self.postMessage({ id, result: rasterFor(list[0], data.bounds, data.cols) });
    } else if (kind === 'stats') {
      self.postMessage({ id, result: remainingStats(data.area, list, data.samples, data.rounds) });
    } else {
      self.postMessage({ id, error: `Unbekannte Aufgabe ${kind}` });
    }
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};

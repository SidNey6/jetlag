// Regelwerk: mitgeliefert als rules/lifack.json, im Zustand überschreibbar.
// Die App selbst bleibt regelfrei – hier steht nur, welche Fragen es gibt, welche
// Werte sie zulassen und wie lange die Fristen laufen.

import { getState, update } from './state.js';

export const BUNDLED_URL = './rules/lifack.json';

let rules = null;
let bundled = null;

export function getRules() {
  return rules;
}

export async function loadRules() {
  const s = getState();
  if (s.rules && s.rules.data) {
    try {
      rules = validateRules(s.rules.data);
      return rules;
    } catch (e) {
      console.warn('Eigenes Regelwerk unbrauchbar, nehme das mitgelieferte', e);
    }
  }
  rules = await loadBundled();
  return rules;
}

export async function loadBundled() {
  if (bundled) return bundled;
  const res = await fetch(BUNDLED_URL);
  if (!res.ok) throw new Error(`Regeldatei nicht ladbar (HTTP ${res.status})`);
  bundled = validateRules(await res.json());
  return bundled;
}

export function isCustom() {
  const s = getState();
  return !!(s.rules && s.rules.data);
}

export function applyRules(data, name) {
  const valid = validateRules(data);
  update((s) => { s.rules = { data: valid, name: name || valid.name, at: Date.now() }; }, 'Regelwerk ersetzt');
  rules = valid;
  ensureValidSize();
  return valid;
}

export async function resetRules() {
  update((s) => { s.rules = null; }, 'Regelwerk zurückgesetzt');
  rules = await loadBundled();
  ensureValidSize();
  return rules;
}

/* ---------- Prüfung ---------- */

// Lieber hier hart abweisen als später mit undefined durch die Oberfläche stolpern.
export function validateRules(data) {
  const fail = (msg) => { throw new Error(msg); };
  if (!data || typeof data !== 'object') fail('Die Datei enthält kein Objekt.');
  if (!Array.isArray(data.gameSizes) || !data.gameSizes.length) fail('"gameSizes" fehlt oder ist leer.');
  for (const g of data.gameSizes) {
    if (!g.id || !g.label) fail('Jede Spielgröße braucht "id" und "label".');
    for (const k of ['hidingPeriodMinutes', 'hidingZoneRadiusM', 'answerMinutes']) {
      if (typeof g[k] !== 'number' || !(g[k] > 0)) fail(`Spielgröße "${g.id}": "${k}" muss eine Zahl über 0 sein.`);
    }
  }
  if (!Array.isArray(data.questions) || !data.questions.length) fail('"questions" fehlt oder ist leer.');
  const sizeIds = new Set(data.gameSizes.map((g) => g.id));
  for (const q of data.questions) {
    if (!q.id || !q.label) fail('Jede Fragekategorie braucht "id" und "label".');
    if (!Array.isArray(q.options)) fail(`Kategorie "${q.id}": "options" muss eine Liste sein.`);
    if (q.minutes == null && !q.minutesBySize) fail(`Kategorie "${q.id}": "minutes" oder "minutesBySize" fehlt.`);
    for (const o of q.options) {
      if (!o.label) fail(`Kategorie "${q.id}": eine Option hat kein "label".`);
      if (o.sizes && o.sizes.some((s) => !sizeIds.has(s))) {
        fail(`Kategorie "${q.id}", Option "${o.label}": unbekannte Spielgröße in "sizes".`);
      }
    }
  }
  return data;
}

/* ---------- Spielgröße ---------- */

export function sizes() {
  return rules ? rules.gameSizes : [];
}

export function currentSize() {
  if (!rules) return null;
  const id = getState().gameSize;
  return rules.gameSizes.find((g) => g.id === id) || rules.gameSizes[0];
}

export function setSize(id) {
  update((s) => { s.gameSize = id; }, 'Spielgröße geändert');
}

// Nach einem Regelwechsel kann die gemerkte Größe verschwunden sein.
function ensureValidSize() {
  const s = getState();
  if (!rules) return;
  if (!rules.gameSizes.some((g) => g.id === s.gameSize)) setSize(rules.gameSizes[0].id);
}

/* ---------- Fragen ---------- */

export function categories() {
  if (!rules) return [];
  return [...rules.questions].sort((a, b) => (a.order || 0) - (b.order || 0));
}

export function category(id) {
  return rules ? rules.questions.find((q) => q.id === id) : null;
}

export function optionsFor(categoryId) {
  const q = category(categoryId);
  if (!q) return [];
  const size = currentSize();
  return q.options.filter((o) => !o.sizes || !size || o.sizes.includes(size.id));
}

export function answerMinutes(categoryId) {
  const q = category(categoryId);
  if (!q) return null;
  const size = currentSize();
  if (q.minutesBySize && size) return q.minutesBySize[size.id] ?? q.minutes ?? null;
  return q.minutes ?? null;
}

export function drawLabel(q) {
  if (!q) return '';
  const draw = q.draw ?? 0;
  const pick = q.pick ?? 0;
  if (!draw) return '';
  return draw === pick ? `${draw} ziehen` : `${draw} ziehen, ${pick} behalten`;
}

// Alle Distanzwerte einer Kategorie – füttert die Schnellauswahl in den Formularen.
export function distancePresets(categoryId) {
  return optionsFor(categoryId)
    .map((o) => o.meters)
    .filter((m) => typeof m === 'number' && m > 0)
    .filter((m, i, arr) => arr.indexOf(m) === i)
    .sort((a, b) => a - b);
}

export function hidingZoneRadius() {
  const size = currentSize();
  return size ? size.hidingZoneRadiusM : null;
}

export function hidingPeriodMinutes() {
  const size = currentSize();
  return size ? size.hidingPeriodMinutes : null;
}

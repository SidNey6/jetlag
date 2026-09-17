// Regelwerk: mitgeliefert als rules/lifack.json, im Zustand überschreibbar.
// Die App selbst bleibt regelfrei – hier steht nur, welche Fragen es gibt, welche
// Werte sie zulassen und wie lange die Fristen laufen.

import { getState, update } from './state.js';
import { poiCategory, reference } from './sources.js';

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

export const APP_TYPES = ['radius', 'thermo', 'compare', 'nearest', 'area', 'elevation', 'sector'];
export const TIE_BREAKS = ['inside', 'outside', 'warmer', 'colder', 'closer', 'further', 'yes', 'no'];
export const PHASES = ['roundStart', 'hidingEnd', 'searchStart', 'endgame', 'found'];
export const OUTCOMES = ['seekersLose', 'hiderLoses', 'note'];

// Lieber hier hart abweisen als später mit undefined durch die Oberfläche stolpern.
// Jede Meldung nennt die Stelle, damit man beim Bearbeiten des JSON weiß, wo.
export function validateRules(data) {
  const fail = (msg) => { throw new Error(msg); };
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const strList = (x, wo) => {
    if (x == null) return;
    if (!Array.isArray(x) || x.some((v) => typeof v !== 'string')) fail(`${wo} muss eine Liste von Texten sein.`);
  };
  const oneOf = (x, liste, wo) => {
    if (x != null && !liste.includes(x)) fail(`${wo}: "${x}" ist nicht erlaubt (möglich: ${liste.join(', ')}).`);
  };

  if (!data || typeof data !== 'object') fail('Die Datei enthält kein Objekt.');
  if (data.schemaVersion != null && ![1, 2].includes(data.schemaVersion)) fail('"schemaVersion" muss 1 oder 2 sein.');

  if (!Array.isArray(data.gameSizes) || !data.gameSizes.length) fail('"gameSizes" fehlt oder ist leer.');
  for (const g of data.gameSizes) {
    if (!g.id || !g.label) fail('Jede Spielgröße braucht "id" und "label".');
    for (const k of ['hidingPeriodMinutes', 'hidingZoneRadiusM', 'answerMinutes']) {
      if (!isNum(g[k]) || !(g[k] > 0)) fail(`Spielgröße "${g.id}": "${k}" muss eine Zahl über 0 sein.`);
    }
  }
  const sizeIds = new Set(data.gameSizes.map((g) => g.id));

  const r = data.round || {};
  if (r.deadlines != null) {
    if (!Array.isArray(r.deadlines)) fail('"round.deadlines" muss eine Liste sein.');
    for (const d of r.deadlines) {
      const wo = `Frist "${d.id || d.label || '?'}"`;
      if (!d.id) fail('Jede Frist in "round.deadlines" braucht eine "id".');
      if (!isNum(d.afterMinutes) || d.afterMinutes <= 0) fail(`${wo}: "afterMinutes" muss über 0 sein.`);
      oneOf(d.from || 'roundStart', PHASES, `${wo}, "from"`);
      oneOf(d.until, PHASES, `${wo}, "until"`);
      if (!d.until) fail(`${wo}: "until" fehlt – bis zu welcher Phase gilt die Frist?`);
      oneOf(d.outcome || 'note', OUTCOMES, `${wo}, "outcome"`);
    }
  }
  if (r.lateAnswer != null) {
    const la = r.lateAnswer;
    if (!Array.isArray(la.steps)) fail('"round.lateAnswer.steps" muss eine Liste sein.');
    for (const st of la.steps) {
      if (!isNum(st.overMinutes) || st.overMinutes < 0) fail('"lateAnswer.steps": "overMinutes" muss 0 oder mehr sein.');
      if (st.nextDrawDelta != null && !Number.isInteger(st.nextDrawDelta)) fail('"lateAnswer.steps": "nextDrawDelta" muss eine ganze Zahl sein.');
      if (st.nextQuestionFree != null && typeof st.nextQuestionFree !== 'boolean') fail('"lateAnswer.steps": "nextQuestionFree" muss true oder false sein.');
    }
    if (la.deductOvertimeFactor != null && (!isNum(la.deductOvertimeFactor) || la.deductOvertimeFactor < 0)) {
      fail('"lateAnswer.deductOvertimeFactor" muss 0 oder mehr sein.');
    }
  }
  oneOf(r.scoring, ['longestSingleRound', 'totalTime'], '"round.scoring"');

  const hz = data.hidingZone || {};
  if (hz.anchorCategory != null && !poiCategory(hz.anchorCategory)) fail(`"hidingZone.anchorCategory": unbekannte Kategorie "${hz.anchorCategory}".`);
  if (hz.anchorChoices != null && (!Number.isInteger(hz.anchorChoices) || hz.anchorChoices < 1)) fail('"hidingZone.anchorChoices" muss mindestens 1 sein.');
  if (hz.anchorToleranceM != null && (!isNum(hz.anchorToleranceM) || hz.anchorToleranceM < 0)) fail('"hidingZone.anchorToleranceM" muss 0 oder mehr sein.');
  oneOf(hz.lockAt, PHASES, '"hidingZone.lockAt"');
  strList(hz.rules, '"hidingZone.rules"');

  const eg = data.endgame || {};
  if (eg.answerWithinM != null && (!isNum(eg.answerWithinM) || eg.answerWithinM < 0)) fail('"endgame.answerWithinM" muss 0 oder mehr sein.');
  if (eg.hiderMayMove != null && typeof eg.hiderMayMove !== 'boolean') fail('"endgame.hiderMayMove" muss true oder false sein.');
  strList(eg.rules, '"endgame.rules"');

  const an = data.answering || {};
  if (an.tieToleranceM != null && (!isNum(an.tieToleranceM) || an.tieToleranceM < 0)) fail('"answering.tieToleranceM" muss 0 oder mehr sein.');
  oneOf(an.position, ['current', 'any'], '"answering.position"');
  strList(an.rules, '"answering.rules"');

  for (const k of ['transport', 'research']) {
    const t = data[k];
    if (t == null) continue;
    strList(t.allowed, `"${k}.allowed"`);
    strList(t.forbidden, `"${k}.forbidden"`);
    strList(t.rules, `"${k}.rules"`);
  }
  if (data.sections != null) {
    if (!Array.isArray(data.sections)) fail('"sections" muss eine Liste sein.');
    for (const sec of data.sections) {
      if (!sec.title) fail('Jeder Abschnitt in "sections" braucht einen "title".');
      strList(sec.rules, `Abschnitt "${sec.title}", "rules"`);
    }
  }

  if (!Array.isArray(data.questions) || !data.questions.length) fail('"questions" fehlt oder ist leer.');
  for (const q of data.questions) {
    if (!q.id || !q.label) fail('Jede Fragekategorie braucht "id" und "label".');
    if (!Array.isArray(q.options)) fail(`Kategorie "${q.id}": "options" muss eine Liste sein.`);
    if (q.minutes == null && !q.minutesBySize) fail(`Kategorie "${q.id}": "minutes" oder "minutesBySize" fehlt.`);
    if (q.appType !== null) oneOf(q.appType, APP_TYPES, `Kategorie "${q.id}", "appType"`);
    oneOf(q.tieBreak, TIE_BREAKS, `Kategorie "${q.id}", "tieBreak"`);
    oneOf(q.nearestMode, ['same', 'which'], `Kategorie "${q.id}", "nearestMode"`);
    for (const k of ['draw', 'pick']) {
      if (q[k] != null && (!Number.isInteger(q[k]) || q[k] < 0)) fail(`Kategorie "${q.id}": "${k}" muss eine ganze Zahl ab 0 sein.`);
    }
    for (const o of q.options) {
      const wo = `Kategorie "${q.id}", Option "${o.label || '?'}"`;
      if (!o.label) fail(`Kategorie "${q.id}": eine Option hat kein "label".`);
      if (o.sizes && o.sizes.some((sz) => !sizeIds.has(sz))) fail(`${wo}: unbekannte Spielgröße in "sizes".`);
      if ('appType' in o && o.appType !== null) oneOf(o.appType, APP_TYPES, `${wo}, "appType"`);
      oneOf(o.match, ['point', 'shape'], `${wo}, "match"`);
      if (o.adminLevel != null && (!Number.isInteger(o.adminLevel) || o.adminLevel < 2 || o.adminLevel > 12)) {
        fail(`${wo}: "adminLevel" muss zwischen 2 und 12 liegen.`);
      }
      if (o.freeChoice != null && typeof o.freeChoice !== 'boolean') fail(`${wo}: "freeChoice" muss true oder false sein.`);
      if (o.osm != null) {
        const ids = Array.isArray(o.osm) ? o.osm : [o.osm];
        if (!ids.length || ids.some((x) => typeof x !== 'string')) fail(`${wo}: "osm" muss eine ID oder eine Liste von IDs sein.`);
        for (const id of ids) {
          if (!poiCategory(id) && !reference(id)) fail(`${wo}: unbekannte Quelle "${id}".`);
        }
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

/* ---------- Erweiterte Regeln ---------- */

export function deadlines() {
  return (rules && rules.round && rules.round.deadlines) || [];
}

export function lateAnswerRules() {
  return (rules && rules.round && rules.round.lateAnswer) || null;
}

// Regel "lateAnswer": die höchste zutreffende Stufe gilt. overMinutes 0 heißt
// "jede Verspätung", 5 heißt "ab 5 Minuten".
export function lateAnswerStep(overMs, la = lateAnswerRules()) {
  if (!la || !la.steps || overMs <= 0) return null;
  const min = overMs / 60000;
  return la.steps
    .filter((st) => min >= st.overMinutes)
    .sort((a, b) => b.overMinutes - a.overMinutes)[0] || null;
}

export function scoringMode() {
  return (rules && rules.round && rules.round.scoring) || 'longestSingleRound';
}

export function hidingZoneRules() {
  return (rules && rules.hidingZone) || {};
}

export function endgameRules() {
  return (rules && rules.endgame) || {};
}

export function answeringRules() {
  return (rules && rules.answering) || {};
}

export function tieBreak(categoryId) {
  const q = category(categoryId);
  return q && q.tieBreak ? q.tieBreak : null;
}

// "same": Ist dein nächstes X dasselbe wie meines? (Matching)
// "which": Welchem X bist du am nächsten? (Tentakel)
// Ohne Angabe gilt die Kategorie "matching" als "same" – so funktionieren ältere Dateien weiter.
export function nearestMode(categoryId) {
  const q = category(categoryId);
  if (!q) return 'which';
  return q.nearestMode || (q.id === 'matching' ? 'same' : 'which');
}

export const TIE_LABEL = {
  inside: 'drin', outside: 'draußen', warmer: 'wärmer', colder: 'kälter',
  closer: 'näher', further: 'weiter', yes: 'ja', no: 'nein',
};

export function tieToleranceM() {
  return answeringRules().tieToleranceM || 0;
}

export function textBlocks() {
  if (!rules) return [];
  const bloecke = [];
  const add = (title, rulesList, chips) => {
    if ((rulesList && rulesList.length) || (chips && chips.some((c) => c.items && c.items.length))) {
      bloecke.push({ title, rules: rulesList || [], chips: chips || [] });
    }
  };
  if (rules.transport) {
    add('Verkehrsmittel', rules.transport.rules, [
      { label: 'erlaubt', items: rules.transport.allowed || [], kind: 'ok' },
      { label: 'nicht erlaubt', items: rules.transport.forbidden || [], kind: 'no' },
    ]);
  }
  if (rules.research) {
    add('Recherche', rules.research.rules, [
      { label: 'erlaubt', items: rules.research.allowed || [], kind: 'ok' },
      { label: 'nicht erlaubt', items: rules.research.forbidden || [], kind: 'no' },
    ]);
  }
  const hz = hidingZoneRules();
  add('Versteckzone', hz.rules);
  add('Antworten', answeringRules().rules);
  add('Endgame', endgameRules().rules);
  for (const sec of rules.sections || []) add(sec.title, sec.rules);
  return bloecke;
}

// Quellen einer Option als Liste; "osm" darf ein einzelner Eintrag oder eine Liste sein.
export function optionSources(option) {
  if (!option || option.osm == null) return [];
  return Array.isArray(option.osm) ? option.osm : [option.osm];
}

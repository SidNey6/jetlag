// Fragen anlegen und verwalten. Jede Frage wird zu einem Constraint,
// der sofort auf der Karte als ausgeschlossene Fläche erscheint.

import { getState, update, uid } from './state.js';
import * as C from './constraints.js';
import * as Loc from './location.js';
import * as MapMod from './map.js';
import { distance, formatDistance, bearing } from './geo.js';
import { el, clear, append, openSheet, confirmSheet, toast, segmented, formatTime } from './ui/ui.js';
import { poiSheet, areaPickerSheet, findPois, findNearestFeatures, REFERENCES } from './overpass.js';
import * as Rules from './rules.js';
import { createTimer } from './timers.js';
import { logNote } from './rounds.js';

const UNIT_STEPS = { metric: 1000, imperial: 1609.344 };

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export function unitSuffix() {
  return getState().settings.unit === 'imperial' ? 'mi' : 'km';
}
function toMeters(value) {
  return value * UNIT_STEPS[getState().settings.unit];
}
function fromMeters(m) {
  return m / UNIT_STEPS[getState().settings.unit];
}

/* ---------- Punktauswahl ---------- */

export function pointField(label, initial, onChange, { allowMe = true } = {}) {
  let value = initial || null;
  const readout = el('div', { class: 'card-sub' });
  function paint() {
    readout.textContent = value
      ? `${value.name ? value.name + ' · ' : ''}${value.lat.toFixed(5)}, ${value.lng.toFixed(5)}`
      : 'kein Punkt gewählt';
  }
  function set(p, name) {
    value = p ? { lat: p.lat, lng: p.lng, name: name || p.name } : null;
    paint();
    onChange(value);
  }
  paint();

  const row = el('div', { class: 'row row-wrap' },
    allowMe ? el('button', {
      class: 'btn btn-small',
      onclick: () => {
        const me = Loc.current();
        if (!me) return toast('Noch keine Position', 'error');
        set(me, 'meine Position');
      },
    }, '⌖ Meine Position') : null,
    el('button', {
      class: 'btn btn-small',
      onclick: async (e) => {
        const sheet = e.target.closest('.sheet-backdrop');
        if (sheet) sheet.style.display = 'none';
        const p = await MapMod.pickPoint('Punkt für „' + label + '" antippen');
        if (sheet) sheet.style.display = '';
        if (p) set(p, null);
      },
    }, '👆 Auf Karte'),
    el('button', {
      class: 'btn btn-small',
      onclick: () => openSavedPointPicker((p, name) => set(p, name)),
    }, '📍 Gespeichert'),
  );

  return { node: el('label', { class: 'field' }, label, row, readout), get value() { return value; }, set };
}

function openSavedPointPicker(pick) {
  const s = getState();
  const items = [
    ...s.markers.map((m) => ({ ...m, kind: 'Marker' })),
    ...s.pois.map((p) => ({ ...p, kind: 'POI' })),
  ];
  openSheet('Gespeicherter Punkt', (body, close) => {
    if (!items.length) {
      append(body, el('div', { class: 'empty', text: 'Noch keine Marker oder POIs gespeichert.' }));
      return [];
    }
    const me = Loc.current();
    for (const it of items) {
      append(body, el('button', {
        class: 'card', style: { textAlign: 'left' },
        onclick: () => { close(); pick(it, it.name); },
      },
        el('div', { class: 'card-title' }, it.name || 'Ohne Namen'),
        el('div', { class: 'card-sub', text: `${it.kind}${me ? ' · ' + formatDistance(distance(me, it), getState().settings.unit) : ''}` }),
      ));
    }
    return [];
  });
}

/* ---------- Neue Frage ---------- */

const FREE_TOOLS = [
  ['radius', 'Radius', 'Bist du im Umkreis von X um diesen Punkt?'],
  ['thermo', 'Thermometer', 'Ich bin gefahren – bin ich wärmer oder kälter?'],
  ['compare', 'Vergleich', 'Bist du näher oder weiter an einem Ort als ich?'],
  ['nearest', 'Nächster Ort', 'Welchem Ort aus einer Liste bist du am nächsten?'],
  ['area', 'Gebiet', 'Bist du in diesem Gebiet (Dorf, Bezirk, Fläche)?'],
  ['sector', 'Richtung', 'Liegst du in diesem Himmelsrichtungs-Sektor?'],
];

export function openQuestionPicker() {
  const rules = Rules.getRules();
  const size = Rules.currentSize();

  openSheet('Welche Frage?', (body, close) => {
    if (rules) {
      append(body, el('div', { class: 'hint' },
        `${rules.name}`, size ? ` · Spielgröße ${size.label}` : ''));
      for (const cat of Rules.categories()) {
        const n = Rules.optionsFor(cat.id).length;
        const minutes = Rules.answerMinutes(cat.id);
        append(body, el('button', {
          class: 'card', style: { textAlign: 'left' },
          disabled: n === 0,
          onclick: () => { close(); openRuleOptions(cat); },
        },
          el('div', { class: 'card-title' },
            el('span', { class: 'grow', text: cat.label }),
            el('span', { class: 'card-sub', text: [Rules.drawLabel(cat), minutes ? `${minutes} Min` : null].filter(Boolean).join(' · ') })),
          el('div', { class: 'card-sub', text: n ? cat.prompt : 'In dieser Spielgröße nicht verfügbar' })));
      }
      append(body, el('div', { class: 'hint', style: { marginTop: '10px', fontWeight: '600' }, text: 'Freie Werkzeuge' }));
    }

    for (const [type, title, sub] of FREE_TOOLS) {
      const t = C.TYPES[type];
      append(body, el('button', {
        class: 'card', style: { textAlign: 'left' },
        onclick: () => { close(); openQuestionForm(type); },
      },
        el('div', { class: 'card-title' },
          el('span', { class: 'dot', style: { background: t.color } }), `${t.icon}  ${title}`),
        el('div', { class: 'card-sub', text: sub })));
    }
    return [];
  });
}

// Werte einer Regelkategorie, gefiltert auf die eingestellte Spielgröße.
export function openRuleOptions(cat) {
  const options = Rules.optionsFor(cat.id);
  const unit = getState().settings.unit;
  openSheet(cat.label, (body, close) => {
    append(body, el('div', { class: 'hint', text: cat.prompt }));
    let group = null;
    for (const o of options) {
      if (o.group && o.group !== group) {
        group = o.group;
        append(body, el('div', { class: 'hint', style: { marginTop: '8px', fontWeight: '600' }, text: group }));
      }
      const extra = [
        o.meters ? formatDistance(o.meters, unit) : null,
        o.radiusLabel && !o.meters ? o.radiusLabel : null,
        o.osm ? 'aus OpenStreetMap ladbar' : null,
      ].filter(Boolean).join(' · ');
      append(body, el('button', {
        class: 'card', style: { textAlign: 'left' },
        onclick: () => { close(); startRuleQuestion(cat, o); },
      },
        el('div', { class: 'card-title', text: o.label }),
        extra ? el('div', { class: 'card-sub', text: extra }) : null));
    }
    return [el('button', { class: 'btn grow', onclick: () => close() }, 'Zurück')];
  });
}

// Frage nach Regelwerk stellen: Frist läuft, Protokolleintrag steht, und wo es
// geometrisch etwas zu holen gibt, öffnet sich das passende Formular.
export function startRuleQuestion(cat, option) {
  const minutes = Rules.answerMinutes(cat.id);
  if (minutes) {
    createTimer({ name: `Antwort: ${cat.label} – ${option.label}`, kind: 'countdown', duration: minutes * 60000 });
  }
  logNote(`${cat.label}: ${option.label} — ${Rules.drawLabel(cat)}${minutes ? `, ${minutes} Min Frist` : ''}`);

  const type = option.appType || cat.appType;
  if (!type) {
    toast(`Notiert. ${Rules.drawLabel(cat)}${minutes ? `, ${minutes} Min` : ''}`, 'ok');
    document.dispatchEvent(new CustomEvent('jetlag:changed'));
    return;
  }
  openQuestionForm(type, null, {
    label: option.label,
    radius: option.meters,
    presets: Rules.distancePresets(cat.id),
    poiCategory: option.osm,
    poiRadius: option.meters,
    matching: cat.id === 'matching',
    ruleLabel: `${cat.label}: ${option.label}`,
  });
}

export function openQuestionForm(type, existing = null, prefill = null) {
  const builders = { radius: radiusForm, thermo: thermoForm, compare: compareForm, area: areaForm, nearest: nearestForm, sector: sectorForm };
  const build = builders[type];
  if (!build) return;
  openSheet(existing ? 'Frage bearbeiten' : C.TYPES[type].label, (body, close) => {
    const form = build(body, existing, prefill);
    return [
      el('button', { class: 'btn grow', onclick: () => close() }, 'Abbrechen'),
      el('button', {
        class: 'btn grow btn-primary',
        onclick: () => {
          const c = form.collect();
          if (!c) return;
          commit(c, existing);
          close();
        },
      }, existing ? 'Speichern' : 'Übernehmen'),
    ];
  });
}

function commit(c, existing) {
  if (existing) {
    update((s) => {
      const i = s.constraints.findIndex((x) => x.id === existing.id);
      if (i >= 0) s.constraints[i] = { ...existing, ...c };
    }, 'Frage geändert');
  } else {
    const entry = { id: uid('q'), active: true, at: Date.now(), ...c };
    update((s) => {
      s.constraints.push(entry);
      s.game.log.push({ id: uid('lg'), at: entry.at, kind: 'question', text: C.describe(entry, s.settings.unit) });
    }, 'Frage hinzugefügt');
  }
  MapMod.render();
  // Die Restflächen-Zahl wird zentral berechnet, damit Chip und Meldung nie zwei
  // unterschiedliche Stichproben zeigen.
  document.dispatchEvent(new CustomEvent('jetlag:changed', { detail: { announceStats: true } }));
}

/* ---------- Formulare ---------- */

function answerSeg(labels, initial, onChange) {
  return segmented([{ value: true, label: labels[0] }, { value: false, label: labels[1] }], initial, onChange);
}

// Anzeige auf drei Nachkommastellen kürzen; gerechnet wird weiter mit dem exakten
// Meterwert, sonst stünde bei ½ Meile "0,804672" im Feld.
function inputValue(meters) {
  return String(+fromMeters(meters).toFixed(3));
}

export function distanceField(label, initialMeters, onChange, presets = []) {
  let meters = initialMeters;
  const input = el('input', { type: 'number', step: '0.01', inputmode: 'decimal', value: inputValue(meters) });
  input.addEventListener('input', () => {
    const v = parseFloat(input.value.replace(',', '.'));
    if (isFinite(v)) { meters = toMeters(v); onChange(meters); }
  });
  const pills = el('div', { class: 'pills' }, presets.map((m) => el('button', {
    class: `pill ${m === meters ? 'on' : ''}`,
    onclick: (e) => {
      meters = m;
      input.value = inputValue(m);
      onChange(m);
      pills.querySelectorAll('.pill').forEach((p) => p.classList.remove('on'));
      e.target.classList.add('on');
    },
  }, formatDistance(m, getState().settings.unit))));
  input.addEventListener('input', () => pills.querySelectorAll('.pill').forEach((p) => p.classList.remove('on')));
  return {
    node: el('label', { class: 'field' }, `${label} (${unitSuffix()})`, input, presets.length ? pills : null),
    get meters() { return meters; },
  };
}

function radiusForm(body, existing, prefill) {
  const s = getState();
  let center = existing?.center || prefill?.at || Loc.current() || null;
  let centerName = existing?.centerName || (prefill?.at ? 'gewählter Punkt' : center ? 'meine Position' : null);
  let radius = existing?.radius ?? prefill?.radius ?? s.presets.radius[2];
  let inside = existing?.inside ?? true;

  const pf = pointField('Bezugspunkt', center ? { ...center, name: centerName } : null, (p) => {
    center = p; centerName = p?.name;
  });
  const df = distanceField('Radius', radius, (m) => { radius = m; },
    (prefill?.presets && prefill.presets.length) ? prefill.presets : s.presets.radius);
  append(body, prefill?.ruleLabel ? el('div', { class: 'hint', text: prefill.ruleLabel }) : null, pf.node, df.node,
    el('label', { class: 'field' }, 'Antwort',
      answerSeg(['Ja – innerhalb', 'Nein – außerhalb'], inside, (v) => { inside = v; })));

  return {
    collect() {
      if (!center) { toast('Bezugspunkt fehlt', 'error'); return null; }
      if (!(radius > 0)) { toast('Radius fehlt', 'error'); return null; }
      return { type: 'radius', center: { lat: center.lat, lng: center.lng }, centerName, radius, inside };
    },
  };
}

function thermoForm(body, existing) {
  const s = getState();
  let from = existing?.from || s.ui.thermoStart || null;
  let to = existing?.to || Loc.current() || null;
  let warmer = existing?.warmer ?? true;

  const info = el('div', { class: 'hint' });
  const refresh = () => {
    info.textContent = from && to
      ? `Zurückgelegt: ${formatDistance(distance(from, to), s.settings.unit)} Richtung ${Math.round(bearing(from, to))}°`
      : 'Beide Punkte wählen';
  };
  const ff = pointField('Startpunkt (vor der Fahrt)', from, (p) => { from = p; refresh(); });
  const tf = pointField('Endpunkt (jetzt)', to, (p) => { to = p; refresh(); });
  refresh();

  append(body, 
    el('button', {
      class: 'btn btn-small',
      onclick: () => {
        const me = Loc.current();
        if (!me) return toast('Noch keine Position', 'error');
        update((st) => { st.ui.thermoStart = { lat: me.lat, lng: me.lng }; });
        ff.set(me, 'Startmarke');
        toast('Startpunkt gemerkt', 'ok');
      },
    }, '⚑ Hier ist der Startpunkt'),
    ff.node, tf.node, info,
    el('label', { class: 'field' }, 'Antwort',
      answerSeg(['Wärmer', 'Kälter'], warmer, (v) => { warmer = v; })),
  );

  return {
    collect() {
      if (!from || !to) { toast('Start- und Endpunkt nötig', 'error'); return null; }
      if (distance(from, to) < 1) { toast('Start und Ende sind identisch', 'error'); return null; }
      return { type: 'thermo', from: { lat: from.lat, lng: from.lng }, to: { lat: to.lat, lng: to.lng }, warmer };
    },
  };
}

function compareForm(body, existing, prefill) {
  const s = getState();
  let refId = existing?.refId || prefill?.poiCategory || null;
  let features = existing?.features || null;
  let refName = existing?.refName || prefill?.label || null;
  let ref = existing?.ref || null;
  let myPoint = existing?.myPoint || Loc.current() || null;
  let closer = existing?.closer ?? true;
  let manual = existing?.myDistance ?? null;

  const status = el('div', { class: 'card-sub' });
  const info = el('div', { class: 'hint' });
  const manualInput = el('input', { type: 'number', step: '0.01', inputmode: 'decimal', placeholder: 'nur falls die Suche nichts findet' });
  manualInput.addEventListener('input', () => {
    const v = parseFloat(manualInput.value.replace(',', '.'));
    manual = isFinite(v) ? toMeters(v) : null;
    refresh();
  });

  function currentDistance() {
    if (manual != null) return manual;
    if (!myPoint) return null;
    if (features && features.length) return C.refDistance({ features }, myPoint);
    if (ref) return distance(myPoint, ref);
    return null;
  }

  function refresh() {
    const d = currentDistance();
    info.textContent = d != null
      ? `Dein Abstand: ${formatDistance(d, s.settings.unit)}`
      : 'Bezugsobjekt wählen – die App misst den Abstand selbst.';
  }

  // Ausgedehnte Objekte wie Autobahnen oder Küsten lassen sich nicht als Punkt
  // angeben; deshalb wird die echte Geometrie geholt und darauf gemessen.
  async function search(id) {
    const from = myPoint || Loc.current();
    if (!from) { status.textContent = 'Kein Standort – trag den Abstand unten direkt ein.'; return; }
    myPoint = from;
    refId = id;
    paintRefs();
    const spec = REFERENCES.find((r) => r.id === id);
    status.textContent = `Suche ${spec.label} …`;
    try {
      const res = await findNearestFeatures(from, id, { area: getState().area });
      features = res.features;
      ref = null;
      refName = res.name ? `${spec.label} (${res.name})` : spec.label;
      const arten = [...new Set(res.features.map((f) => f.type))]
        .map((t) => ({ line: 'Linie', polygon: 'Fläche', point: 'Punkt' }[t] || t)).join('/');
      status.textContent = `${refName} · ${formatDistance(res.distance, getState().settings.unit)} · als ${arten} gemessen`;
      refresh();
    } catch (e) {
      features = null;
      status.textContent = `${e.message || e}`;
    }
  }

  const refRow = el('div', { class: 'pills' });
  function paintRefs() {
    clear(refRow);
    for (const r of REFERENCES) {
      refRow.append(el('button', {
        class: `pill ${r.id === refId ? 'on' : ''}`,
        onclick: () => search(r.id),
      }, r.label));
    }
  }
  paintRefs();

  append(body, 
    prefill?.ruleLabel ? el('div', { class: 'hint', text: prefill.ruleLabel }) : null,
    el('label', { class: 'field' }, 'Bezugsobjekt – wird automatisch gesucht', refRow),
    status,
    el('details', {},
      el('summary', { class: 'hint', style: { padding: '6px 0' } }, 'Stattdessen eigenen Punkt wählen'),
      pointField('Eigener Bezugspunkt', ref ? { ...ref, name: refName } : null, (p) => {
        ref = p; features = null; refId = null;
        refName = p?.name || 'eigener Punkt';
        paintRefs();
        status.textContent = p ? `Eigener Punkt · ${refName}` : '';
        refresh();
      }, { allowMe: false }).node),
    el('label', { class: 'field' }, `Abstand selbst eintragen (${unitSuffix()})`, manualInput),
    info,
    el('label', { class: 'field' }, 'Antwort',
      answerSeg(['Näher als ich', 'Weiter als ich'], closer, (v) => { closer = v; })),
  );

  refresh();
  if (refId && !existing && !features) search(refId);

  return {
    collect() {
      if (!features && !ref && manual == null) { toast('Bezugsobjekt wählen oder Abstand eintragen', 'error'); return null; }
      if (currentDistance() == null) { toast('Abstand unbekannt – Standort fehlt', 'error'); return null; }
      return {
        type: 'compare',
        refId, refName,
        features: features || null,
        ref: ref ? { lat: ref.lat, lng: ref.lng } : null,
        myPoint: myPoint ? { lat: myPoint.lat, lng: myPoint.lng } : null,
        myDistance: manual,
        closer,
      };
    },
  };
}

function areaForm(body, existing) {
  let ring = existing?.ring || null;
  let name = existing?.name || '';
  let inside = existing?.inside ?? true;
  const info = el('div', { class: 'hint', text: ring ? `${ring.length} Stützpunkte` : 'Noch kein Gebiet geladen' });
  const nameInput = el('input', { value: name, placeholder: 'z. B. Bezirk Mitte' });
  nameInput.addEventListener('input', () => { name = nameInput.value; });

  append(body, 
    el('button', {
      class: 'btn btn-small',
      onclick: () => areaPickerSheet(Loc.current(), (area) => {
        ring = area.ring; name = area.name;
        nameInput.value = name;
        info.textContent = `${ring.length} Stützpunkte · ${area.level || ''}`;
      }),
    }, '🗺 Ort oder Gebiet laden (OSM)'),
    el('button', {
      class: 'btn btn-small',
      onclick: async (e) => {
        const sheet = e.target.closest('.sheet-backdrop');
        sheet.style.display = 'none';
        const pts = await drawPolygon();
        sheet.style.display = '';
        if (pts && pts.length >= 3) { ring = pts; info.textContent = `${ring.length} Stützpunkte (gezeichnet)`; }
      },
    }, '✏️ Gebiet auf Karte zeichnen'),
    el('label', { class: 'field' }, 'Name', nameInput),
    info,
    el('label', { class: 'field' }, 'Antwort',
      answerSeg(['Ja – im Gebiet', 'Nein – außerhalb'], inside, (v) => { inside = v; })),
  );

  return {
    collect() {
      if (!ring || ring.length < 3) { toast('Gebiet fehlt', 'error'); return null; }
      return { type: 'area', ring, name, inside };
    },
  };
}

function nearestForm(body, existing, prefill) {
  let pois = existing?.pois || getState().pois.slice();
  let chosenId = existing?.chosenId || null;
  let invert = existing?.invert ?? false;
  const matching = !!prefill?.matching;
  const list = el('div', { class: 'pills' });
  const status = el('div', { class: 'hint' });

  function paint() {
    clear(list);
    if (!pois.length) {
      list.append(el('div', { class: 'hint', text: 'Noch keine Orte geladen.' }));
      return;
    }
    for (const p of pois) {
      list.append(el('button', {
        class: `pill ${p.id === chosenId ? 'on' : ''}`,
        onclick: () => { chosenId = p.id; paint(); },
      }, p.name || 'Ohne Namen'));
    }
  }

  // Bei einer Regelfrage die passende Kategorie gleich laden – und beim Matching
  // den eigenen nächstgelegenen Ort vorauswählen, denn genau um den geht es.
  async function loadFromRule() {
    const me = Loc.current();
    if (!me) { status.textContent = 'Standort nötig – Punkt auf der Karte setzen.'; return; }
    status.textContent = 'Lade Orte aus OpenStreetMap …';
    try {
      const found = await findPois(me, prefill.poiCategory, prefill.poiRadius || 15000);
      if (!found.length) { status.textContent = 'Nichts gefunden – Umkreis über „Orte laden" vergrößern.'; return; }
      pois = found.slice(0, 40).map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, name: p.name }));
      update((st) => { st.pois = pois; });
      MapMod.render();
      if (matching) chosenId = pois[0].id;
      status.textContent = matching
        ? `${pois.length} Orte geladen, dein nächster ist vorausgewählt.`
        : `${pois.length} Orte geladen.`;
      paint();
    } catch (e) {
      status.textContent = `Laden fehlgeschlagen: ${e.message || e}`;
    }
  }

  paint();
  append(body, 
    prefill?.ruleLabel ? el('div', { class: 'hint', text: prefill.ruleLabel }) : null,
    el('button', {
      class: 'btn btn-small',
      onclick: () => poiSheet(Loc.current(), (found) => {
        pois = found;
        chosenId = null;
        update((s) => { s.pois = found; }, null);
        MapMod.render();
        paint();
      }),
    }, '🔎 Orte im Umkreis laden'),
    status,
    el('div', { class: 'hint', text: matching
      ? 'Dein nächstgelegener Ort ist markiert. Antwort „Nein" schließt genau dessen Umgebung aus.'
      : 'Genannten Ort antippen – alle anderen schließen ihre Umgebung aus.' }),
    list,
    matching ? el('label', { class: 'field' }, 'Antwort',
      segmented([{ value: false, label: 'Ja – gleicher Ort' }, { value: true, label: 'Nein – anderer' }],
        invert, (v) => { invert = v; })) : null,
  );

  if (prefill?.poiCategory && !existing) loadFromRule();

  return {
    collect() {
      if (!pois.length || !chosenId) { toast('Ort auswählen', 'error'); return null; }
      return {
        type: 'nearest',
        pois: pois.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, name: p.name })),
        chosenId,
        invert,
      };
    },
  };
}

function sectorForm(body, existing, prefill) {
  let center = existing?.center || prefill?.at || Loc.current() || null;
  let from = existing?.from ?? 0;
  let to = existing?.to ?? 90;
  let radius = existing?.radius ?? null;
  let inside = existing?.inside ?? true;

  const pf = pointField('Mittelpunkt', center, (p) => { center = p; });
  const fromIn = el('input', { type: 'number', value: String(from), min: '0', max: '360' });
  const toIn = el('input', { type: 'number', value: String(to), min: '0', max: '360' });
  fromIn.addEventListener('input', () => { from = parseFloat(fromIn.value) || 0; });
  toIn.addEventListener('input', () => { to = parseFloat(toIn.value) || 0; });
  const quick = el('div', { class: 'pills' }, [
    ['Nord', 315, 45], ['Ost', 45, 135], ['Süd', 135, 225], ['West', 225, 315],
    ['NO', 0, 90], ['SO', 90, 180], ['SW', 180, 270], ['NW', 270, 360],
  ].map(([label, a, b]) => el('button', {
    class: 'pill',
    onclick: () => { from = a; to = b; fromIn.value = String(a); toIn.value = String(b); },
  }, label)));

  append(body, pf.node, quick,
    el('div', { class: 'row' },
      el('label', { class: 'field grow' }, 'von °', fromIn),
      el('label', { class: 'field grow' }, 'bis °', toIn)),
    el('label', { class: 'field' }, 'Antwort',
      answerSeg(['Ja – in Richtung', 'Nein'], inside, (v) => { inside = v; })));

  return {
    collect() {
      if (!center) { toast('Mittelpunkt fehlt', 'error'); return null; }
      return { type: 'sector', center: { lat: center.lat, lng: center.lng }, from, to, radius, inside };
    },
  };
}

/* ---------- Polygon zeichnen ---------- */

export function drawPolygon() {
  return new Promise((resolve) => {
    const map = MapMod.getMap();
    const pts = [];
    const group = L.layerGroup().addTo(map);
    let poly = null;
    const banner = el('div', { class: 'measure-readout' });
    const paintBanner = () => {
      clear(banner);
      banner.append(
        `${pts.length} Punkte antippen`,
        el('button', { class: 'btn btn-small', style: { marginLeft: '8px' }, onclick: () => finish(pts.length >= 3 ? pts : null) }, 'Fertig'),
        el('button', { class: 'btn btn-small', style: { marginLeft: '6px' }, onclick: () => finish(null) }, 'Abbrechen'),
      );
    };
    paintBanner();
    document.getElementById('panel-map').append(banner);
    document.querySelector('.tabbar [data-go="map"]').click();

    function onClick(e) {
      pts.push({ lat: e.latlng.lat, lng: e.latlng.lng });
      L.circleMarker(e.latlng, { radius: 4, color: '#34d399', fillColor: '#34d399', fillOpacity: 1 }).addTo(group);
      if (poly) poly.remove();
      if (pts.length >= 2) poly = L.polygon(pts, { color: '#34d399', weight: 2, fillOpacity: 0.1 }).addTo(group);
      paintBanner();
    }
    function finish(result) {
      map.off('click', onClick);
      group.remove();
      banner.remove();
      resolve(result);
    }
    map.on('click', onClick);
  });
}

/* ---------- Liste ---------- */

export function renderConstraintList() {
  const host = document.getElementById('constraint-list');
  if (!host) return;
  clear(host);
  const s = getState();
  if (!s.constraints.length) {
    host.append(el('div', { class: 'empty' },
      el('div', { text: 'Noch keine Fragen ausgewertet.' }),
      el('div', { class: 'hint', style: { marginTop: '8px' }, text: 'Jede beantwortete Frage verkleinert das Suchgebiet auf der Karte.' })));
    return;
  }

  if (s.area) {
    const st = C.remainingStats(s.area, s.constraints.filter((c) => c.active !== false), 6000);
    if (st.fraction != null) {
      host.append(el('div', { class: 'card' },
        el('div', { class: 'card-title' }, `Restgebiet: ${C.formatFraction(st)}`),
        el('div', { class: 'progress' }, el('i', { style: { width: `${Math.max(0.5, st.fraction * 100)}%` } })),
        el('div', { class: 'card-sub', text: st.remaining === 0
          ? 'Keine Fläche mehr übrig – widersprechen sich zwei Antworten?'
          : plural(s.constraints.filter((c) => c.active !== false).length, 'aktive Frage', 'aktive Fragen') }),
      ));
    }
  }

  for (const c of [...s.constraints].reverse()) {
    const t = C.TYPES[c.type] || { color: '#94a3b8', label: c.type };
    host.append(el('div', { class: `card ${c.active === false ? 'off' : ''}` },
      el('div', { class: 'card-title' },
        el('span', { class: 'dot', style: { background: t.color } }),
        el('span', { class: 'grow', text: C.describe(c, s.settings.unit) })),
      el('div', { class: 'card-sub', text: `${t.label} · ${formatTime(c.at || Date.now())}` }),
      el('div', { class: 'row row-wrap' },
        el('button', {
          class: 'btn btn-small',
          onclick: () => {
            update((st) => {
              const x = st.constraints.find((q) => q.id === c.id);
              if (x) x.active = x.active === false;
            }, 'Frage umgeschaltet');
            MapMod.render();
            renderConstraintList();
          },
        }, c.active === false ? 'Aktivieren' : 'Deaktivieren'),
        el('button', { class: 'btn btn-small', onclick: () => openQuestionForm(c.type, c) }, 'Bearbeiten'),
        el('button', {
          class: 'btn btn-small',
          onclick: () => {
            const o = C.outline(c)[0];
            const target = o?.center || o?.at || o?.points?.[1] || c.center || c.ref || c.to;
            if (target) MapMod.flyTo(target);
            document.querySelector('.tabbar [data-go="map"]').click();
          },
        }, 'Zeigen'),
        el('div', { class: 'spacer' }),
        el('button', {
          class: 'btn btn-small btn-danger',
          onclick: async () => {
            if (!(await confirmSheet('Frage löschen?', C.describe(c, s.settings.unit), { danger: true, okLabel: 'Löschen' }))) return;
            update((st) => { st.constraints = st.constraints.filter((q) => q.id !== c.id); }, 'Frage gelöscht');
            MapMod.render();
            renderConstraintList();
          },
        }, 'Löschen'),
      ),
    ));
  }
}

// "Mehr": Spielgebiet, Werkzeuge, Offline-Karten, Teilen, Einstellungen.

import { getState, update, replaceState, emptyState } from './state.js';
import * as C from './constraints.js';
import * as Loc from './location.js';
import * as MapMod from './map.js';
import { drawPolygon, pointField, unitSuffix, distanceField } from './questions.js';
import { areaPickerSheet } from './overpass.js';
import { formatDistance } from './geo.js';
import { el, clear, openSheet, confirmSheet, promptSheet, toast } from './ui/ui.js';
import { openDiceSheet, openListsSheet } from './random.js';
import { openShareSheet, openImportSheet } from './share.js';
import { tileCacheCard } from './tiles.js';
import { exportText } from './rounds.js';

export function render() {
  const host = document.getElementById('more-body');
  if (!host || document.getElementById('panel-more').hidden) return;
  const s = getState();
  clear(host);

  /* Spielgebiet */
  host.append(el('div', { class: 'card' },
    el('div', { class: 'card-title', text: 'Spielgebiet' }),
    el('div', { class: 'card-sub', text: areaLabel(s.area) }),
    el('div', { class: 'hint', text: 'Begrenzt die Karte und ist die Basis für die Restgebiet-Anzeige.' }),
    el('div', { class: 'row row-wrap' },
      el('button', { class: 'btn btn-small', onclick: () => openAreaSheet() }, 'Festlegen'),
      s.area ? el('button', { class: 'btn btn-small', onclick: () => { MapMod.fitArea(); goMap(); } }, 'Anzeigen') : null,
      s.area ? el('button', {
        class: 'btn btn-small btn-danger',
        onclick: () => { update((st) => { st.area = null; }, 'Spielgebiet entfernt'); MapMod.render(); render(); },
      }, 'Entfernen') : null,
    ),
  ));

  /* Werkzeuge */
  host.append(el('div', { class: 'card' },
    el('div', { class: 'card-title', text: 'Werkzeuge' }),
    el('div', { class: 'row row-wrap' },
      el('button', { class: 'btn btn-small', onclick: openDiceSheet }, '🎲 Würfel'),
      el('button', { class: 'btn btn-small', onclick: openListsSheet }, '🎴 Listen'),
      el('button', { class: 'btn btn-small', onclick: randomSpot }, '📍 Zufallspunkt'),
      el('button', { class: 'btn btn-small', onclick: openAnalysis }, '📊 Fragen-Analyse'),
    ),
  ));

  /* Offline-Karten */
  const tilesSlot = el('div', {});
  host.append(tilesSlot);
  tileCacheCard().then((card) => { clear(tilesSlot).append(card); });

  /* Teilen */
  host.append(el('div', { class: 'card' },
    el('div', { class: 'card-title', text: 'Spielstand' }),
    el('div', { class: 'row row-wrap' },
      el('button', { class: 'btn btn-small', onclick: openShareSheet }, '📤 Teilen / QR'),
      el('button', { class: 'btn btn-small', onclick: openImportSheet }, '📥 Importieren'),
      el('button', {
        class: 'btn btn-small',
        onclick: async () => {
          try { await navigator.clipboard.writeText(exportText()); toast('Protokoll kopiert', 'ok'); }
          catch (e) { openSheet('Protokoll', (body) => { body.append(el('textarea', { style: { minHeight: '50vh' } }, exportText())); return []; }); }
        },
      }, '📋 Protokoll'),
    ),
  ));

  /* Einstellungen */
  host.append(el('div', { class: 'card' },
    el('div', { class: 'card-title', text: 'Einstellungen' }),
    settingRow('Einheiten', el('div', { class: 'seg' },
      el('button', { class: s.settings.unit === 'metric' ? 'on' : '', onclick: (e) => { setUnit('metric'); segOn(e); } }, 'km'),
      el('button', { class: s.settings.unit === 'imperial' ? 'on' : '', onclick: (e) => { setUnit('imperial'); segOn(e); } }, 'mi'))),
    settingRow('Maskenstärke', rangeInput(s.settings.maskOpacity, 0.2, 0.92, 0.02, (v) => {
      update((st) => { st.settings.maskOpacity = v; });
      MapMod.render();
    })),
    settingRow('Display anlassen', toggle(s.settings.keepAwake, (v) => update((st) => { st.settings.keepAwake = v; }))),
    el('div', { class: 'row row-wrap' },
      el('button', {
        class: 'btn btn-small',
        onclick: () => editDistanceList('Radiusringe', s.settings.radiusRings,
          'Ringe, die im Messmodus um deine Position liegen',
          (list) => update((st) => { st.settings.radiusRings = list; }, 'Radiusringe geändert')),
      }, 'Radiusringe'),
      el('button', {
        class: 'btn btn-small',
        onclick: () => editDistanceList('Radius-Vorgaben', s.presets.radius,
          'Werte für die Schnellauswahl bei Radius-Fragen',
          (list) => update((st) => { st.presets.radius = list; }, 'Radius-Vorgaben geändert')),
      }, 'Radius-Vorgaben'),
      el('button', {
        class: 'btn btn-small',
        onclick: async () => {
          const v = await promptSheet('Eigene Kachelquelle', {
            label: 'URL-Vorlage mit {z}/{x}/{y}, leer = OpenStreetMap',
            value: s.settings.tileUrl,
            placeholder: 'https://…/{z}/{x}/{y}.png',
          });
          update((st) => { st.settings.tileUrl = v || ''; }, 'Kachelquelle geändert');
          MapMod.setTileSource(v || '');
          toast('Kartenquelle gesetzt', 'ok');
        },
      }, 'Kachelquelle'),
      'Notification' in window ? el('button', {
        class: 'btn btn-small',
        onclick: async () => {
          const p = await Notification.requestPermission();
          toast(p === 'granted' ? 'Benachrichtigungen an' : 'Abgelehnt', p === 'granted' ? 'ok' : 'error');
        },
      }, 'Benachrichtigungen') : null,
    ),
  ));

  /* App */
  host.append(el('div', { class: 'card' },
    el('div', { class: 'card-title', text: 'App' }),
    el('div', { class: 'card-sub', id: 'app-version', text: 'Version wird geladen …' }),
    el('div', { class: 'row row-wrap' },
      el('button', {
        class: 'btn btn-small',
        onclick: async () => {
          const reg = await navigator.serviceWorker?.getRegistration();
          if (!reg) return toast('Kein Service Worker aktiv', 'error');
          await reg.update();
          toast('Nach Update gesucht', 'ok');
        },
      }, 'Update suchen'),
      el('button', { class: 'btn btn-small', onclick: openInstallHelp }, 'Installieren'),
      el('button', {
        class: 'btn btn-small btn-danger',
        onclick: async () => {
          if (!(await confirmSheet('Alles zurücksetzen?', 'Fragen, Marker, Timer, Runden und Einstellungen werden gelöscht.', { danger: true, okLabel: 'Zurücksetzen' }))) return;
          replaceState(emptyState());
          MapMod.render();
          document.dispatchEvent(new CustomEvent('jetlag:changed'));
          toast('Zurückgesetzt', 'ok');
        },
      }, 'Zurücksetzen'),
    ),
  ));

  updateVersionLine();
}

function updateVersionLine() {
  const node = document.getElementById('app-version');
  if (!node) return;
  const mode = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone
    ? 'als App installiert' : 'im Browser';
  node.textContent = `${window.__JL_VERSION__ || 'dev'} · ${mode}`;
}

function settingRow(label, control) {
  return el('div', { class: 'row' }, el('span', { class: 'grow', text: label }), el('div', { style: { minWidth: '140px' } }, control));
}

function rangeInput(value, min, max, step, onChange) {
  const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  input.addEventListener('input', () => onChange(parseFloat(input.value)));
  return input;
}

function toggle(value, onChange) {
  return el('div', { class: 'seg' },
    el('button', { class: value ? 'on' : '', onclick: (e) => { onChange(true); segOn(e); } }, 'An'),
    el('button', { class: !value ? 'on' : '', onclick: (e) => { onChange(false); segOn(e); } }, 'Aus'));
}

function segOn(e) {
  const seg = e.target.parentElement;
  seg.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
  e.target.classList.add('on');
}

function setUnit(unit) {
  update((st) => { st.settings.unit = unit; }, null);
  document.dispatchEvent(new CustomEvent('jetlag:changed'));
}

function goMap() { document.querySelector('.tabbar [data-go="map"]').click(); }

function areaLabel(area) {
  if (!area) return 'Nicht gesetzt – ohne Gebiet gibt es keine Restflächen-Angabe.';
  const unit = getState().settings.unit;
  if (area.type === 'circle') return `Kreis, Radius ${formatDistance(area.radius, unit)}`;
  if (area.type === 'bbox') return 'Rechteck aus Kartenausschnitt';
  if (area.type === 'polygon') return `${area.name || 'Polygon'} · ${area.ring.length} Punkte`;
  return 'unbekannt';
}

/* ---------- Spielgebiet festlegen ---------- */

export function openAreaSheet() {
  openSheet('Spielgebiet', (body, close) => {
    let center = Loc.current();
    let radius = 5000;
    const pf = pointField('Mittelpunkt', center, (p) => { center = p; });
    const rf = distanceField('Radius', radius, (m) => { radius = m; },
      [1000, 2000, 3000, 5000, 7500, 10000, 15000, 25000, 50000]);

    body.append(
      el('div', { class: 'card' },
        el('div', { class: 'card-title', text: 'Kreis' }),
        pf.node,
        rf.node,
        el('button', {
          class: 'btn btn-small btn-primary',
          onclick: () => {
            if (!center) return toast('Mittelpunkt fehlt', 'error');
            setArea({ type: 'circle', center: { lat: center.lat, lng: center.lng }, radius });
            close();
          },
        }, 'Als Spielgebiet setzen')),
      el('div', { class: 'card' },
        el('div', { class: 'card-title', text: 'Aus Kartenausschnitt' }),
        el('div', { class: 'hint', text: 'Nimmt das Rechteck, das gerade auf der Karte zu sehen ist.' }),
        el('button', {
          class: 'btn btn-small',
          onclick: () => {
            const b = MapMod.getMap().getBounds();
            setArea({ type: 'bbox', bounds: { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() } });
            close();
          },
        }, 'Ausschnitt übernehmen')),
      el('div', { class: 'card' },
        el('div', { class: 'card-title', text: 'Freie Form' }),
        el('div', { class: 'row row-wrap' },
          el('button', {
            class: 'btn btn-small',
            onclick: async () => {
              close();
              const ring = await drawPolygon();
              if (ring && ring.length >= 3) setArea({ type: 'polygon', ring, name: 'Gezeichnet' });
            },
          }, '✏️ Zeichnen'),
          el('button', {
            class: 'btn btn-small',
            onclick: () => {
              close();
              areaPickerSheet(Loc.current(), (a) => setArea({ type: 'polygon', ring: a.ring, name: a.name }));
            },
          }, '🗺 Ort / Gebiet'))),
    );
    return [el('button', { class: 'btn grow', onclick: () => close() }, 'Schließen')];
  });
}

function setArea(area) {
  update((s) => { s.area = area; }, 'Spielgebiet gesetzt');
  MapMod.render();
  MapMod.fitArea();
  render();
  goMap();
}

/* ---------- Werkzeuge ---------- */

function randomSpot() {
  const s = getState();
  if (!s.area) return toast('Erst ein Spielgebiet festlegen', 'error');
  const p = C.randomAllowedPoint(s.area, s.constraints.filter((c) => c.active !== false));
  if (!p) return toast('Kein Punkt erfüllt alle Antworten', 'error');
  MapMod.addMarkerAt(p, 'Zufallspunkt', 'aus dem Restgebiet gezogen', '#34d399');
  MapMod.flyTo(p, 14);
  goMap();
  toast('Punkt im Restgebiet gesetzt', 'ok');
}

function openAnalysis() {
  const s = getState();
  if (!s.area) return toast('Erst ein Spielgebiet festlegen', 'error');
  const center = Loc.current();
  if (!center) return toast('Standort nötig', 'error');
  openSheet('Welche Frage bringt am meisten?', (body, close) => {
    body.append(el('div', { class: 'hint', text: 'Angenommen, du fragst nach einem Radius um deinen Standort: So teilt sich das Restgebiet auf.' }));
    const rows = C.analyzeRadius(s.area, s.constraints.filter((c) => c.active !== false), center, s.presets.radius);
    if (!rows.length) {
      body.append(el('div', { class: 'empty', text: 'Kein Restgebiet mehr übrig.' }));
      return [el('button', { class: 'btn grow', onclick: () => close() }, 'Schließen')];
    }
    for (const r of [...rows].sort((a, b) => b.balance - a.balance)) {
      const pct = (r.insideFraction * 100).toFixed(0);
      body.append(el('div', { class: 'card' },
        el('div', { class: 'card-title' },
          el('span', { class: 'grow', text: formatDistance(r.radius, s.settings.unit) }),
          el('span', { class: 'card-sub', text: `${pct} % / ${100 - pct} %` })),
        el('div', { class: 'progress' }, el('i', { style: { width: `${pct}%` } })),
        el('div', { class: 'card-sub', text: r.balance > 0.7 ? 'teilt gut' : r.balance > 0.3 ? 'brauchbar' : 'bringt wenig' })));
    }
    return [el('button', { class: 'btn grow', onclick: () => close() }, 'Schließen')];
  });
}

/* ---------- Installationshilfe ---------- */

export function openInstallHelp() {
  const prompt = window.__JL_INSTALL_PROMPT__;
  openSheet('Als App installieren', (body, close) => {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    body.append(
      el('div', { class: 'card' },
        el('div', { class: 'card-title', text: ios ? 'iPhone / iPad' : 'Android' }),
        ios
          ? el('div', { class: 'card-sub', html: 'In <b>Safari</b> öffnen → Teilen-Symbol → „Zum Home-Bildschirm" → Hinzufügen. Die App startet dann im Vollbild ohne Browserleiste.' })
          : el('div', { class: 'card-sub', html: 'In <b>Chrome</b> → Menü ⋮ → „App installieren" bzw. „Zum Startbildschirm hinzufügen".' })),
      el('div', { class: 'hint', text: 'Standort und Offline-Betrieb brauchen HTTPS – über die veröffentlichte Adresse öffnen, nicht als lokale Datei.' }),
    );
    return prompt ? [el('button', {
      class: 'btn grow btn-primary',
      onclick: async () => { close(); prompt.prompt(); },
    }, 'Jetzt installieren')] : [el('button', { class: 'btn grow', onclick: () => close() }, 'Verstanden')];
  });
}

// Abstandslisten (Radius-Vorgaben, Radiusringe) in der eingestellten Einheit bearbeiten.
async function editDistanceList(title, current, hint, save) {
  const factor = getState().settings.unit === 'imperial' ? 1609.344 : 1000;
  const v = await promptSheet(title, {
    label: `${hint} – in ${unitSuffix()}, durch Komma getrennt`,
    value: current.map((m) => String(+(m / factor).toFixed(3)).replace('.', ',')).join(', '),
  });
  if (v == null) return;
  const list = v.split(',')
    .map((x) => parseFloat(x.replace(',', '.')) * factor)
    .filter((x) => isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  if (!list.length) { toast('Keine gültigen Werte', 'error'); return; }
  save(list);
  render();
  toast(`${list.length} Werte gespeichert`, 'ok');
}

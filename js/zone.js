// Versteckzone und Versteckpunkt.
//
// Was das Regelwerk dazu festlegen kann (Block "hidingZone"):
//   anchorCategory   welche Art Haltestelle als Mittelpunkt gilt (z. B. "bus")
//   anchorChoices    wie viele der nächstgelegenen zur Wahl stehen
//   anchorToleranceM wie weit der Mittelpunkt vom Schild abweichen darf
//   lockAt           ab welcher Rundenphase die Zone nicht mehr verschoben werden darf
// Der Radius hängt an der Spielgröße.

import { getState, update } from './state.js';
import * as Rules from './rules.js';
import * as MapMod from './map.js';
import * as Loc from './location.js';
import { findPois } from './overpass.js';
import { poiCategory } from './sources.js';
import { activeRound, phaseTime, PHASE_LABEL } from './phases.js';
import { formatDistance } from './geo.js';
import { el, openSheet, confirmSheet, toast } from './ui/ui.js';

export function areaHectares(radiusM) {
  return (Math.PI * radiusM * radiusM) / 10000;
}

export function formatHectares(radiusM) {
  const ha = areaHectares(radiusM);
  return `${ha < 10 ? ha.toFixed(1).replace('.', ',') : Math.round(ha)} ha`;
}

export function zoneSummary(radiusM = Rules.hidingZoneRadius()) {
  if (!radiusM) return '';
  return `${formatDistance(radiusM, getState().settings.unit)} Radius · ${formatHectares(radiusM)}`;
}

// Ist die Zone gesperrt? Gibt die Phase zurück, ab der sie es ist.
export function zoneLockedSince() {
  const lockAt = Rules.hidingZoneRules().lockAt;
  if (!lockAt) return null;
  const t = phaseTime(activeRound(), lockAt);
  return t ? { phase: lockAt, at: t } : null;
}

export async function setHidingZone(p, name = 'Versteckzone') {
  const radius = Rules.hidingZoneRadius();
  if (!radius) { toast('Kein Regelwerk geladen', 'error'); return false; }

  const lock = zoneLockedSince();
  if (lock && getState().hidingZone) {
    const ok = await confirmSheet('Versteckzone ist festgelegt',
      `Laut Regelwerk darf die Zone ab „${PHASE_LABEL[lock.phase]}" nicht mehr verschoben werden. Trotzdem ändern?`,
      { danger: true, okLabel: 'Trotzdem ändern' });
    if (!ok) return false;
  }

  const tol = Rules.hidingZoneRules().anchorToleranceM;
  update((s) => {
    s.hidingZone = { lat: p.lat, lng: p.lng, radius, name, toleranceM: tol ?? null, at: Date.now() };
  }, 'Versteckzone gesetzt');
  MapMod.render();
  toast(`Versteckzone ${name}: ${zoneSummary(radius)}`, 'ok');
  return true;
}

// Mittelpunkt aus den nächstgelegenen Haltestellen der im Regelwerk genannten Art wählen.
export async function openAnchorPicker() {
  const hz = Rules.hidingZoneRules();
  const me = Loc.current();
  if (!me) return toast('Erst eine Position – GPS oder Punkt auf der Karte', 'error');
  const catId = hz.anchorCategory || 'station';
  const cat = poiCategory(catId);
  const anzahl = hz.anchorChoices || 3;
  const unit = getState().settings.unit;

  openSheet(`Versteckzone an ${cat ? cat.label : 'Haltestelle'}`, (body, close) => {
    const out = el('div', {}, el('div', { class: 'hint', text: 'Suche die nächstgelegenen …' }));
    body.append(
      hz.rules && hz.rules.length ? el('div', { class: 'hint', text: hz.rules[0] }) : null,
      hz.anchorToleranceM != null
        ? el('div', { class: 'card-sub', text: `Als Mittelpunkt gilt das Schild, ±${formatDistance(hz.anchorToleranceM, unit)}.` })
        : null,
      out,
    );
    (async () => {
      try {
        let found = [];
        for (const r of [300, 1000, 3000, 10000]) {
          found = await findPois(me, catId, r);
          if (found.length >= anzahl) break;
        }
        out.textContent = '';
        if (!found.length) { out.append(el('div', { class: 'empty', text: 'Keine gefunden.' })); return; }
        out.append(el('div', { class: 'hint', text: `Die ${Math.min(anzahl, found.length)} nächstgelegenen:` }));
        for (const p of found.slice(0, anzahl)) {
          out.append(el('button', {
            class: 'card', style: { textAlign: 'left' },
            onclick: async () => { close(); await setHidingZone(p, p.name); },
          },
            el('div', { class: 'card-title', text: p.name }),
            el('div', { class: 'card-sub', text: `${formatDistance(p.distance, unit)} entfernt` })));
        }
      } catch (e) {
        out.textContent = String(e.message || e);
      }
    })();
    return [el('button', { class: 'btn grow', onclick: () => close() }, 'Abbrechen')];
  });
}

// Versteckpunkt: für Endgame-Regeln wie "Antworten nur innerhalb von 2 m".
export function setHidingSpot(p) {
  update((s) => { s.hidingSpot = { lat: p.lat, lng: p.lng, at: Date.now() }; }, 'Versteckpunkt gesetzt');
  MapMod.render();
  toast('Versteckpunkt gesetzt', 'ok');
}

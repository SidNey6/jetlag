// Rundenphasen: Rundenstart → Versteckzeit vorbei → Suche → Endgame → gefunden.
// Fristen, Sperren und Endgame-Regeln im Regelwerk verweisen auf diese Namen.

import { getState } from './state.js';

export const PHASES = ['roundStart', 'hidingEnd', 'searchStart', 'endgame', 'found'];

export const PHASE_LABEL = {
  roundStart: 'Rundenstart',
  hidingEnd: 'Ende der Versteckzeit',
  searchStart: 'Beginn der Suche',
  endgame: 'Endgame',
  found: 'Gefunden',
};

export function activeRound() {
  return getState().game.rounds.find((r) => !r.endedAt) || null;
}

// Zeitpunkt einer Phase in einer Runde, oder null, solange sie nicht erreicht ist.
// Versteckzeit-Ende und Suchbeginn fallen meist zusammen; fehlt eins, gilt das andere.
export function phaseTime(r, phase) {
  if (!r) return null;
  switch (phase) {
    case 'roundStart': return r.startedAt || null;
    case 'hidingEnd': return r.hidingEndAt || r.searchStartAt || null;
    case 'searchStart': return r.searchStartAt || r.hidingEndAt || null;
    case 'endgame': return r.endgameAt || null;
    case 'found': return r.endedAt || null;
    default: return null;
  }
}

export function currentPhase(r) {
  if (!r) return null;
  if (r.endedAt) return 'found';
  if (r.endgameAt) return 'endgame';
  if (r.searchStartAt || r.hidingEndAt) return 'searchStart';
  return 'roundStart';
}

export function netDuration(r, now = Date.now()) {
  return Math.max(0, ((r.endedAt || now) - r.startedAt) - (r.deductionMs || 0));
}

// Stand aller Fristen einer Runde. "erreicht": Zielphase lag vor Fristende.
export function deadlineStatus(r, deadlines, now = Date.now()) {
  return (deadlines || []).map((d) => {
    const from = phaseTime(r, d.from || 'roundStart');
    const ziel = phaseTime(r, d.until);
    const faellig = from ? from + d.afterMinutes * 60000 : null;
    return {
      d,
      from,
      faellig,
      erreicht: !!ziel && (!faellig || ziel <= faellig),
      ausgeloest: !!(r && r.fired && r.fired[d.id]),
      rest: faellig ? faellig - now : null,
    };
  });
}

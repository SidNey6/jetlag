// Bildschirm wach halten, solange mindestens ein Grund besteht: laufender Timer,
// Endgame-Aufzeichnung, Taschenmodus. Der Browser gibt die Sperre beim Wechsel in den
// Hintergrund selbst frei; beim Zurückkehren wird sie neu angefordert.

import { getState } from './state.js';

const reasons = new Set();
let lock = null;
let pending = false;

export function wantAwake(reason, on) {
  if (on) reasons.add(reason); else reasons.delete(reason);
  refresh();
}

export function isAwake() {
  return !!lock;
}

async function refresh() {
  const wants = reasons.size > 0 && getState().settings.keepAwake !== false
    && document.visibilityState === 'visible';
  if (wants && !lock && !pending && 'wakeLock' in navigator) {
    pending = true;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } catch (e) {
      lock = null;
    } finally {
      pending = false;
    }
  } else if (!wants && lock) {
    try { await lock.release(); } catch (e) { /* egal */ }
    lock = null;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', refresh);
}

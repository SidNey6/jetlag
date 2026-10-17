// Läuft die App in der Android-Hülle (native/)? Dann gibt es zwei Unterschiede zur
// Website: Die Endgame-Spur zeichnet ein Android-Dienst auf (auch bei gesperrtem
// Bildschirm oder geschlossener App), und Regionsdaten und Karte kommen von der Website,
// weil die App selbst nur die Programmdateien mitbringt.

const cap = typeof window !== 'undefined' ? window.Capacitor : null;

export const NATIVE = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());

export const SITE = 'https://sidney6.github.io/jetlag/';
export const APK_URL = 'https://github.com/SidNey6/jetlag/releases/latest/download/jetlag-toolkit.apk';

let tracker = null;

// Aufzeichnungsdienst (native/android/…/TrackerPlugin.java)
export function nativeTracker() {
  if (!NATIVE) return null;
  if (!tracker) tracker = cap.registerPlugin('JetlagTracker');
  return tracker;
}

// Gibt es auf der Website eine neuere Fassung? Dann liegt dort auch eine neue APK.
export async function newerVersion(current) {
  if (!NATIVE) return null;
  try {
    const res = await fetch(`${SITE}version.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    const { version } = await res.json();
    return compareVersions(version, current) > 0 ? version : null;
  } catch (e) {
    return null;
  }
}

export function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map(Number);
  const pb = String(b || '').replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

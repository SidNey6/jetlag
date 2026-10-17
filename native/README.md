# Android-App

Die Android-App ist die Website in einer nativen Hülle ([Capacitor](https://capacitorjs.com)).
Der Unterschied liegt in der **Endgame-Aufzeichnung**: Ein Android-Vordergrunddienst
(`TrackerService.java`) schreibt jeden GPS-Punkt direkt in eine Datei auf dem Gerät. Er
läuft weiter, wenn der Bildschirm aus ist, eine andere App vorne liegt oder die App aus der
Übersicht gewischt wird. Beim Zurückkehren holt die App alle Punkte nach (`js/location.js`).
Eine Website kann das nicht: Browser orten nur, solange die Seite sichtbar ist.

Die App bringt nur die Programmdateien mit. Regionsdaten, Höhen und Karte lädt sie wie die
Website von GitHub Pages (`js/native.js`).

## Installieren

Die signierte APK hängt an jedem [Release](https://github.com/SidNey6/jetlag/releases) und
wird ab dem ersten hinterlegten Signaturschlüssel von GitHub Actions gebaut (Job `android`
in `.github/workflows/pages.yml`, eine Release je App-Version). Auf dem Handy:

1. `jetlag-toolkit.apk` herunterladen und öffnen, einmalig „Installation aus unbekannten
   Quellen“ für den Browser erlauben.
2. Beim ersten Endgame Standort („Genau“, „Während der Nutzung“) und Benachrichtigungen
   erlauben.
3. Im Endgame-Menü **Akku-Optimierung** antippen und „Zulassen“ wählen – sonst beenden
   manche Hersteller (Samsung, Xiaomi, Huawei …) den Dienst trotz Benachrichtigung.

Neue Versionen meldet die App selbst (Abgleich mit `version.json` der Website) und lassen
sich über die installierte legen; der Spielstand bleibt.

## Selbst bauen

Voraussetzungen: Node, JDK 21, Android SDK (Plattform 36). Auf dem Mac z. B.:

```bash
brew install openjdk@21 && brew install --cask android-commandlinetools
```

```bash
cd native
npm ci
npm run apk        # signierte Release-APK (Schlüssel siehe unten)
npm run apk:debug  # Debug-APK, Web-Ansicht über chrome://inspect erreichbar
```

`scripts/sync-web.mjs` kopiert die Website nach `www/`, hängt die Capacitor-Brücke ein und
übernimmt die Versionsnummer aus `js/main.js`.

## Signaturschlüssel

Android installiert ein Update nur, wenn es mit demselben Schlüssel signiert ist wie die
installierte App. Der Schlüssel liegt deshalb **nicht** im Repo:

- lokal: `~/.jetlag/jetlag-release.jks` und `~/.jetlag/keystore.properties`
- in GitHub Actions: Secrets `JETLAG_KEYSTORE_B64` (Schlüsseldatei als Base64) und
  `JETLAG_STORE_PASSWORD`

Geht der Schlüssel verloren, muss die App einmal deinstalliert und neu installiert werden –
dabei geht der Spielstand auf dem Handy verloren. Also sicher aufbewahren.

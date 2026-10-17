# Jetlag Toolkit

Web-App für Verstecken-und-Suchen-Spiele nach dem Vorbild von *Jet Lag: Hide and Seek*.
Läuft im Browser, lässt sich auf dem Handy installieren und braucht weder Server noch Konto.

**https://sidney6.github.io/jetlag/**

Jede beantwortete Frage schränkt das Gebiet ein, in dem sich die versteckende Person noch
aufhalten kann. Alles andere wird auf der Karte abgedunkelt, und die App zeigt, wie viel vom
Spielgebiet übrig ist.

## Funktionen

- Karte mit eigenem Standort, Messwerkzeug, Markern und Spielgebiet (Kreis, Ausschnitt,
  Polygon oder Verwaltungsgrenze)
- Fragen, die Fläche ausschließen:

  | Typ | Beispiel |
  |---|---|
  | Radius | Bist du im Umkreis von 1 km? |
  | Thermometer | Bin ich wärmer oder kälter geworden? |
  | Vergleich | Bist du näher an einer Autobahn als ich? |
  | Nächster Ort | Ist dein nächstes Museum dasselbe wie meins? |
  | Gebiet | Bist du im selben Stadtteil? |
  | Flussseite | Bist du auf derselben Seite des Flusses? |
  | Richtung | Liegst du nordöstlich von mir? |
  | Höhe | Bist du näher am Meeresspiegel als ich? |

- Orte und Geometrien (Haltestellen, Linien, Flüsse, Straßen, Grenzen …) kommen aus
  OpenStreetMap
- Endgame: Radius um die erkannte Haltestelle, abgelaufene Straßen werden aufgezeichnet und
  markiert, mit Fortschritt in Prozent
- Timer, Runden, Wertung, Protokoll, Würfel und eigene Kartenlisten
- Spielgebiet vorab laden und offline spielen
- Spielstand per Link oder QR-Code auf andere Handys übertragen

## Installieren

- **iPhone:** in Safari öffnen, Teilen, „Zum Home-Bildschirm“
- **Android:** in Chrome öffnen, Menü, „App installieren“, oder die Android-App (siehe unten)

Standort und Offline-Betrieb funktionieren nur über HTTPS bzw. `localhost`.

### Android-App

Browser orten nur, solange die Seite sichtbar ist. Die Android-App ist derselbe Code in einer
[Capacitor](https://capacitorjs.com)-Hülle und zeichnet das Endgame auch bei gesperrtem
Bildschirm auf. Die APK liegt unter
[Releases](https://github.com/SidNey6/jetlag/releases), Details in
[native/README.md](native/README.md).

## Regelwerk

Die Regeln stehen in `rules/lifack.json`, nicht im Code. Mitgeliefert sind die Werte von
[lifack.ch](https://www.lifack.ch/docs/quick_start_guide/), einer inoffiziellen
Fan-Umsetzung (nicht verbunden mit Jet Lag, Nebula oder Wendover Productions). Meilen sind
in runde metrische Werte umgerechnet. Ergänzt sind Matching-Fragen zu Flussseite, Autobahn
und Landstraße.

Eigene Regelwerke lassen sich unter *Mehr → Regelwerk* bearbeiten, laden und exportieren.
Das Format ist in [rules/SCHEMA.md](rules/SCHEMA.md) beschrieben, die App prüft jede Datei
vor dem Übernehmen.

## Vorgebaute Regionen

Für einige Städte samt Umland baut GitHub Actions einmal im Monat einen OpenStreetMap-Auszug,
ein Höhenraster und eine Vektorkarte: Berlin, Bonn, Dortmund, Düsseldorf, Frankfurt am Main,
Freiburg, Hamburg, Heidelberg/Mannheim, Karlsruhe, Köln, Leipzig, München, Münster und
Stuttgart. Die Rahmen stehen in `scripts/region/regions.mjs`. Innerhalb einer Region braucht die
App dann weder Overpass noch Online-Höhendienst noch Kachelserver, und das Vorbereiten dauert
Sekunden. Außerhalb läuft alles wie gewohnt online.

Neue Regionen brauchen nur einen Eintrag dort. `coverage.mjs` prüft, ob die angegebenen
Geofabrik-Auszüge den Rahmen ganz abdecken.

```bash
node scripts/region/coverage.mjs
node scripts/region/build.mjs <region> --pbf <auszug.osm.pbf>
node scripts/region/elevation.mjs <region>
node scripts/region/basemap.mjs <region>
```

## Entwicklung

Kein Build-Schritt, das Repo wird so ausgeliefert, wie es ist.

```bash
node scripts/dev-server.mjs 8099   # http://localhost:8099
node --test test/*.test.mjs
./scripts/check.sh                 # Syntax und Versionsnummern
```

Bei Änderungen die Version in `js/main.js`, `sw.js` und `version.json` erhöhen, sonst
bekommen installierte Geräte das Update nicht. Eine neue Version erzeugt außerdem
automatisch ein Release mit neuer APK.

| Ordner | Inhalt |
|---|---|
| `js/` | App (ES-Module, Leaflet) |
| `rules/` | Regelwerk und Formatbeschreibung |
| `scripts/region/` | Bau der Regionsdaten, Höhen und Karte |
| `native/` | Android-App |
| `test/` | Tests (`node --test`) |
| `vendor/` | Fremdbibliotheken mit Lizenztexten |

## Daten und Lizenzen

- Karten- und Ortsdaten © OpenStreetMap-Mitwirkende (ODbL), Auszüge von
  [Geofabrik](https://download.geofabrik.de), Vektorkarte von [Protomaps](https://protomaps.com)
- Höhen: [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (u. a. SRTM und
  EU-DEM, Copernicus), außerhalb der Regionen über [Open-Meteo](https://open-meteo.com)
- [Leaflet](https://leafletjs.com) (BSD-2-Clause),
  [protomaps-leaflet](https://github.com/protomaps/protomaps-leaflet) (BSD-3-Clause),
  [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT),
  [Lucide](https://lucide.dev) (ISC), [Capacitor](https://capacitorjs.com) (MIT)

Spielstände bleiben auf dem Gerät. Geteilt wird nur, was man selbst per Link oder QR-Code
weitergibt.

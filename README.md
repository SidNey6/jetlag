# Jetlag Toolkit

Ein Werkzeugkasten für Verstecken-und-Suchen-Spiele im Jetlag-Stil, als installierbare
Web-App (PWA). Kein Server, kein Konto, keine fest einprogrammierten Regeln – die
Spielmechanik bringt ihr mit, die App übernimmt die Geometrie, die Zeit und das Protokoll.

**Das Kernstück:** Jede beantwortete Frage dunkelt auf der Karte sofort alles ab, was
nicht mehr in Frage kommt. Nach vier, fünf Fragen sieht man auf einen Blick, wo noch
gesucht werden muss – und wie viel Prozent des Spielgebiets übrig sind.

## Funktionen

**Karte**
- Live-Standort mit Genauigkeitskreis, Folgemodus, Position einfrieren oder manuell setzen
- Spielgebiet als Kreis, Kartenausschnitt, gezeichnetes Polygon oder echte Verwaltungsgrenze
- Distanz und Peilung zwischen zwei Punkten, Radiusringe um die eigene Position
- Marker mit Notizen, langes Tippen öffnet das Punktmenü

**Fragen** – jede erzeugt eine ausgeschlossene Fläche:

| Typ | Frage | Was wegfällt |
|---|---|---|
| Radius | „Bist du im Umkreis von X?" | außerhalb bzw. innerhalb des Kreises |
| Thermometer | „Bin ich wärmer oder kälter?" | die Halbebene jenseits der Mittelsenkrechten |
| Vergleich | „Bist du näher an X als ich?" | Kreis um X mit dem eigenen Abstand als Radius |
| Nächster Ort | „Welchem Ort bist du am nächsten?" | die Umgebung aller anderen Orte |
| Gebiet | „Bist du in diesem Dorf/Bezirk?" | Innen- oder Außenfläche |
| Richtung | „Liegst du im Sektor NO?" | der Sektor oder sein Rest |

Fragen lassen sich einzeln abschalten, bearbeiten und rückgängig machen.

Die Gebietssuche listet, was im gewählten Umkreis liegt – sortiert nach Verwendbarkeit:
erst Orte, Ortsteile und Viertel mit Umriss, dann ganze Gemeinden, dann Orte, die in
OpenStreetMap nur als Punkt stehen (die werden auf Wunsch zu einem Kreis), zuletzt Kreis
und Bundesland. Ein Namensfilter ist dabei, und das Gebiet, in dem man gerade steht, ist
mit „hier" markiert.

Die Voreinstellungen sind auf **kleine Spielflächen** ausgelegt – Stadt und Umland, etwa im
Umkreis von Bonn: Radius-Vorgaben ab 250 m, Spielgebiet ab 1 km, Ortssuche ab 300 m.
Beides ist unter *Mehr → Einstellungen* frei änderbar (Radius-Vorgaben, Radiusringe).

**Weiteres**
- Beliebig viele Timer (Countdown und Stoppuhr), Alarm mit Ton und Vibration, Display bleibt an
- Teams, Runden mit Zeitmessung, Wertung und automatisches Protokoll
- Würfel W2–W20 und eigene Listen für Karten, Flüche oder Aufgaben
- OpenStreetMap-Abfragen: Orte im Umkreis, nächstgelegenes Objekt, sowie eine Gebietssuche
  über Dörfer, Ortsteile, Stadtviertel und Gemeinden im Umkreis (nicht nur am eigenen Standort)
- Kartenkacheln offline speichern
- Spielstand per QR-Code oder Link zwischen Handys teilen
- „Zufallspunkt im Restgebiet" und eine Analyse, welche Radiusfrage das Gebiet am besten halbiert

## Auf dem Handy installieren

**iPhone/iPad:** Seite in **Safari** öffnen → Teilen-Symbol → „Zum Home-Bildschirm".
**Android:** in **Chrome** öffnen → Menü ⋮ → „App installieren".

Wichtig: Standort, Offline-Betrieb und Installation brauchen **HTTPS**. Über die
veröffentlichte Adresse öffnen – eine lokal geöffnete Datei oder ein `http://`-Server
im WLAN reicht dafür nicht.

## Veröffentlichen (GitHub Pages)

1. Auf github.com ein leeres Repository anlegen, zum Beispiel `jetlag`.
2. Im Projektordner:

```bash
git add -A && git commit -m "Jetlag Toolkit" && git branch -M main
```

3. Fernverbindung setzen und hochladen (eigenen Benutzernamen einsetzen):

```bash
git remote add origin https://github.com/DEIN-NAME/jetlag.git && git push -u origin main
```

4. Im Repository: **Settings → Pages → Source: GitHub Actions**.

Danach baut und veröffentlicht jeder Push automatisch
(`.github/workflows/pages.yml` prüft vorher Syntax und Tests).
Die Adresse lautet `https://DEIN-NAME.github.io/jetlag/`.

## Entwicklung

```bash
node scripts/dev-server.mjs 8099
```

Dann `http://localhost:8099` öffnen – `localhost` gilt als sicherer Kontext, also
funktionieren dort auch Standort und Service Worker.

```bash
node --test test/*.test.mjs   # Geodäsie, Fragetypen, Restflächen-Schätzung, Kachelmathematik
./scripts/check.sh     # Syntaxprüfung aller Module
node scripts/make-icons.mjs  # Icons neu erzeugen
```

Kein Build-Schritt: Was im Repository liegt, wird genau so ausgeliefert.
Nach Änderungen an den Dateien die Versionsnummer in `sw.js` (`VERSION`) erhöhen,
damit installierte Geräte das Update ziehen.

### Aufbau

```
index.html          App-Shell mit fünf Tabs
sw.js               Service Worker: App offline, Kacheln aus dem Cache
js/geo.js           Geodäsie (Distanz, Peilung, Mittelsenkrechte, Vereinfachung)
js/constraints.js   Fragetypen: Prüffunktion, Zeichengeometrie, Restflächen-Statistik
js/mask.js          Canvas-Overlay, das die ausgeschlossenen Flächen vereinigt
js/map.js           Leaflet, Marker, Messwerkzeug, Punktauswahl
js/questions.js     Dialoge zum Anlegen und Verwalten der Fragen
js/overpass.js      OpenStreetMap-Abfragen samt Grenz-Zusammensetzung
js/timers.js        Timer-Engine auf Zeitstempelbasis
js/rounds.js        Teams, Runden, Wertung, Protokoll
js/share.js         Export/Import über gepackte Links und QR-Codes
js/tiles.js         Offline-Kachelcache
js/state.js         Zustand, Persistenz, Undo
```

Zwei Entscheidungen, die den Rest erklären:

- **Keine Geometriebibliothek.** Die Maske entsteht durch Übereinanderzeichnen auf einem
  Canvas (`mask.js`), nicht durch boolesche Polygonoperationen. Statistik und Zufallspunkte
  laufen stattdessen analytisch über `allows()` – unabhängig von Zoom und Bildausschnitt.
- **Alles in lokalen Metern gerechnet.** Kreise und Mittelsenkrechten werden geodätisch
  bestimmt und als Punktfolge zurückprojiziert. Eine im Bildschirmraum gerade gezogene
  Trennlinie läge auf Stadtmaßstab bereits sichtbar falsch.

## Hinweise

- Kartendaten © OpenStreetMap-Mitwirkende. Der Kachel-Download ist bewusst auf 2000 Kacheln
  pro Vorgang gedeckelt und gedrosselt – die OSM-Server sind gespendete Infrastruktur.
  Für größere Gebiete unter *Mehr → Einstellungen → Kachelquelle* eine eigene Quelle eintragen.
- Alle Daten bleiben auf dem Gerät (localStorage und Cache Storage). Geteilt wird nur,
  was ihr aktiv per Link oder QR weitergebt.
- Enthaltene Fremdsoftware: [Leaflet](https://leafletjs.com) (BSD-2-Clause) und
  [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT),
  jeweils unter `vendor/` mit Lizenztext.

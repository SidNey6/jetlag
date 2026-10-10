# Jetlag Toolkit

**Live: https://sidney6.github.io/jetlag/**

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

**Regelwerk** – mitgeliefert ist das Hide-and-Seek-Regelwerk von
[lifack.ch](https://www.lifack.ch/docs/quick_start_guide/), komplett als bearbeitbare
JSON-Datei (`rules/lifack.json`). Es liefert Spielgrößen, Fristen und die sechs
Fragekategorien mit allen zulässigen Werten. Mehr dazu weiter unten.

**Fragen** – jede erzeugt eine ausgeschlossene Fläche:

| Typ | Frage | Was wegfällt |
|---|---|---|
| Radius | „Bist du im Umkreis von X?" | außerhalb bzw. innerhalb des Kreises |
| Thermometer | „Bin ich wärmer oder kälter?" | die Halbebene jenseits der Mittelsenkrechten |
| Vergleich | „Bist du näher an X als ich?" | alles außerhalb (bzw. innerhalb) eines Korridors im eigenen Abstand um X |
| Nächster Ort | „Welchem Ort bist du am nächsten?" | die Umgebung aller anderen Orte |
| Nächster Ort (verneint) | „Nein, mein nächstes X ist ein anderes" | genau die Umgebung des genannten Orts |
| Gebiet | „Bist du in diesem Dorf/Bezirk?" | Innen- oder Außenfläche |
| Flussseite | „Bist du auf derselben Seite des Rheins wie ich?" | das andere Ufer bzw. das eigene |
| Richtung | „Liegst du im Sektor NO?" | der Sektor oder sein Rest |
| Höhe | „Bist du näher am Meeresspiegel als ich?" | alles, was höher bzw. tiefer liegt |

Für die **Flussseite** lädt die App den nächsten Fluss aus OpenStreetMap und bestimmt die
Seiten aus der Fließrichtung – Flüsse sind dort immer flussabwärts gezeichnet. Das stimmt
auch hinter Mäandern und Kurven; einzugeben ist nur die Antwort.

Fragen lassen sich einzeln abschalten, bearbeiten und rückgängig machen.

Die Gebietssuche listet, was im gewählten Umkreis liegt – sortiert nach Verwendbarkeit:
erst Orte, Ortsteile und Viertel mit Umriss, dann ganze Gemeinden, dann Orte, die in
OpenStreetMap nur als Punkt stehen (die werden auf Wunsch zu einem Kreis), zuletzt Kreis
und Bundesland. Ein Namensfilter ist dabei, und das Gebiet, in dem man gerade steht, ist
mit „hier" markiert.

Die Voreinstellungen sind auf **kleine Spielflächen** ausgelegt – Stadt und Umland, etwa im
Umkreis von Bonn: Radius-Vorgaben ab 250 m, Spielgebiet ab 1 km, Ortssuche ab 300 m.
Beides ist unter *Mehr → Einstellungen* frei änderbar (Radius-Vorgaben, Radiusringe).

**Endgame** – erkannt, an welcher Station sich die versteckende Seite aufhält? Lange auf
die Haltestelle auf der Karte drücken → *Endgame an …*. Die App legt den Radius aus dem
Regelwerk um die Haltestelle, dunkelt alles außerhalb ab und lädt alle Straßen und Wege im
Radius. Ab dann wird jeder Weg aufgezeichnet, wie bei Strava: abgelaufene Straßen werden
orange, offene bleiben grau, oben steht, wie viel Prozent schon abgesucht sind. So lässt
sich die Zone systematisch abgehen, ohne Straßen doppelt oder gar nicht zu laufen.

Bei ausgeschaltetem Bildschirm ortet kein Browser – das ist eine Grenze von Web-Apps auf
iOS wie Android. Drei Auswege:
- **Taschenmodus:** Der Bildschirm bleibt an, zeigt aber nur Schwarz (auf OLED-Displays
  kostet das kaum Strom). Berührungen in der Hosentasche werden abgefangen; entsperrt wird
  durch langes Drücken.
- **Lücken schließen:** Kommt nach einer Pause ein Punkt weit entfernt an, nimmt die App
  den kürzesten Weg über das Straßennetz an und markiert ihn gestrichelt als „vermutlich".
- **GPX-Import:** Eine Tracking-App, die im Hintergrund aufzeichnen darf, liefert die
  lückenlose Spur; sie lässt sich als GPX übernehmen. So lassen sich auch die Wege
  von Mitspielern zusammenführen.

**Weiteres**
- Beliebig viele Timer (Countdown und Stoppuhr), Zeit abziehen, hinzufügen oder direkt
  setzen, Alarm mit Ton und Vibration, Display bleibt an
- Teams, Runden mit Zeitmessung, Wertung und automatisches Protokoll
- Würfel W2–W20 und eigene Listen für Karten, Flüche oder Aufgaben
- OpenStreetMap-Abfragen: Orte im Umkreis, nächstgelegenes Objekt, sowie eine Gebietssuche
  über Dörfer, Ortsteile, Stadtviertel und Gemeinden im Umkreis (nicht nur am eigenen Standort)
- **Spielgebiet vorbereiten**: Orte, Grenzen, Bezugsgeometrien und Kartenkacheln einmal
  herunterladen, danach läuft die ganze Runde ohne Netz
- Spielstand per QR-Code oder Link zwischen Handys teilen
- „Zufallspunkt im Restgebiet" und eine Analyse, welche Radiusfrage das Gebiet am besten halbiert

## Vorgebaute Regionsdaten: Bonn und Umgebung

Für **Bonn und Umgebung** – von Siegburg und Hennef über Wachtberg und Oberwinter bis
Alfter, Bornheim und Rheinbach – fragt die App nicht Overpass, sondern liest einen fertigen
OpenStreetMap-Auszug, der mit der App ausgeliefert wird. Haltestellen, Orte, Autobahnen,
Flüsse, Bus- und Bahnlinien, Verwaltungsgrenzen, die Gebietsliste und das Straßennetz fürs
Endgame kommen dann in Millisekunden statt nach 5 bis 25 Sekunden, und jede einmal
abgerufene Datei bleibt auf dem Gerät.

| | Rahmen |
|---|---|
| Orte, Linien, Grenzen, Gebiete | 50,53–50,90° N, 6,80–7,42° O (u. a. mit Flughafen Köln/Bonn und Phantasialand) |
| Straßennetz fürs Endgame | 50,57–50,85° N, 6,92–7,33° O |

Gebaut wird der Auszug von **GitHub Actions** aus den Geofabrik-Dateien für den
Regierungsbezirk Köln und Rheinland-Pfalz (Oberwinter und Remagen liegen schon dort):
einmal im Monat neu, sonst aus dem Cache. Das Bau-Skript (`scripts/region/`) braucht nur
Node – kein osmium, kein GDAL – und nutzt dieselben Filter wie die Online-Abfragen
(`js/sources.js`, `js/osmgeo.js`); offline und online entstehen dieselben Formen.

Liegt eine Frage über den Rand der Region hinaus (das nächste Objekt ist weiter weg, als
der Auszug reicht), fragt die App wie bisher online nach. Die Landesgrenze von NRW endet im
Auszug und kommt deshalb ebenfalls online.

Lokal bauen:

```bash
curl -LO https://download.geofabrik.de/europe/germany/nordrhein-westfalen/koeln-regbez-latest.osm.pbf
curl -LO https://download.geofabrik.de/europe/germany/rheinland-pfalz-latest.osm.pbf
node scripts/region/build.mjs bonn --pbf koeln-regbez-latest.osm.pbf --pbf rheinland-pfalz-latest.osm.pbf
```

Weitere Regionen kommen als Eintrag in `scripts/region/regions.mjs` dazu.

### Vorgebaute Karte

Auch das Kartenbild liegt für die Region fertig vor: Der Monatslauf schneidet aus der
täglich gebauten [Protomaps](https://protomaps.com)-Weltkarte (Vektorkacheln aus
OpenStreetMap-Daten) den Rahmen der Region heraus – Zoom 0 bis 14, rund 25 MB in **einer**
PMTiles-Datei (`data/<region>/map.pmtiles`). Ab Zoomstufe 10 zeigt die App in der Region
diese Karte statt der Kacheln von tile.openstreetmap.org:

- **online** holt sie nur die Bytebereiche der sichtbaren Ausschnitte, ohne die
  Zwei-Verbindungen-Grenze des OSM-Kachelservers;
- **Vorbereiten** lädt die ganze Datei in einem Abruf; danach schneidet der Service Worker
  die Ausschnitte aus der gespeicherten Datei heraus – auch im Funkloch.

Außerhalb der Region, unterhalb von Zoom 10 und mit eigener Kartenquelle bleibt es bei
Rasterkacheln. Ausschalten lässt sich die Regionskarte unter *Mehr → Einstellungen → Karte*.

```bash
node scripts/region/basemap.mjs bonn   # nach build.mjs; liest nur die nötigen Bytebereiche
```

## Offline spielen

Unter *Mehr → Offline-Vorrat → Spielgebiet vorbereiten* lädt die App einmal alles herunter, was
die Fragen später brauchen:

- die Orte jeder Kategorie, die im Regelwerk vorkommt (Museen, Bibliotheken, Bahnhöfe …)
- die Geometrie jedes Bezugsobjekts für Vergleichsfragen (Autobahnen, Flüsse, Grenzen …)
- die Orts- und Grenzliste für die Gebietsauswahl (Dörfer, Ortsteile, Gemeinden)
- die Kartenkacheln des Gebiets

Liegt das Spielgebiet in einer vorgebauten Region, holt die App stattdessen deren Dateien
auf das Gerät – für ein Gebiet mit 8 km Radius um Bonn etwa 19 MB (unkomprimiert, über die
Leitung deutlich weniger), ohne Straßennetz 11 MB – und die Karte als eine Datei mit 25 MB.
Alles läuft parallel und dauert je nach Empfang Sekunden statt Minuten.

Danach beantwortet die App jede Abfrage aus dem eigenen Bestand – im Funkloch, in der
U-Bahn, ohne Wartezeit. Welche Quellen gebraucht werden, leitet sie aus dem aktiven
Regelwerk ab; ein eigenes Regelwerk ändert die Liste automatisch mit.

Zwischen den Abfragen wartet die App bewusst knapp eine Sekunde. Die
OpenStreetMap-Server sind gespendete Infrastruktur, und ein Schwall von dreißig Abfragen
wäre unfein – dafür ist es der einzige Schwall für die ganze Runde. Objekte, die weit
außerhalb des Spielgebiets liegen (eine Küste 400 km entfernt), werden übersprungen und
bleiben online abrufbar; der Bericht am Ende sagt, was fehlt.

## Auf schwachen Geräten

Die App ist auf ältere Telefone ausgelegt. Unter *Mehr → Einstellungen → Stromsparmodus*
lässt sich das steuern; die Vorgabe **automatisch** schaltet ihn bei Geräten mit höchstens
vier Kernen oder vier Gigabyte Speicher selbst ein. Dann rechnet die Restflächen-Schätzung
mit weniger Stichproben, die Maske zeichnet mit geringerer Auflösung und nur jedes zweite
Bild, und die Karte verzichtet auf Animationen.

Unabhängig davon spart die App Strom, wo es nichts kostet:

- **Schwere Rechnungen laufen im Hintergrund.** Das Kartenraster für Linien-, Fluss- und
  Höhenfragen und die Restfläche rechnet ein Web Worker (`js/worker.js`); die Karte bleibt
  währenddessen bedienbar. Ohne Worker (sehr alte Browser) wird wie früher direkt gerechnet.
- **Ein räumlicher Index statt Durchzählen.** „Welche Buslinie ist dir am nächsten?" prüft
  nicht mehr jeden Punkt gegen Tausende Wegstücke, sondern sucht im Gitter nur in der
  Nachbarschaft; gemeinsame Abschnitte vieler Linien zählen einmal. Bei 190 Bonner
  Buslinien fiel das Raster von 1,2 s auf unter 0,1 s.
- **Gemeinsame Wege nur einmal gespeichert.** Zehn Buslinien auf derselben Straße teilen sich
  ein Stück – in den Regionsdaten und im Spielstand.
- **Umrisse auf einer Canvas-Fläche**, gleichartige Linien zu einer zusammengefasst; die
  Karte zeichnet nur neu, was sich geändert hat.

- **GPS läuft nur, wenn es gebraucht wird.** Im Hintergrund, bei eingefrorener und bei von
  Hand gesetzter Position wird die Ortung abgeschaltet – der Frier-Knopf auf der Karte ist
  damit auch ein Stromsparknopf.
- **Der Positionsmarker wird nur bei echter Bewegung neu gezeichnet** (ab zwei Metern),
  statt bei jedem eintreffenden Fix.
- **Timer takten im Sekundenrhythmus** statt viermal pro Sekunde, ruhen im Hintergrund und
  tauschen nur die Ziffern aus, statt die Liste neu aufzubauen. Gerechnet wird über
  Zeitstempel, es geht also nichts verloren.
- **Die Maske überspringt, was außerhalb des Bildausschnitts liegt**, und zeichnet einfache
  Formen ohne Zwischenpuffer.

## Regelwerk

Die Spielregeln stecken nicht im Code, sondern in `rules/lifack.json`. Mitgeliefert sind
die Werte von [lifack.ch](https://www.lifack.ch/docs/quick_start_guide/) – einer
inoffiziellen Fan-Umsetzung von *Jet Lag: Hide and Seek*, nicht mit Jet Lag, Nebula oder
Wendover Productions verbunden. Die Originalmaße in Meilen sind auf runde metrische Werte
umgestellt (¼ Meile → 400 m, 1 Meile → 1,6 km, 3 Meilen → 5 km, 10 Meilen → 16 km); die
App rechnet und zeigt durchgehend in Metern und Kilometern.

| Spielgröße | Versteckzeit | Versteckzone | Antwortfrist | Fotofrist |
|---|---|---|---|---|
| Klein | 30 Min | 400 m | 5 Min | 10 Min |
| Mittel | 60 Min | 400 m | 5 Min | 10 Min |
| Groß | 180 Min | 800 m | 5 Min | 20 Min |

Jede Option wird ausgewertet, keine ist mehr „nur Protokoll":

| Option | Auswertung über OpenStreetMap |
|---|---|
| Matching: Verkehrslinie | nächste Bus-, Tram-, U-Bahn- oder Zuglinie, nach Liniennummer |
| Matching: Länge des Stationsnamens | alle Stationen mit gleich langem Namen (Buchstaben und Ziffern) |
| Matching: Straße oder Weg | nächste benannte Straße im Umkreis von 1,5 km |
| Matching: Landmasse | Inseln (Grafenwerth, Nonnenwerth, Herseler Werth …) gegen Festland |
| Tentacles: Metrolinien | Straßen- und U-Bahn-Linien im Umkreis |
| Photos | zeigt die Orte der passenden Art im Restgebiet – Kirchen, Parks, Supermärkte, Restaurants, Bahnsteige, Türme, Berge, Seen |

Wo nur ein Nahbereich geladen wird (Straßen) oder eine Liste abgeschnitten ist, wirkt die
Frage nur dort, wo das Ergebnis sicher ist; weiter weg schließt sie nichts aus, statt
womöglich das Falsche auszuschließen. Fotos ohne passende Ortsart (Himmel, Baum, du selbst)
starten nur Frist und Protokoll.

Ergänzt sind Matching-Fragen, die lifack.ch nicht hat: **Flussseite**, **Autobahn** und
**Landstraße** („Ist deine nächste Autobahn dieselbe wie meine?"). Straßen erkennt die App an
ihrer Nummer – die B 9 bleibt die B 9, auch wenn sie in Bonn mal Adenauerallee und mal
Bonner Straße heißt. „Landstraße" umfasst Bundes-, Landes- und Kreisstraßen.

Die sechs Kategorien mit ihren Ziehwerten: Matching und Measuring je *3 ziehen, 1 behalten*,
Thermometer und Radar *2 ziehen, 1 behalten*, Tentacles *4 ziehen, 2 behalten*, Photos
*1 ziehen*. Welche Werte zur Auswahl stehen, hängt an der Spielgröße – bei „Klein" gibt es
zum Beispiel keine Tentacles und nur die beiden kurzen Thermometer-Distanzen.

**Bezugsobjekte holt die App selbst.** Für Vergleichsfragen musst du nirgends einen Punkt
setzen: Du tippst das Objekt an, die App sucht das nächstgelegene Exemplar in
OpenStreetMap und misst gegen dessen echte Geometrie. Das ist der Unterschied, der bei
ausgedehnten Objekten zählt – eine Autobahn, eine Küste oder eine Grenze hat keinen
sinnvollen Mittelpunkt. Gemessen wird der Abstand zum nächstgelegenen Punkt des Objekts,
und die Grenze auf der Karte ist dann ein Korridor, kein Kreis.

Zur Auswahl stehen als Linie: Autobahn, Schnellstraße, Bahnstrecke, Schnellfahrstrecke,
Staatsgrenze, Grenzen der Verwaltungsebenen 1 und 2, Küstenlinie, Fluss. Als Fläche oder
Punkt: Gewässer, Wald, Park, Berg, Verkehrsflughafen, Bahnhof, Museum, Kino, Krankenhaus,
Bibliothek, Zoo, Aquarium, Freizeitpark, Golfplatz, Stadion, Gotteshaus, ausländische
Vertretung.

Dabei wird nicht nur das nächste Teilstück geladen: OpenStreetMap zerlegt lange Wege an
jeder Kreuzung, deshalb holt die App so viel Geometrie, dass sie das ganze Spielgebiet
plus den gemessenen Abstand abdeckt, und fügt die Stücke zu durchgehenden Linien zusammen.
Sonst läge ein Punkt am anderen Ende des Gebiets scheinbar weit von der Autobahn weg, nur
weil deren Teilstücke dort fehlen.

Findet die Suche nichts (kein Empfang, Objekt zu weit weg), kannst du den Abstand als Zahl
eintragen – ein Punkt ist auch dann nicht nötig.

**Was beim Stellen einer Regelfrage passiert:** die Antwortfrist läuft als Timer los, die
Frage landet mitsamt Ziehwert im Protokoll, und wo es geometrisch etwas zu holen gibt,
öffnet sich das passende Werkzeug mit vorausgefüllten Werten – Radar wird zur
Radius-Frage, Thermometer zur Mittelsenkrechten, Measuring zum Vergleichskreis, Tentacles
und Matching zu Voronoi-Zellen (beim Matching lädt die App die Orte der Kategorie und
markiert deinen nächstgelegenen vorab). Matching auf Verwaltungsebenen wird zur
Gebietsfrage. Photos erzeugen keine Geometrie und werden nur protokolliert.

Autobahnen stehen nicht in der Measuring-Liste von lifack.ch. Im freien Werkzeug
*Vergleich* gibt es sie trotzdem; als Regeloption reicht eine Zeile in der JSON-Datei:

```json
{ "label": "Autobahn", "group": "Verkehr", "sizes": ["small", "medium", "large"], "osm": "motorway" }
```

### Eigene Hausregeln

Das Format kann weit mehr als lifack.ch nutzt. Die vollständige Referenz mit Beispielen
steht in **[rules/SCHEMA.md](rules/SCHEMA.md)**. Ausdrücken lassen sich unter anderem:

| Regelart | Feld |
|---|---|
| Fristen mit Folge („Endgame nach X Stunden nicht erreicht → Suchende verlieren") | `round.deadlines` |
| Gestufte Strafen für verspätete Antworten, Zeitabzug mit Faktor | `round.lateAnswer` |
| Grenzfall-Antwort je Kategorie, mit Toleranzband | `questions[].tieBreak`, `answering.tieToleranceM` |
| Haltestellenart als Zonenmittelpunkt, Auswahl der nächsten, Toleranz am Schild | `hidingZone.anchor…` |
| Zone ab einer Rundenphase festgeschrieben | `hidingZone.lockAt` |
| Im Endgame nicht bewegen, Antworten nur nah am Versteck | `endgame.hiderMayMove`, `endgame.answerWithinM` |
| Erlaubte und verbotene Verkehrsmittel und Recherchequellen | `transport`, `research` |
| Beliebige weitere Regeltexte | `sections` |
| Ziehwerte je Kategorie | `questions[].draw`, `pick` |
| Mehrere Quellen in einer Option („Bus-, Bahnlinie oder Autobahn") | `options[].osm` als Liste |
| Linien und Flächen statt Punkte beim Matching | `options[].match: "shape"` |
| Stadtteil, Stadtbezirk, Gemeinde – ohne Auswahl von Hand | `options[].adminLevel` |
| Höhe über dem Meeresspiegel | `appType: "elevation"` |
| Gleiche Seite eines Flusses | `appType: "side"` mit `osm: "river"` |
| Frei wählbares Objekt | `options[].freeChoice` |

Die App prüft jede Datei vor dem Übernehmen und nennt bei Fehlern die Stelle, etwa
`Frist "endgame": "until" fehlt` oder `Option "Spielplatz": unbekannte Quelle "spielplatz"`.

**Anpassen** unter *Mehr → Regelwerk*: Spielgröße umschalten, Regeln ansehen,
JSON direkt bearbeiten, eigene Datei laden, exportieren, zurücksetzen. Eigene Regelwerke
werden geprüft, bevor sie greifen – fehlt etwas, sagt die Meldung was.
Über „Deck als Listen" landen Zeitboni, Powerups und Flüche in der Ziehfunktion, jeweils
in ihrer Häufigkeit im Deck (55 / 21 / 24 Karten).

Ein eigenes Regelwerk wird **nicht** über den Spielstand-Link geteilt – es wäre zu groß für
einen QR-Code. Gib die JSON-Datei separat weiter.

## Auf dem Handy installieren

**iPhone/iPad:** Seite in **Safari** öffnen → Teilen-Symbol → „Zum Home-Bildschirm".
**Android:** in **Chrome** öffnen → Menü ⋮ → „App installieren".

Wichtig: Standort, Offline-Betrieb und Installation brauchen **HTTPS**. Über die
veröffentlichte Adresse öffnen – eine lokal geöffnete Datei oder ein `http://`-Server
im WLAN reicht dafür nicht.

## Entwicklung

```bash
node scripts/dev-server.mjs 8099
```

Dann `http://localhost:8099` öffnen – `localhost` gilt als sicherer Kontext, also
funktionieren dort auch Standort und Service Worker.

```bash
node --test test/*.test.mjs   # Geodäsie, Fragetypen, Endgame, Regionsdaten, Regelwerk
./scripts/check.sh     # Syntaxprüfung aller Module
node scripts/make-icons.mjs  # Icons neu erzeugen
```

Kein Build-Schritt: Was im Repository liegt, wird genau so ausgeliefert.
Nach Änderungen an den Dateien die Versionsnummer in `sw.js` (`VERSION`) erhöhen,
damit installierte Geräte das Update ziehen.

### Aufbau

```
index.html          App-Shell mit fünf Tabs
sw.js               Service Worker: App offline, Kacheln und Kartenbereiche aus dem Cache
rules/lifack.json   Regelwerk: Spielgrößen, Fristen, Fragekategorien, Deck
rules/SCHEMA.md     Referenz des Regelformats
js/rules.js         Regelwerk laden, prüfen, nach Spielgröße filtern
js/sources.js       OpenStreetMap-Quellen: Orte und Geometrien, mit Filtern
js/elevation.js     Geländehöhe über Open-Meteo (Copernicus-Modell)
js/phases.js        Rundenphasen, Fristenstatus, Nettozeit
js/zone.js          Versteckzone, Haltestellen als Mittelpunkt, Versteckpunkt
js/geo.js           Geodäsie (Distanz, Peilung, Mittelsenkrechte, Vereinfachung)
js/constraints.js   Fragetypen: Prüffunktion, Zeichengeometrie, Restflächen-Statistik
js/mask.js          Canvas-Overlay, das die ausgeschlossenen Flächen vereinigt
js/map.js           Leaflet, Marker, Messwerkzeug, Punktauswahl
js/questions.js     Dialoge zum Anlegen und Verwalten der Fragen
js/overpass.js      OpenStreetMap-Abfragen: erst Regionsdaten, dann Vorrat, dann Overpass
js/osmgeo.js        OSM-Elemente zu Punkten, Linien, Flächen (für App und Bau-Skript)
js/region.js        Vorgebaute Regionsdaten und -karte lesen, cachen, vorladen
js/endgame.js       Endgame: Zone, Streckenaufzeichnung, Taschenmodus, GPX
js/streets.js       Straßennetz, abgelaufene Stücke, kürzester Weg
js/timers.js        Timer-Engine auf Zeitstempelbasis
js/rounds.js        Teams, Runden, Wertung, Protokoll
js/share.js         Export/Import über gepackte Links und QR-Codes
js/tiles.js         Offline-Kachelcache
js/bundle.js        Ablage der vorab geladenen Gebietsdaten
js/prefetch.js      Spielgebiet vorbereiten: sammelt alles Nötige ein
js/state.js         Zustand, Persistenz, Undo
js/compute.js       Raster und Restfläche im Hintergrund-Thread (js/worker.js)
scripts/region/     Regionsdaten bauen: PBF-Leser, Bau-Skript, Regionen, Kartenausschnitt (PMTiles)
```

Drei Entscheidungen, die den Rest erklären:

- **Keine Geometriebibliothek.** Die Maske entsteht durch Übereinanderzeichnen auf einem
  Canvas (`mask.js`), nicht durch boolesche Polygonoperationen. Vereinigungen werden
  übereinandergemalt, Schnitte (die Zelle einer verneinten Matching-Frage) durch Füllen
  und Ausstanzen. Statistik und Zufallspunkte laufen stattdessen analytisch über
  `allows()` – unabhängig von Zoom und Bildausschnitt.
- **Die heißen Pfade rechnen ohne Allokation.** Die Restflächen-Schätzung wertet jede
  Frage an tausenden Stichproben aus; `distanceToLine` und Verwandte arbeiten deshalb mit
  einmal berechneten Projektionsfaktoren, quadrierten Abständen und ohne Zwischenobjekte.
  Das brachte den Faktor sieben gegenüber der ersten, gut lesbaren Fassung.
- **Alles in lokalen Metern gerechnet.** Kreise und Mittelsenkrechten werden geodätisch
  bestimmt und als Punktfolge zurückprojiziert. Eine im Bildschirmraum gerade gezogene
  Trennlinie läge auf Stadtmaßstab bereits sichtbar falsch.

## Hinweise

- Kartendaten © OpenStreetMap-Mitwirkende. Der Kachel-Download ist bewusst auf 2000 Kacheln
  pro Vorgang gedeckelt und gedrosselt – die OSM-Server sind gespendete Infrastruktur.
  Für größere Gebiete unter *Mehr → Einstellungen → Kachelquelle* eine eigene Quelle eintragen.
- Alle Daten bleiben auf dem Gerät (localStorage und Cache Storage). Geteilt wird nur,
  was ihr aktiv per Link oder QR weitergebt.
- Regionsdaten © OpenStreetMap-Mitwirkende, Lizenz ODbL; Auszüge von
  [Geofabrik](https://download.geofabrik.de). Regionskarte aus den Tageskarten von
  [Protomaps](https://protomaps.com) (Daten © OpenStreetMap-Mitwirkende, ODbL).
- Enthaltene Fremdsoftware: [Leaflet](https://leafletjs.com) (BSD-2-Clause),
  [protomaps-leaflet](https://github.com/protomaps/protomaps-leaflet) (BSD-3-Clause),
  [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT) und
  Symbole von [Lucide](https://lucide.dev) (ISC), jeweils unter `vendor/` mit Lizenztext.

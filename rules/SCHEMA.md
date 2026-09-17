# Regelformat

Ein Regelwerk ist eine JSON-Datei. Mitgeliefert ist `rules/lifack.json`; ein eigenes lädt
man unter *Mehr → Regelwerk → Datei laden* oder bearbeitet es dort direkt. Die App prüft
jede Datei vor dem Übernehmen und nennt bei Fehlern die Stelle.

Alle Blöcke außer `gameSizes` und `questions` sind optional. Was fehlt, wird nicht
angewendet – ein Regelwerk ohne `round.deadlines` hat eben keine Fristen.

```jsonc
{
  "schemaVersion": 2,
  "id": "meine-regeln",
  "name": "Unsere Hausregeln",
  "gameSizes": [ … ],     // Pflicht
  "round": { … },
  "hidingZone": { … },
  "endgame": { … },
  "answering": { … },
  "transport": { … },
  "research": { … },
  "sections": [ … ],
  "questions": [ … ],     // Pflicht
  "deck": { … }
}
```

Distanzen stehen immer in **Metern**, Zeiten in **Minuten**.

---

## Rundenphasen

Fristen, Sperren und Endgame-Regeln verweisen auf diese Namen. In der App schaltet man
die Phasen in der Rundenkarte (*Spiel*) weiter.

| Name | Bedeutung |
|---|---|
| `roundStart` | Runde gestartet |
| `hidingEnd` | Ende der Versteckzeit |
| `searchStart` | Beginn der Suche (fällt meist mit `hidingEnd` zusammen) |
| `endgame` | Endgame erreicht |
| `found` | Versteckende Seite gefunden, Runde beendet |

---

## `gameSizes` – Spielgrößen

```json
{
  "id": "stadt",
  "label": "Stadt",
  "description": "Eine Stadt mit Umland",
  "typicalDuration": "5 Stunden",
  "hidingPeriodMinutes": 30,
  "hidingZoneRadiusM": 300,
  "answerMinutes": 5,
  "photoMinutes": 10
}
```

`hidingZoneRadiusM` ist der **Radius**. Die App zeigt die Fläche in Hektar daneben an
(π · r² / 10 000) – 300 m Radius sind 28 ha, nicht 7.

---

## `round` – Wertung, Fristen, verspätete Antworten

```json
"round": {
  "scoring": "longestSingleRound",
  "handLimit": 6,
  "roundChangeMinutes": 10,
  "deadlines": [ … ],
  "lateAnswer": { … }
}
```

| Feld | Werte |
|---|---|
| `scoring` | `longestSingleRound` (längste Einzelrunde gewinnt) oder `totalTime` (Summe) |

Gewertet wird die **Nettozeit**: Rundendauer minus aller Zeitabzüge.

### `deadlines` – Fristen mit Folge

```json
{
  "id": "frist-endgame",
  "label": "Endgame nicht rechtzeitig erreicht",
  "afterMinutes": 180,
  "from": "roundStart",
  "until": "endgame",
  "outcome": "seekersLose",
  "outcomeLabel": "Suchende verlieren die Runde"
}
```

| Feld | Bedeutung |
|---|---|
| `afterMinutes` | Dauer der Frist |
| `from` | Phase, ab der sie läuft (Vorgabe `roundStart`) |
| `until` | Phase, die vorher erreicht sein muss – **Pflicht** |
| `outcome` | `seekersLose`, `hiderLoses` oder `note` (nur Hinweis) |
| `outcomeLabel` | eigener Text für die Folge |

Die Rundenkarte zeigt die Restzeit jeder Frist. Läuft eine ab, gibt es Alarm, einen
Protokolleintrag und – außer bei `note` – ein Urteil an der Runde.

### `lateAnswer` – Folgen verspäteter Antworten

```json
"lateAnswer": {
  "steps": [
    { "overMinutes": 0, "nextDrawDelta": -1 },
    { "overMinutes": 3, "nextQuestionFree": true }
  ],
  "deductOvertimeFactor": 1.5,
  "exemptionNote": "Gilt nicht bei entlastendem Grund."
}
```

| Feld | Bedeutung |
|---|---|
| `steps[].overMinutes` | ab wie vielen Minuten Verspätung die Stufe gilt; `0` = jede Verspätung |
| `steps[].nextDrawDelta` | Kartenänderung bei der nächsten Frage (`-1` = eine weniger) |
| `steps[].nextQuestionFree` | nächste Frage kostet nichts |
| `deductOvertimeFactor` | überzogene Zeit × Faktor wird von der Rundenzeit abgezogen |

Es gilt die **höchste zutreffende Stufe**, nicht die Summe. So funktioniert es in der App:
Jede Regelfrage startet einen Antwort-Timer. Kommt die Antwort, tippt man
**„✓ Antwort da"** – die App misst die Überziehung und wendet die Stufe an. Bei einem
entlastenden Grund **„✓ entschuldigt"**: dann gibt es keine Folgen.

---

## `hidingZone` – Versteckzone

```json
"hidingZone": {
  "anchorCategory": "tram_subway",
  "anchorChoices": 3,
  "anchorToleranceM": 10,
  "lockAt": "hidingEnd",
  "rules": ["Freitext …"]
}
```

| Feld | Bedeutung |
|---|---|
| `anchorCategory` | Art der Haltestelle, die als Mittelpunkt gilt (ID aus der Ortstabelle unten) |
| `anchorChoices` | wie viele der nächstgelegenen zur Wahl angeboten werden |
| `anchorToleranceM` | Spielraum um das Schild; wird auf der Karte als kleiner Kreis gezeigt |
| `lockAt` | ab dieser Phase lässt sich die Zone nur noch mit Nachfrage verschieben |

Mit `anchorCategory` erscheint in der Rundenkarte ein Knopf, der die nächstgelegenen
Haltestellen dieser Art zur Wahl stellt.

---

## `endgame`

```json
"endgame": {
  "trigger": "Freitext, wann das Endgame beginnt",
  "hiderMayMove": false,
  "answerWithinM": 3,
  "rules": ["…"]
}
```

`answerWithinM` zeigt im Endgame den Abstand zum **Versteckpunkt** an (Punktmenü auf der
Karte → „Versteckpunkt hier"). GPS ist nur auf einige Meter genau – die Anzeige nennt die
aktuelle Ungenauigkeit mit.

---

## `answering` – Antworten und Grenzfälle

```json
"answering": {
  "position": "current",
  "tieToleranceM": 15,
  "rules": ["…"]
}
```

| Feld | Bedeutung |
|---|---|
| `position` | `current`: Antworten gelten für den aktuellen Standort; `any` |
| `tieToleranceM` | Wie nah an einer Grenze noch als „Grenzfall" gilt |

Die Grenzfall-**Antwort** steht je Kategorie in `questions[].tieBreak` (siehe unten). Die
Toleranz ist das Band um die Grenze, in dem sie gilt. Wer innerhalb dieses Bandes steht,
gibt die Grenzfall-Antwort – deshalb rechnet die App das Band dieser Antwort zu, wenn sie
die Fläche ausschließt.

---

## `transport`, `research`, `sections` – Freitext

```json
"transport": {
  "allowed": ["Bus", "Straßenbahn", "zu Fuß"],
  "forbidden": ["Fernzug"],
  "rules": ["…"]
},
"research": {
  "allowed": ["Luftbild"],
  "forbidden": ["Straßenansicht"],
  "rules": ["…"]
},
"sections": [
  { "title": "Suchende", "rules": ["…", "…"] }
]
```

Erscheint unter *Regeln ansehen*: `allowed`/`forbidden` als Listen, `rules` als
Aufzählung, jeder Abschnitt aus `sections` als eigener Block.

---

## `questions` – Fragekategorien

```json
{
  "id": "gleich",
  "order": 1,
  "label": "Matching",
  "prompt": "Ist dein nächstes … dasselbe wie meines?",
  "draw": 3,
  "pick": 1,
  "minutes": 5,
  "appType": "nearest",
  "nearestMode": "same",
  "tieBreak": "yes",
  "options": [ … ]
}
```

| Feld | Bedeutung |
|---|---|
| `draw`, `pick` | Karten ziehen/behalten nach der Antwort |
| `minutes` | Antwortfrist; alternativ `minutesBySize: { "stadt": 10 }` |
| `appType` | wie die App die Antwort auf der Karte auswertet (siehe unten), `null` = nur protokollieren |
| `nearestMode` | bei `nearest`: `same` („dasselbe wie meines?") oder `which` („welchem am nächsten?") |
| `tieBreak` | Antwort im Grenzfall: `inside`/`outside`, `warmer`/`colder`, `closer`/`further`, `yes`/`no` |

### `appType` – Auswertung auf der Karte

| Typ | Frage | Was die App braucht |
|---|---|---|
| `radius` | Bist du im Umkreis? | `meters` an der Option |
| `thermo` | Wärmer oder kälter? | nichts – Start- und Endpunkt kommen aus dem Formular |
| `compare` | Näher oder weiter an X als ich? | `osm` mit Bezugsobjekt(en) |
| `nearest` | Dasselbe/welches nächste X? | `osm` mit Orten oder Linien |
| `area` | Im selben Gebiet? | `adminLevel` oder ein gewähltes Gebiet |
| `elevation` | Näher am Meeresspiegel als ich? | nichts – Geländehöhe wird geladen |
| `null` | Fotos, alles ohne Kartenbezug | – |

### Optionen

```json
{ "label": "Spielplatz", "osm": "playground" }
{ "label": "Linie oder Autobahn", "osm": ["bus_route", "tram_route", "motorway"], "match": "shape" }
{ "label": "Stadtteil", "appType": "area", "adminLevel": 10 }
{ "label": "Stadtbezirksgrenze", "osm": "admin_border", "adminLevel": 9 }
{ "label": "Meeresspiegel", "appType": "elevation" }
{ "label": "Freie Wahl", "freeChoice": true }
{ "label": "1 km", "meters": 1000, "sizes": ["stadt"] }
{ "label": "Landmasse", "appType": null, "note": "Nicht auf der Karte auswertbar" }
```

| Feld | Bedeutung |
|---|---|
| `osm` | eine Quellen-ID oder eine **Liste** – dann zählt das nächste Objekt irgendeiner Quelle |
| `match` | bei `nearest`: `point` (Orte als Punkte, schnell) oder `shape` (Linien/Flächen als Geometrie) |
| `adminLevel` | Verwaltungsebene (2–12) für `area` oder `admin_border` |
| `freeChoice` | die fragende Seite wählt das Objekt beim Fragen selbst |
| `meters` | Distanz für `radius`/`thermo`, Suchradius bei Tentakeln |
| `sizes` | nur in diesen Spielgrößen verfügbar |
| `appType` | überschreibt den Typ der Kategorie für diese eine Option |
| `note` | Begründung, wenn eine Option nicht ausgewertet wird |

**Verwaltungsebenen sind regional verschieden.** In Deutschland meist: 4 Bundesland,
6 Kreis, 8 Gemeinde/Stadt, 9 Stadtbezirk, 10 Ortsteil. Welche Ebene in eurem Gebiet was
bedeutet, zeigt *Mehr → Spielgebiet → Ort / Gebiet* (dort steht die Ebene an jedem Treffer).

**Höhe über NN** kommt aus dem Copernicus-Geländemodell (90 m) über Open-Meteo, als Raster
von höchstens 20 × 20 Punkten über dem Spielgebiet. Gebäude und Brücken zählen nicht mit.

---

## Quellen

### Orte (`nearest` mit `match: "point"`, `hidingZone.anchorCategory`)

| ID | Bedeutung |
|---|---|
| `station` | Bahnhöfe |
| `tram` | Tram/U-Bahn |
| `tram_subway` | U-/Straßenbahn-Haltestellen |
| `bus` | Bushaltestellen |
| `ferry` | Fähranleger |
| `bridge` | Brücken |
| `museum` | Museen |
| `park` | Parks |
| `lake` | Seen |
| `playground` | Spielplätze |
| `hospital` | Krankenhäuser |
| `worship` | Kirchen |
| `school` | Schulen |
| `university` | Hochschulen |
| `library` | Bibliotheken |
| `supermarket` | Supermärkte |
| `zoo` | Zoos/Tierparks |
| `aquarium` | Aquarien |
| `theme_park` | Freizeitparks |
| `cinema` | Kinos |
| `golf` | Golfplätze |
| `viewpoint` | Aussichtspunkte |
| `tower` | Türme |
| `peak` | Berggipfel |
| `consulate` | Konsulate/Botschaften |
| `stadium` | Stadien |
| `airport` | Flughäfen |
| `townhall` | Rathäuser |
| `castle` | Burgen/Schlösser |

### Bezugsobjekte (`compare`, `nearest` mit `match: "shape"`)

| ID | Bedeutung | gemessen als |
|---|---|---|
| `motorway` | Autobahn | Linie |
| `trunk` | Schnellstraße | Linie |
| `rail` | Bahnstrecke | Linie |
| `highspeed` | Schnellfahrstrecke | Linie |
| `bus_route` | Buslinie | Linien (Relation) |
| `tram_route` | Straßenbahnlinie | Linien (Relation) |
| `subway_route` | U-/Stadtbahnlinie | Linien (Relation) |
| `rail_route` | Zuglinie | Linien (Relation) |
| `ferry` | Fähre | Linie |
| `bridge` | Brücke | Punkt/Fläche |
| `border_country` | Staatsgrenze | Linie |
| `border_admin1` | Grenze Verwaltungsebene 1 | Linie |
| `border_admin2` | Grenze Verwaltungsebene 2 | Linie |
| `admin_border` | Verwaltungsgrenze (braucht `adminLevel`) | Linie |
| `coastline` | Küstenlinie | Linie |
| `river` | Fluss | Linie |
| `stream` | Fluss/Bach | Linie |
| `water` | Gewässer | Punkt/Fläche |
| `lake` | See | Punkt/Fläche |
| `mountain` | Berg | Punkt |
| `forest` | Wald | Punkt/Fläche |
| `consulate` | Ausländische Vertretung | Punkt/Fläche |
| `airport` | Verkehrsflughafen | Punkt/Fläche |
| `station` | Bahnhof | Punkt/Fläche |
| `tram_subway` | U-/Straßenbahn-Haltestelle | Punkt/Fläche |
| `bus_stop` | Bushaltestelle | Punkt |
| `park` | Park | Punkt/Fläche |
| `playground` | Spielplatz | Punkt/Fläche |
| `museum` | Museum | Punkt/Fläche |
| `cinema` | Kino | Punkt/Fläche |
| `hospital` | Krankenhaus | Punkt/Fläche |
| `library` | Bibliothek | Punkt/Fläche |
| `school` | Schule | Punkt/Fläche |
| `townhall` | Rathaus | Punkt/Fläche |
| `zoo` | Zoo/Tierpark | Punkt/Fläche |
| `aquarium` | Aquarium | Punkt/Fläche |
| `theme_park` | Freizeitpark | Punkt/Fläche |
| `golf` | Golfplatz | Punkt/Fläche |
| `stadium` | Stadion | Punkt/Fläche |
| `worship` | Gotteshaus | Punkt/Fläche |
| `sea_level` | Meeresspiegel | Höhenmodell |

Neue Quellen kommen in `js/sources.js` dazu – dort stehen die OpenStreetMap-Filter.

---

## `deck`

```json
"deck": {
  "blanks": 25,
  "timeBonuses": [{ "minutes": 5, "count": 25 }],
  "powerups": [{ "label": "Veto", "count": 4, "effect": "…" }],
  "curses": [{ "label": "Fluch …", "count": 1 }]
}
```

*Mehr → Regelwerk → Deck als Listen* macht daraus Ziehlisten in der jeweiligen Häufigkeit.

# Datenanalyse: `Anfragen_2026-08-27.xlsx`

Echte Datei, nach Bearbeitung durch den Flow. 72 Anfragen, 206 Positionen,
je 18 Spalten. Diese Analyse ersetzt alle bisherigen Annahmen über die
Dateistruktur.

**Grundstruktur bestätigt:** Blätter `Anfragen` und `Positionen`, verknüpft
über `Opp-ID`. Keine Waisen — jede Anfrage hat Positionen, jede Position hat
ihre Anfrage.

---

## 1. Der kritische Befund: `dummy@dihag.com`

**Die Sammeladresse `dummy@dihag.com` taucht in 7 von 72 Anfragen (9 %) auf,
verteilt auf 7 verschiedene Firmen.** Dahinter steht immer derselbe Name:
„Paul Dummy".

Das bricht den Kontaktschlüssel, den ich vorgesehen hatte — und zwar in
beide Richtungen:

**Was der Altflow macht:** sucht `emailaddress1 eq 'dummy@dihag.com'`, findet
den einen Dummy-Kontakt und hängt Verkaufschancen von 7 verschiedenen Firmen
an denselben Kontakt.

**Was mein Entwurf gemacht hätte — schlimmer:** Upsert auf `emailaddress1`
mit `parentcustomerid` aus der Firmenspalte. Bei jeder der 7 Zeilen wird der
Dummy-Kontakt **umgehängt**. Nach dem Lauf gehört er der Firma, die zufällig
zuletzt dran war. Bei jedem weiteren Lauf einer anderen Firma.

Ein zweiter, harmloser Fall bestätigt das Muster:
`janine.beckers@beinbauer-group.de` erscheint bei zwei Firmennummern — eine
echte Person in einer Unternehmensgruppe mit mehreren Gesellschaften.

**Konsequenz:** Die E-Mail allein ist kein Schlüssel. Der Schlüssel ist
**E-Mail + Firma**. Zwei Umsetzungswege:

1. Zusammengesetzter Alternativschlüssel auf `contact`
   (`emailaddress1` + `parentcustomerid`). Sauber, aber Dataverse muss ihn
   indizieren können.
2. Sammeladressen über eine Ausnahmeliste erkennen und für diese Zeilen
   **keinen** Kontakt setzen — die Verkaufschance läuft ohne
   `parentcontactid`. Ein Platzhalterkontakt trägt ohnehin keine Information.

Weg 2 ist ehrlicher: „Paul Dummy" ist kein Ansprechpartner, sondern die
Aussage „es gibt keinen". Das sollte im CRM auch so aussehen.

**Zu klären:** Gibt es weitere Sammeladressen? `dummy@` ist die eine, die in
dieser Datei sichtbar ist.

---

## 2. Kopfzeilen mit unsichtbaren Leerzeichen

```
Positionen H1 = 'Breite (mm) '     ← Leerzeichen am Ende
Positionen I1 = 'Höhe (mm) '       ← Leerzeichen am Ende
```

Mein erster Leseversuch ist daran abgestürzt. Bei exaktem Vergleich hätte die
Zuordnung für beide Spalten nie gegriffen — genau der Fehler, den ich in
meinem eigenen Profil schon einmal hatte.

**Regel für die App:** Kopfzeilen beim Einlesen trimmen und
Mehrfach-Leerzeichen zusammenziehen. Die Zuordnung arbeitet mit der
normalisierten Fassung. Der Prüflauf zeigt an, wenn eine Kopfzeile
normalisiert werden musste — dann weiß man, dass die Vorlage unsauber ist,
ohne dass der Import daran scheitert.

---

## 3. Der Flow liest eine Spalte, die es nicht gibt

```
Excel-Spalte:     Zeichnungsnummer     (202 von 206 Zeilen befüllt)
Flow liest:       Zeichennummer        (existiert nicht)
```

Der Ausdruck liefert `null`. **Die Zeichnungsnummer geht bei jedem Lauf
verloren**, obwohl sie in fast jeder Zeile steht. Kein Fehler, keine Meldung.

Das ergänzt Befund B8 um eine Ursache: Es ist nicht nur „nicht zugeordnet",
es ist ein Tippfehler im Flow.

---

## 4. Befüllte Spalten, die der Flow gar nicht anfasst

| Blatt | Spalte | Befüllt | Naheliegendes Ziel |
|---|---|---|---|
| Anfragen | `Voraussichtliches Abschlussdatum` | **72/72** | `estimatedclosedate` |
| Positionen | `sonstige Zuschläge` | **206/206** | eigenes Feld, fehlt |
| Positionen | `Zeichnungsnummer` | 202/206 | siehe oben |
| Positionen | `Breite (mm)` / `Höhe (mm)` | 206/206 | `dag_widthmm` / `dag_heightmm` |
| Anfragen | `Manuelle Preisanpassung` | 72/72 (alle 0) | unklar |

`Voraussichtliches Abschlussdatum` ist der auffälligste: durchgängig befüllt,
Spanne 13.11.2024 bis 09.09.2026, und ein Standardfeld an der Verkaufschance
wartet darauf. **8 der 72 Termine liegen in der Vergangenheit** — kein
Importfehler, aber eine Auffälligkeit fürs Protokoll.

---

## 5. Der Besitzer wird nie gesetzt

Anforderung: Der Mitarbeiter aus der Datei soll Besitzer der Verkaufschance
werden.

**Der Flow tut das nicht.** Er sucht zwar `systemusers` über
`internalemailaddress eq <Mitarbeiter>` — verwendet das Ergebnis aber nicht.
Gesetzt wird stattdessen:

```
ownerid@odata.bind = /systemusers(<_owninguser_value des eben angelegten
                                  opportunityproduct>)
```

Das ist der Besitzer des gerade erzeugten Positionsdatensatzes, also der
Verbindungsbenutzer des Flows. **Der Mitarbeiter aus der Datei landet
nirgends.** Damit ist die Systembenutzer-Abfrage die dritte tote Suche im
Flow, neben `technicalaudit` und `productline` (Befund B7).

**Die gute Nachricht:** Die Daten geben das her.

```
Mitarbeiter je Verkaufschance eindeutig:  ja, 0 Konflikte bei 72 Chancen
```

`Mitarbeiter` steht zwar im Blatt `Positionen`, ist aber je `Opp-ID`
durchgängig identisch. Die App kann ihn beim Aufbau der Verkaufschance aus
der ersten zugehörigen Position übernehmen.

Verteilung:

| Mitarbeiter | Positionen |
|---|---|
| mitto@dihag.com | 111 |
| kluge@dihag.com | 56 |
| kirsch@dihag.com | 19 |
| tran@dihag.com | 14 |
| kappelt@dihag.com | 3 |
| **erik.bier@schmie-guss.de** | 3 |

Der letzte ist eine **fremde Domäne** und vermutlich kein Systembenutzer im
Mandanten. Dafür braucht es eine Regel: Besitzer nicht auflösbar ⇒ Warnung
im Protokoll, Verkaufschance wird trotzdem importiert und behält den
importierenden Benutzer als Besitzer. Nicht abweisen — die Daten sind sonst
in Ordnung.

---

## 6. Status widerspricht sich innerhalb einer Verkaufschance

`Status` steht im Blatt `Positionen`, trägt aber Vertriebsphasen der
Verkaufschance: `Win`, `Loss`, `Check Feasibility`, `Develop And Submit
Proposal`, `Negotiate and Close`.

**Bei 9 von 72 Verkaufschancen sind die Positionen uneinheitlich:**

| Opp-ID | Werte |
|---|---|
| 6650 | Negotiate and Close, **Win** |
| 6889 | **Loss**, **Win** |
| 7263 | Check Feasibility, Negotiate and Close |
| 7340 | Develop And Submit Proposal, Negotiate and Close |
| 7342 | Develop And Submit Proposal, Negotiate and Close |
| 7362 | Negotiate and Close, **Win** |
| 7405 | Check Feasibility, Develop And Submit Proposal |
| 7410 | Check Feasibility, Develop And Submit Proposal |
| 7413 | Check Feasibility, Develop And Submit Proposal |

Opp 6889 ist der harte Fall: gleichzeitig gewonnen und verloren.

Der Flow schreibt `Status` nirgendwohin, deshalb fällt es bisher nicht auf.
Sobald das Feld verarbeitet wird, braucht es eine Entscheidung:

- **Position gewinnt** — Status gehört fachlich zur Position, dann muss ein
  Zielfeld an `opportunityproduct` her
- **Weiteste Phase gewinnt** — die Verkaufschance bekommt den am weitesten
  fortgeschrittenen Status ihrer Positionen
- **Konflikt melden** — Zeile in den Prüfbericht, Anwender klärt in der Datei

Meine Empfehlung ist die dritte für `Win`/`Loss` und die zweite für die
Zwischenphasen. Gewonnen und verloren zugleich ist kein Datenzustand, den
eine Regel auflösen sollte.

---

## 7. Präfixvergleich: wann Befund B2 zuschlägt

Konkrete Zahlen statt Warnung:

```
Opp-IDs in dieser Datei:  72, alle vierstellig, Bereich 6440 – 7413
Kollisionen in dieser Datei: keine
Namensmuster: 31x "#6440",  41x "#6440 6000014096"
```

Der Suffix erklärt, warum der Flow überhaupt `startswith` benutzt — mit
Gleichheit würde er die 41 Chancen mit Zusatz nicht finden.

**Der Vergleich ist heute zufällig sicher**, weil alle IDs gleich lang sind.
Er wird unsicher, sobald die Nummern fünfstellig werden. Bei aktuell 7413 und
sequentieller Vergabe ist das eine Frage von etwa 2.600 weiteren Anfragen.
Ab dann trifft die Suche nach einer alten vierstelligen ID auch die
fünfstellige, die mit denselben Ziffern beginnt — still, ohne Fehler.

Das ist kein hypothetisches Risiko mehr, sondern ein Termin.

---

## 8. Weitere Auffälligkeiten

**Leerzeichen in Werten.** `Kontaktvorname` in **65 von 72** Zeilen mit
Leerzeichen am Ende („Erwin "), dazu `Firmaname` (8), `Kontaktemail` (4),
`Thema` (2). Ohne `trim` landen sie so im CRM. Bei der E-Mail ist es kritisch,
weil sie als Schlüssel dient — `trim|lower` ist Pflicht.

**Gemischte Typen.** Excel liefert je Zelle mal `int`, mal `float`, mal
`str`:

| Spalte | Auffälligkeit |
|---|---|
| `Zeichnungsnummer` | Zahl **und** Text: `226223114`, aber auch `4550A-A2803:002A0`, `X52620200181` ⇒ **Zielfeld muss Text sein**, niemals Zahl |
| `Material` | 1 Wert ist die Zahl `514.79` statt einer Werkstoffbezeichnung ⇒ Datenfehler in der Quelle |
| Beträge | `int`/`float` gemischt, unkritisch bei sauberer Umwandlung |

**Maße meist null.** `Länge`, `Breite`, `Höhe`: nur **9 von 206** Zeilen
haben Werte ungleich 0. Die 0 ist hier „nicht erfasst", nicht „null Millimeter".
Empfehlung: 0 bei den Maßen als leer behandeln, sonst stehen im CRM 197
Bauteile mit 0 mm Kantenlänge.

**`Wahrscheinlichkeit` ist konstant 1** in allen 72 Zeilen. In Dataverse ist
`closeprobability` ein Prozentwert 0–100. Der Import schreibt also überall
1 %. Ob gewollt oder ein Rest — zu klären.

**`Preisliste`** hat genau einen Wert: `Default Price List für
Verkaufschancenprodukte`. Konstante, kein Mapping nötig.

**Leere Spalten.** `Zeitrahmen Einkauf`, `Währung`, `Kaufvorgang`,
`Kundenbedarf`, `Laufzeit`, `Potentieller Cross Seller`, `Name`,
`Verkaufschance` — durchgängig leer. `Verkaufschance` ist die Hilfsspalte, die
der Flow selbst befüllt; sie entfällt mit der Hilfsmappe.

**`Währung` ist leer**, der Flow verdrahtet die GUID fest (B9). Solange die
Spalte leer bleibt, braucht es eine konfigurierte Standardwährung — der
ISO-Code gehört in die Laufzeitkonfiguration, nicht in den Code.

---

## 9. Was daraus für den Import folgt

| Nr | Regel | Grund |
|---|---|---|
| R1 | Kopfzeilen beim Einlesen normalisieren (trimmen) | §2 |
| R2 | Kontaktschlüssel ist E-Mail **+ Firma**, Sammeladressen ohne Kontakt | §1 |
| R3 | Besitzer aus `Mitarbeiter` der ersten Position; nicht auflösbar ⇒ Warnung, kein Abbruch | §5 |
| R4 | `estimatedclosedate` aus `Voraussichtliches Abschlussdatum` | §4 |
| R5 | `Zeichnungsnummer` als **Text** übernehmen | §8 |
| R6 | 0 bei Maßen als leer behandeln | §8 |
| R7 | Statuskonflikt je Verkaufschance im Prüflauf melden | §6 |
| R8 | Alternativschlüssel an `opportunity` statt `startswith` | §7 |
| R9 | Standardwährung als ISO-Code konfigurieren | §8 |

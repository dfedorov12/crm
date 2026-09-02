# Review: CRM-Anbindung und Verarbeitungsreihenfolge

Gezielte Prüfung des Entwurfs gegen die Dataverse-Web-API und gegen die
Daten aus `Anfragen_2026-08-27.xlsx`. **Zwölf Befunde, davon fünf, die den
ersten Lauf zum Scheitern gebracht hätten.**

---

# Teil A — Anbindung

## A1 — Der zusammengesetzte Kontaktschlüssel funktioniert so nicht

Ich hatte nach der Datenanalyse `AlternateKey: emailaddress1,parentcustomerid`
gesetzt. Drei Gründe, warum das nicht trägt:

**Erstens:** `parentcustomerid` ist ein polymorpher Customer-Lookup (Konto
*oder* Kontakt). Alternativschlüssel auf polymorphen Feldern sind bestenfalls
unzuverlässig.

**Zweitens — der eigentliche Killer:** Selbst wenn es ginge, verlangt die URL
den GUID-Wert:

```
PATCH /contacts(emailaddress1='a@b.de',_parentcustomerid_value=<GUID>)
```

Man kann **keinen Alternativschlüssel in einen Alternativschlüssel
verschachteln**. Die Konto-GUID muss also ohnehin vorliegen. Damit ist mein
Argument „über Alternativschlüssel brauchen wir keine GUID-Auflösung" für
Kontakte hinfällig.

**Drittens:** Microsoft dokumentiert ausdrücklich, dass Schlüsselwerte
**nicht in den Rumpf** der Anfrage gehören. Mein Mapping markiert sie mit
`IsKey: true` und hätte sie zusätzlich mitgesendet.

**Korrektur:** Kein Alternativschlüssel für Kontakte. Stattdessen in der
Auflösungsphase (siehe B1) einmalig per `$filter` über E-Mail und
`_parentcustomerid_value` suchen, dann gezielt `POST` oder `PATCH` über die
GUID. Deterministisch, ohne Abhängigkeit von Schlüsselunterstützung.

## A2 — Sonderzeichen brechen Alternativschlüssel-URLs

Aus der Dokumentation: enthält ein Schlüsselwert eines der Zeichen
`/ < > * % & : \ ? +`, funktionieren `GET`, `PATCH` und Upsert **nicht**.

Prüfung gegen die echten Daten:

| Schlüssel | Werte | Bewertung |
|---|---|---|
| `dag_dihag_kdnr` | `99900245` numerisch | sicher |
| Opp-ID | `6440` numerisch | sicher |
| `emailaddress1` | in dieser Datei sauber | **`+` in einer Adresse würde brechen** |

`name+kunde@firma.de` ist eine gültige E-Mail und ein gültiger
Schlüsselwert — aber keine gültige Schlüssel-URL. Zweites Argument für A1.

**Regel:** Der Prüflauf beanstandet Schlüsselwerte mit diesen Zeichen, bevor
der Import startet.

## A3 — Geschlossene Verkaufschancen lassen sich nicht aktualisieren

In den Daten stehen **16 Positionen mit `Win` und 4 mit `Loss`**. Ist eine
Verkaufschance im CRM bereits geschlossen (`statecode` 1 oder 2), ist sie
schreibgeschützt. Jedes `PATCH` schlägt fehl.

Mein Entwurf prüft `statecode` nirgends. Bei einer Wiederholung des Imports
nach dem ersten Abschluss wäre jede gewonnene oder verlorene Chance ein
Fehler im Bericht — und niemand wüsste warum.

**Korrektur:** Die Auflösungsphase liest `statecode` mit. Geschlossene
Chancen werden **übersprungen und gemeldet**, nicht automatisch
wiedereröffnet. Ein Wiedereröffnen (`PATCH statecode: 0`) ist möglich, ändert
aber die Vertriebshistorie — das ist eine fachliche Entscheidung, keine
Vorgabe des Importwerkzeugs.

## A4 — `Win` und `Loss` sind keine Feldzuweisungen

Damit zusammenhängend, aber eigenständig: Eine Verkaufschance schließt man
nicht per `PATCH` auf `statecode`, sondern über die Aktionen
**`WinOpportunity`** bzw. **`LoseOpportunity`** mit einer
`opportunityclose`-Aktivität.

```
POST /api/data/v9.2/WinOpportunity
{ "OpportunityClose": { "opportunityid@odata.bind": "/opportunities(<GUID>)",
                        "actualend": "...", "actualrevenue": ... },
  "Status": 3 }
```

Microsoft rät ausdrücklich davon ab, `statecode`/`statuscode` direkt zu
setzen: Es entsteht keine Abschlussaktivität und Rollups brechen.

**Konsequenz für den Entwurf:** `Status` ist keine Spalte, die man auf ein
Feld abbildet. Es ist ein **eigener Schritttyp**. Das erklärt auch, warum
das Feld im Altflow nirgends landet.

## A5 — `Status` mischt zwei verschiedene Konzepte

Die fünf Werte in den Daten zerfallen in zwei Gruppen:

| Wert | Anzahl | Was es ist |
|---|---|---|
| Check Feasibility – Machbarkeit prüfen | 47 | **Phase** im Vertriebsprozess |
| Develop And Submit Proposal | 21 | **Phase** |
| Negotiate and Close / Verhandeln Und Abschließen | 118 | **Phase** |
| Win | 16 | **Abschluss** (Aktion) |
| Loss | 4 | **Abschluss** (Aktion) |

Das sind die Standardphasen des Dynamics-Vertriebsprozesses plus zwei
Abschlusszustände. Zwei Mechanismen in einer Spalte:

- Phasen ⇒ `activestageid` an der Prozessinstanz (`opportunitysalesprocess`)
- Win/Loss ⇒ Aktion `WinOpportunity` / `LoseOpportunity`

**Das erklärt den Konflikt aus der Datenanalyse.** Opp 6889 hat `Loss` und
`Win` — das sind nicht zwei widersprüchliche Phasen, sondern zwei
Abschlussaktionen. Und die neun Chancen mit gemischten Phasen sind schlicht
Positionen unterschiedlichen Reifegrads.

Neue Empfehlung für die Konfliktregel: **Abschlusszustände schlagen Phasen.**
Steht an irgendeiner Position `Win` oder `Loss`, ist die Chance
abzuschließen. Stehen beide, ist es ein echter Datenfehler und gehört in den
Prüfbericht. Bei reinen Phasenkonflikten gewinnt die weiteste.

## A6 — `estimatedvalue` ist womöglich systemberechnet

Die Verkaufschance in Dynamics kennt zwei Umsatzmodi: benutzerdefiniert oder
systemberechnet aus den Positionen (`isrevenuesystemcalculated`). Bei
systemberechnet ist `estimatedvalue` **schreibgeschützt**.

Wir schreiben beides: `estimatedvalue` aus `Voaussichtlicher Umsatz` **und**
die Positionen. Das ist ein direkter Widerspruch, falls der Modus auf
systemberechnet steht.

**Zu klären**, bevor gebaut wird. Andernfalls wird der Umsatz still ignoriert
und im Protokoll steht trotzdem „aktualisiert".

## A7 — Die Preisliste wird gebraucht, aber nirgends gesetzt

`Preisliste` hat genau einen Wert: `Default Price List für
Verkaufschancenprodukte`. In meinem Profil steht sie auf `KLAEREN`,
`Active: false`.

Positionen an einer Verkaufschance brauchen in Dynamics in aller Regel eine
Preisliste am Elterndatensatz (`opportunity.pricelevelid`). Ist sie nicht
gesetzt, schlägt Schritt 40 fehl.

Das ist mit hoher Wahrscheinlichkeit das Ziel dieser Spalte — und die
einzige der offenen Spalten, die einen Schritt blockieren kann statt nur
Daten zu verlieren.

## A8 — Positionen ohne Produktbezug

Die Positionen tragen keinen Produktverweis: Spalte `Name` ist leer, es gibt
keine Artikelnummer. In Dynamics sind das Freitextpositionen, die
üblicherweise `isproductoverridden = true` und eine Bezeichnung
(`productdescription`) verlangen. Der Altflow setzt beides nicht.

Entweder toleriert die Umgebung das, oder die Positionen entstehen ohne
Bezeichnung. Beim Neubau explizit setzen statt darauf zu hoffen.

---

# Teil B — Reihenfolge und Prüfung

## B1 — Es fehlt die Auflösungsphase, obwohl alles davon abhängt

**Der wichtigste Befund dieses Reviews.**

Mein Entwurf hat fünf Schreibschritte und verlässt sich darauf, dass der
Upsert die Existenzprüfung implizit miterledigt. Das ist an drei Stellen
falsch:

**Der Prüflauf kann nicht sagen, was passieren wird.** „12 neu, 60
Aktualisierungen, 3 Konflikte" ist die einzig nützliche Aussage eines
Prüflaufs — und ohne vorherige Abfrage nicht möglich.

**Das Protokoll kann `angelegt` nicht von `aktualisiert` unterscheiden.**
Dataverse antwortet auf einen Upsert per `PATCH` mit `204 No Content`,
unabhängig davon, ob angelegt oder aktualisiert wurde. Die Unterscheidung aus
dem Statuscode abzuleiten, funktioniert nicht.

**`unveraendert` ist gar nicht feststellbar**, ohne die aktuellen Werte zu
kennen. Ohne diese Ebene meldet jeder Lauf 72 Aktualisierungen, auch wenn
sich nichts geändert hat.

**Korrektur — neue Phase 0 vor allen Schreibzugriffen:**

| Abfrage | Menge in dieser Datei | Ergebnis |
|---|---|---|
| `accounts` über `dag_dihag_kdnr` | 47 verschieden | Nummer → GUID |
| `systemusers` über `internalemailaddress` | 6 | E-Mail → GUID |
| `transactioncurrencies` über ISO-Code | 1 | Code → GUID |
| `contacts` über E-Mail + Konto | 53 | Paar → GUID |
| `opportunities` über Opp-ID, **inkl. `statecode` und aller Zielfelder** | 72 | ID → GUID, Zustand, Istwerte |
| `opportunityproducts` über Chancen-GUIDs | — | für den Ersetzungsschritt |

Sechs Sammelabfragen statt hunderter Einzelaufrufe. Umgesetzt mit
`Microsoft.Dynamics.CRM.In`, in Blöcken, wegen der URL-Längenbegrenzung:

```
$filter=Microsoft.Dynamics.CRM.In(PropertyName='dag_dihag_kdnr',
                                  PropertyValues=['99900245','99900051',...])
```

Danach steht **vor dem ersten Schreibzugriff** fest: was existiert, was
geschlossen ist, was sich tatsächlich ändert.

## B2 — Jedes Feld wird bei jedem Lauf überschrieben

Mein Entwurf kennt keine Unterscheidung zwischen „beim Anlegen setzen" und
„immer setzen". Alles wird immer geschrieben. Das zerstört CRM-Pflege:

| Feld | Problem |
|---|---|
| `ownerid` | Hat ein Vertriebler die Chance im CRM übernommen, holt der nächste Import sie zurück zum Mitarbeiter aus der Datei |
| `name` | Ein im CRM korrigierter Name wird durch `#6440 6000014096` ersetzt |
| `parentcontactid` | Ein im CRM gepflegter Ansprechpartner weicht dem aus der Datei |

**Korrektur — `WritePolicy` je Feld:**

| Wert | Verhalten |
|---|---|
| `Always` | bei Anlage und Aktualisierung |
| `OnCreateOnly` | nur bei Anlage, danach gehört das Feld dem CRM |
| `OnlyIfEmpty` | nur schreiben, wenn im CRM leer |

Vorschlag: `estimatedvalue`, `estimatedclosedate`, `closeprobability` →
`Always` (das sind die Fachdaten aus der Quelle). `name`, `ownerid`,
`parentcontactid` → `OnCreateOnly`. Endgültig ist das eine fachliche
Festlegung.

Ohne diese Unterscheidung ist der Import kein Abgleich, sondern ein
Überschreiben.

## B3 — Ein unbekanntes Konto bricht den ganzen Lauf ab

Schritt 10 stand auf `StopOnError: true`. Eine einzige unbekannte
Kundennummer hätte den kompletten Import verhindert — auch für die 71
Anfragen, die in Ordnung sind.

**Korrektur:** Fehler in einem `LookupOnly`-Schritt wirken **zeilenweise**.
Die betroffene Zeile wird als ausgeschlossen markiert und in allen
Folgeschritten übersprungen, der Lauf läuft weiter. Nur strukturelle Fehler
— fehlendes Blatt, fehlende Pflichtspalte, kein Zugriff — brechen ab.

## B4 — Ersetzungsschritt ignoriert geschlossene Chancen

An einer geschlossenen Verkaufschance lassen sich keine Positionen anlegen
oder löschen. Schritt 40 muss den `statecode` aus Phase 0 auswerten und
solche Chancen überspringen — sonst löscht der Ersetzungsschritt im
schlimmsten Fall die alten Positionen und scheitert beim Neuanlegen.

Das ist Befund B3 der Bestandsanalyse in neuem Gewand: Löschen vor
gesichertem Schreiben.

## B5 — Wiederholung nach Zeitüberschreitung kann duplizieren

Bei `429` ist die Wiederholung unbedenklich: Die Anfrage wurde abgewiesen,
bevor sie wirkte. Bei **Zeitüberschreitung oder `5xx`** ist das anders — die
Anfrage kann angekommen und ausgeführt worden sein, nur die Antwort ging
verloren.

Für Upserts ist das egal, sie sind idempotent. Für die reinen `POST` in
Schritt 40 und 50 **nicht**: Eine Wiederholung legt den Datensatz ein zweites
Mal an.

**Regel:** `429` ⇒ direkt wiederholen. Zeitüberschreitung oder `5xx` bei
einem `POST` ⇒ erst nachfragen, ob der Datensatz existiert, dann entscheiden.

## B6 — Prozessinstanz wird möglicherweise doppelt angelegt

Schritt 50 legt eine `opportunitysalesprocess`-Instanz an. Dataverse erzeugt
Prozessinstanzen beim Anlegen eines Datensatzes normalerweise **selbst**.
`CreateIfMissing` fängt das nur ab, wenn vorher geprüft wird — also gehört
auch diese Abfrage in Phase 0.

Und in Verbindung mit A5: Der eigentliche Zweck ist vermutlich nicht das
Anlegen, sondern das Setzen der Phase (`activestageid`) aus der
Status-Spalte.

---

# Teil C — Neue Schrittfolge

Aus alledem:

| Phase | Was | Schreibt |
|---|---|---|
| **0** | **Auflösen** — 6 Sammelabfragen, Existenz und Istwerte feststellen | nein |
| **P** | **Prüflauf** — Validierung, Konflikte, Vorschau „x neu, y geändert, z unverändert" | nein |
| 10 | Konten zuordnen (aus Phase 0) | nein |
| 20 | Kontakte anlegen/aktualisieren | ja |
| 30 | Verkaufschancen anlegen/aktualisieren, geschlossene überspringen | ja |
| 40 | Positionen ersetzen, je Chance ein Changeset | ja |
| 50 | Vertriebsprozess: Phase setzen | ja |
| 60 | **Abschlüsse** — `WinOpportunity` / `LoseOpportunity` | ja |
| **L** | **Protokoll** nach SharePoint, Datei markieren | ja |

Zwei Änderungen gegenüber vorher: Phase 0 ist neu und trägt die
Existenzprüfung. Und die Abschlüsse sind ein eigener Schritt **ganz am
Ende** — sonst würde eine Chance geschlossen, bevor ihre Positionen
geschrieben sind, und der Rest scheitert an A3.

---

# Offene Fragen aus diesem Review

1. Steht der Umsatzmodus der Verkaufschance auf systemberechnet? (A6)
2. Gehört `Preisliste` auf `opportunity.pricelevelid`? (A7)
3. Sollen `Win`/`Loss` überhaupt importiert werden, oder wird im CRM
   abgeschlossen? Falls importiert: bereits geschlossene Chancen
   überspringen oder wiedereröffnen? (A3, A4)
4. Welche Felder sind `OnCreateOnly`? Vorschlag oben, Bestätigung nötig. (B2)
5. Legen die Positionen Freitextprodukte an, und mit welcher Bezeichnung? (A8)

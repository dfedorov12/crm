# Dataverse vorbereiten

Ohne diese Vorarbeit ist ein wiederholbarer Import nicht möglich. Das ist der
zweite Block, der unabhängig von den Excel-Dateien erledigt werden kann.

---

## 1. Alternativschlüssel — die wichtigste Vorbereitung

Ein Import ohne Alternativschlüssel läuft so ab: Zeile lesen, `POST`, neuer
Datensatz. Zweiter Lauf derselben Datei: alle Datensätze noch einmal. 400
Konten werden zu 800.

Mit Alternativschlüssel:

```
PATCH /api/data/v9.2/accounts(dag_dihag_kdnr=10042)
```

Vorhanden ⇒ aktualisieren. Nicht vorhanden ⇒ anlegen. Der Lauf ist beliebig
oft wiederholbar und liefert immer dasselbe Ergebnis. Genau das braucht man,
wenn der erste Versuch nach 3.000 von 8.000 Zeilen abbricht.

### Anlegen

Power Apps ▸ Tabellen ▸ *Verkaufschance* ▸ Schlüssel ▸ **Neuer Schlüssel**

Das Schlüsselfeld selbst muss vorher als Spalte existieren, eindeutig
befüllbar und stabil sein.

### Was für DIHAG konkret gebraucht wird

| Tabelle | Schlüsselfeld | Quelle in Excel | Status |
|---|---|---|---|
| `account` | `dag_dihag_kdnr` | `Firma` | Feld existiert. **Eindeutigkeit prüfen**, dann Schlüssel anlegen. |
| `opportunity` | **offen** | `Opp-ID` | Feld vermutlich nicht vorhanden — siehe unten |
| `contact` | `emailaddress1` | `Kontaktemail` | Sonderfall, siehe unten |

Andere Tabellen brauchen keinen Schlüssel: `opportunityproducts` und
`opportunitysalesprocesses` werden ausschließlich über ihre Verkaufschance
adressiert, `systemusers` und `transactioncurrencies` nur gelesen.

**`opportunity` ist der wichtigste Punkt des ganzen Projekts.** Der Altflow
findet Verkaufschancen über `startswith(name, '#<Opp-ID>')` — einen
Präfixvergleich auf dem Namen (Befund B2). Solange es kein eigenes Feld für
die Opp-ID gibt, ist das nicht sauber zu ersetzen. Zu klären:

- Gibt es an `opportunity` bereits ein Feld für die Opp-ID? Dann dessen
  logischen Namen ins Profil eintragen.
- Falls nicht: Textspalte anlegen, z. B. `dag_oppid`, aus den Bestandsdaten
  befüllen (Präfix `#` aus `name` extrahieren), Alternativschlüssel darauf.

Die Nachbefüllung der Bestandsdaten ist ein einmaliger Schritt und sollte
vor dem ersten Lauf der neuen App passieren. Sonst legt sie Verkaufschancen
neu an, die längst existieren.

**`contact` über `emailaddress1` ist ein Kompromiss.** Das Feld ist in
Dataverse nicht eindeutig, und für einen Alternativschlüssel muss es das
sein. Zwei Wege:

1. Alternativschlüssel auf `emailaddress1` anlegen. Setzt voraus, dass es im
   Bestand **keine** doppelten E-Mail-Adressen gibt — sonst bleibt der
   Schlüssel auf `Fehlgeschlagen` stehen. Vorher prüfen.
2. Ohne Schlüssel arbeiten: die App sucht per `$filter` wie der Altflow und
   entscheidet selbst. Langsamer und nicht atomar, aber ohne Voraussetzung.

Weg 1 ist sauberer, Weg 2 sicher machbar. Die Entscheidung hängt allein am
Ergebnis der Dublettenprüfung im Bestand.

### Was einen guten Schlüssel ausmacht

- **Stabil.** Er darf sich in der Quelle nie ändern. Eine Kundennummer ist
  gut, eine E-Mail-Adresse ist es nicht — die wechselt bei Namensänderung
  oder Arbeitgeberwechsel und legt dann stillschweigend einen zweiten
  Datensatz an. Genau das ist der Grund, warum `contact` oben ein Sonderfall
  bleibt: Es gibt derzeit nichts Besseres als die E-Mail.
- **Eindeutig.** Vorher in Excel prüfen. Zwei gleiche Werte lassen den
  Schlüssel auf `Fehlgeschlagen` laufen, ohne dass klar wird, warum.
- **Vorhanden.** Zeilen ohne Schlüsselwert sind nicht importierbar. Sie
  müssen im Prüflauf auffallen, nicht im Import.

Wenn die Quelldaten keine solche Nummer mitbringen, ist ein zusammengesetzter
Schlüssel möglich (z. B. Name + PLZ). Das ist aber deutlich fehleranfälliger
— jede Schreibweisenabweichung erzeugt einen neuen Datensatz. Lieber vorher
eine Nummer im Quellsystem einführen.

### Nach dem Anlegen

Der Schlüsselstatus muss auf **Aktiv** stehen. Dataverse baut im Hintergrund
einen Index; bei großen Tabellen dauert das. Solange der Status
`Ausstehend` ist, funktioniert der Upsert nicht.

---

## 2. Importreihenfolge

Die Reihenfolge steht in `CRM_ImportProfiles.Step`, nicht im Code. Diese
Tabelle ist die fachliche Begründung dahinter.

| Step | Tabelle | Wartet auf | Warum |
|---|---|---|---|
| 10 | Währungen, Preislisten, eigene Stammdaten | — | werden von allem anderen referenziert |
| 20 | `accounts` (1. Durchlauf) | — | ohne `parentaccountid`, ohne `primarycontactid` |
| 30 | `contacts` | Konten | `parentcustomerid` zeigt auf ein Konto |
| 40 | `accounts` (2. Durchlauf) | Konten, Kontakte | trägt jetzt die Verweise nach |
| 50 | `leads` | — | frei stehend |
| 60 | `opportunities` | Konten, Kontakte | `customerid` ist polymorph |
| 70 | Positionen, Angebote | Chancen, Produkte | |
| 80 | Aktivitäten | alles darüber | `regardingobjectid` polymorph |
| 90 | `annotations` | alles darüber | Anlagen als base64 |

### Warum Konten zweimal laufen

Zwei kreisförmige Abhängigkeiten:

1. **Konto ↔ Kontakt.** Das Konto verweist über `primarycontactid` auf seinen
   Hauptansprechpartner. Der Kontakt verweist über `parentcustomerid` zurück
   auf das Konto. Was zuerst?
2. **Konto ↔ Konto.** Eine Tochtergesellschaft verweist über
   `parentaccountid` auf die Mutter. Steht die Mutter in der Excel-Datei
   weiter unten, existiert sie beim Anlegen der Tochter noch nicht.

Beides ist in einem Durchlauf nicht lösbar. Deshalb: erst alle Konten ohne
Verweise anlegen, dann Kontakte, dann alle Verweise in einem reinen
Update-Lauf nachtragen.

Im Profil: `SecondPass = Ja`, `SecondPassFields =
parentaccountid,primarycontactid`. Der Planer erzeugt den zweiten Schritt
daraus automatisch und sendet dort **ausschließlich** diese Felder — sonst
würden bereits gepflegte CRM-Daten mit Excel-Ständen überschrieben.

---

## 3. Fallstricke

### Dublettenerkennung

Dataverse unterdrückt Dublettenregeln bei API-Aufrufen standardmäßig. Wer sie
laufen lassen will, sendet:

```
MSCRM.SuppressDuplicateDetection: false
```

Dann werden Dubletten mit einem Fehler abgelehnt statt angelegt. Bei einem
Erstimport oft erwünscht, bei einem wiederholten Lauf über Alternativschlüssel
eher hinderlich. Steuerbar über `suppressDuplicateDetection` in der
Laufzeitkonfiguration.

### Prozesse und Plug-ins

Jeder Datensatz löst Workflows, Power Automate Flows, Business Rules und
Plug-ins aus. Bei 8.000 Datensätzen bedeutet das:

- die Ausführungszeit der Plug-ins zählt auf das 1.200-Sekunden-Limit
- Zuordnungsregeln verteilen Datensätze auf Warteschlangen
- Benachrichtigungs-Flows verschicken womöglich tausende E-Mails

**Vor dem ersten Produktivimport prüfen, welche Prozesse auf den Zieltabellen
aktiv sind**, und die nicht benötigten für die Dauer des Imports deaktivieren.
Das ist keine Feinheit. Ein Willkommens-Flow, der 8.000 Mails an echte Kunden
schickt, ist nicht zurücknehmbar.

### Statusfelder

`statecode` und `statuscode` lassen sich beim Anlegen nicht frei setzen. Ein
Datensatz entsteht aktiv; die Deaktivierung ist ein separater Update-Aufruf
danach. Wenn inaktive Datensätze importiert werden sollen, braucht es dafür
einen eigenen Schritt am Ende des Profils.

### Besitzer

Ohne `ownerid` gehört der Datensatz dem importierenden Benutzer. Soll der
echte Betreuer eingetragen werden, muss `ownerid` gesetzt werden — polymorph
über `ownerid_systemuser@odata.bind` oder `ownerid_team@odata.bind`. Der
Benutzer braucht dafür das Recht *Zuweisen* auf der Tabelle.

### Feldlängen

Dataverse schneidet zu lange Texte nicht ab, sondern lehnt den Datensatz mit
`400` ab. Die Maximallänge gehört deshalb ins Feldmapping (`MaxLength`) und
in den Prüflauf, nicht in den Fehlerbericht nach 2.000 abgelehnten Zeilen.

---

## 4. Testumgebung

Entwicklung und Abnahme laufen in der bestehenden Testumgebung — dort, wo
auch der Altflow arbeitet (`TestumgebungExpImpCRMTimeline`).

Zwei Dinge, die daraus folgen:

**Der Altflow und die neue App teilen sich die Umgebung.** Solange beide
aktiv sind, ist bei einem Vergleichslauf nicht zuzuordnen, welche Datensätze
woher stammen. Für die Abnahme den Flow kurz abschalten.

**Befund B1 hat die Umgebung möglicherweise schon verunreinigt.** Die
verschachtelte Schleife legt Verkaufschancen im Kreuzprodukt an. Wenn die
Testumgebung die Vergleichsgrundlage sein soll, muss das vorher bereinigt
sein — sonst wird gegen einen falschen Sollstand geprüft.

Für die Abnahme reicht ein Auszug von 20–50 Zeilen. Das deckt Zuordnungs- und
Reihenfolgefehler zuverlässig auf und läuft in Sekunden.

**Für den späteren Produktivgang** ist außer `dataverseUrl` nichts
umzustellen — vorausgesetzt, die fest verdrahteten Werte aus Befund B9
(Währungs-GUID, Bibliotheks-GUID) sind bis dahin durch Namen und ISO-Codes
ersetzt. Genau daran scheitern Power-Automate-Flows beim Umzug regelmäßig.

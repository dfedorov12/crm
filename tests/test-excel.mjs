/* Einlesen von Arbeitsmappen – die Teile, die stumm Daten kosten.
   ---------------------------------------------------------------
   Geprüft wird `blattAus`, also die Umsetzung von Rohzeilen in Zeilenobjekte.
   Sie braucht weder SheetJS noch einen Browser, und genau hier stecken die
   beiden Fehler, die man erst Wochen später bemerkt: eine nicht getroffene
   Kopfzeile und eine falsche Zeilennummer im Fehlerbericht.

   Die Testfälle stammen aus der echten Datei (docs/06-datenanalyse.md).   */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const wurzel = join(dirname(fileURLToPath(import.meta.url)), "..");
const quelle = readFileSync(join(wurzel, "js/excel.js"), "utf8");

// js/excel.js fasst beim Laden weder document noch XLSX an – deshalb lässt
// sich das Modul hier direkt auswerten.
const EXCEL = new Function(quelle + "; return EXCEL;")();

let fehler = 0;
function pruefe(bedingung, text) {
  console.log(`  ${bedingung ? "ok  " : "FEHL"}  ${text}`);
  if (!bedingung) fehler++;
}
const gleich = (a, b, text) =>
  pruefe(JSON.stringify(a) === JSON.stringify(b),
    `${text}${JSON.stringify(a) === JSON.stringify(b) ? "" : `  (erwartet ${JSON.stringify(b)}, war ${JSON.stringify(a)})`}`);

/* ── Kopfzeilen normalisieren ──────────────────────────────────────── */

console.log("\nKopfzeilen");
const NBSP = String.fromCharCode(0xa0);
gleich(EXCEL.normKopf("Breite (mm) "), "Breite (mm)", "Leerzeichen am Ende weg (echter Fall)");
gleich(EXCEL.normKopf("  Opp-ID  "), "Opp-ID", "Leerzeichen aussen weg");
gleich(EXCEL.normKopf("MTZ  absolut"), "MTZ absolut", "Mehrfach-Leerzeichen innen zusammengezogen");
gleich(EXCEL.normKopf("Höhe" + NBSP + "(mm)"), "Höhe (mm)", "geschütztes Leerzeichen wie normales");
gleich(EXCEL.normKopf("Firma"), "Firma", "sauberer Name bleibt unverändert");
gleich(EXCEL.normKopf(null), "", "null wird Leerstring, nicht \"null\"");

/* ── Zeilenobjekte ─────────────────────────────────────────────────── */

console.log("\nZeilen und Zeilennummern");

// Nachgebaut nach der echten Mappe: Leerzeichen am Ende in zwei Kopfzeilen,
// eine komplett leere Zeile mittendrin, gemischte Typen.
const roh = [
  ["Opp-ID", "Breite (mm) ", "Höhe (mm) ", "Zeichnungsnummer"],   // Excel-Zeile 1
  [6440, 0, 0, 226223114],                                        // Zeile 2
  [6441, 120, 80, "4550A-A2803:002A0"],                           // Zeile 3
  [null, null, null, null],                                       // Zeile 4 – leer
  [6443, 0, 0, "X52620200181"]                                    // Zeile 5
];
const b = EXCEL.blattAus("Positionen", roh);

gleich(b.anzahl, 3, "leere Zeile wird nicht als Datenzeile gezählt");
gleich(b.zeilen.map(z => z._zeile), [2, 3, 5],
  "Zeilennummern wie in Excel – die leere Zeile 4 verschiebt nichts");
gleich(b.kopfzeilen, ["Opp-ID", "Breite (mm)", "Höhe (mm)", "Zeichnungsnummer"],
  "Kopfzeilen normalisiert");
gleich(b.normalisiert.map(n => n.normal), ["Breite (mm)", "Höhe (mm)"],
  "normalisierte Kopfzeilen werden gemeldet");
pruefe(b.zeilen[1]["Breite (mm)"] === 120,
  "Wert ist über den NORMALISIERTEN Namen erreichbar – hier scheitert der Altflow");
pruefe(b.zeilen[0]["Zeichnungsnummer"] === 226223114
    && b.zeilen[1]["Zeichnungsnummer"] === "4550A-A2803:002A0",
  "Zeichnungsnummer bleibt roh: mal Zahl, mal Text (Zielfeld MUSS Text sein)");

/* ── Sonderfälle ───────────────────────────────────────────────────── */

console.log("\nSonderfälle");
const leer = EXCEL.blattAus("Leer", []);
gleich(leer.anzahl, 0, "leeres Blatt liefert 0 Zeilen statt zu werfen");

const nurKopf = EXCEL.blattAus("NurKopf", [["A", "B"]]);
gleich(nurKopf.anzahl, 0, "Blatt mit nur einer Kopfzeile liefert 0 Zeilen");

const dopp = EXCEL.blattAus("Doppelt", [["Firma", "Firma", "Ort"], [1, 2, "Herne"]]);
gleich(dopp.doppelt, ["Firma"], "doppelter Spaltenname wird gemeldet");
gleich(dopp.zeilen[0]["Firma"], 2, "bei Doppelung gewinnt die letzte Spalte – deshalb die Meldung");

const luecke = EXCEL.blattAus("Luecke", [["A", "", "C"], [1, 9, 3]]);
gleich(luecke.kopfzeilen, ["A", "C"], "Spalte ohne Überschrift wird ignoriert");
gleich(Object.keys(luecke.zeilen[0]), ["_zeile", "A", "C"],
  "Wert unter leerer Überschrift landet nicht im Zeilenobjekt");

console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen.\n` : "\nAlle Prüfungen bestanden.\n");
process.exit(fehler ? 1 : 0);

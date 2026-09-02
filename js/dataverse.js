"use strict";

/* Dataverse Web API.

   Stand: Phase 2. Enthält den Grundzugriff samt Drosselungsbehandlung und
   die WhoAmI-Probe. Auflösungsphase (Phase 0), Batch und Upsert über
   Alternativschlüssel folgen in Phase 5 und 6 – siehe CLAUDE.md §7 und §8.

   Der Aufruf läuft mit einem eigenen Token: user_impersonation gegen die
   Organisations-URL, nicht gegen Graph. Es gelten die CRM-Rechte des
   angemeldeten Benutzers – wer dort nichts anlegen darf, kann es auch über
   diese App nicht.                                                        */

const DV = (() => {

  const warte = ms => new Promise(r => setTimeout(r, ms));

  const basis = () => CRM_CONFIG.dataverseUrl.replace(/\/+$/, "")
    + "/api/data/" + CRM_CONFIG.apiVersion;

  /** Ist die Organisations-URL überhaupt gesetzt? Ohne sie hat ein Aufruf
   *  keinen Sinn, und die Meldung soll das sagen – statt eines
   *  Netzwerkfehlers gegen „https://<org>.crm4.dynamics.com“. */
  function pruefeKonfiguration() {
    if (istOffen(CRM_CONFIG.dataverseUrl)) {
      const e = new Error("dataverseUrl ist in js/config.js noch nicht gesetzt. "
        + "Die URL der Testumgebung steht im Altflow nur in der Verbindung "
        + "und muss einmal nachgetragen werden (CLAUDE.md §13).");
      e.code = "KONFIGURATION_OFFEN";
      throw e;
    }
  }

  /** Ein Aufruf gegen die Web API.
   *
   *  Wiederholungsregeln aus CLAUDE.md §7 und dem Review (B5):
   *  · 429 und 503 → exakt `Retry-After` warten, dann noch einmal.
   *  · 400, 403, 404 → nicht wiederholen. Das sind Datenfehler und gehören
   *    sofort in den Fehlerbericht.
   *  · Zeitüberschreitung oder 5xx bei einem POST → NICHT blind wiederholen.
   *    Die Anfrage kann angekommen sein und nur die Antwort verloren
   *    gegangen. Deshalb wird hier nur bei GET und PATCH wiederholt; PATCH
   *    ist als Upsert idempotent. */
  async function call(pfad, opts = {}, versuch = 0) {
    pruefeKonfiguration();
    const token = await AUTH.getToken("dataverse");
    const url = pfad.startsWith("https://") ? pfad : basis() + pfad;
    const methode = (opts.method || "GET").toUpperCase();

    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        ...(opts.headers || {})
      }
    });

    const wiederholbar = methode === "GET" || methode === "PATCH";
    if ((res.status === 429 || (res.status >= 500 && wiederholbar)) && versuch < 4) {
      const s = Number(res.headers.get("Retry-After")) || 5;
      console.warn(`[Dataverse] ${res.status} – ${s} s warten (Versuch ${versuch + 1})`);
      await warte(s * 1000);
      return call(pfad, opts, versuch + 1);
    }

    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.error?.message || res.statusText || String(res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.code = data?.error?.code;
      err.request = methode + " " + pfad;
      err.detail = `${err.request} → HTTP ${res.status}`
        + (err.code ? ` ${err.code}` : "") + `: ${msg}`;
      throw err;
    }
    return data;
  }

  /** Funktionsprobe nach docs/01 §4.
   *
   *  Sie testet in einem Aufruf drei Dinge auf einmal: ob der Token für die
   *  richtige Ressource ausgestellt ist, ob CORS und die SPA-Plattform
   *  stimmen, und ob der Benutzer im Environment überhaupt existiert.
   *
   *  200 → alles korrekt
   *  401 → Token für die falsche Ressource; Scope prüfen
   *  403 → Benutzer nicht im Environment oder ohne Sicherheitsrolle
   *  CORS-Fehler → Umleitungs-URI oder Plattformtyp falsch, oder es greift
   *                eine Richtlinie für bedingten Zugriff
   *
   *  @returns {Promise<{UserId:string, BusinessUnitId:string, OrganizationId:string}>} */
  const whoAmI = () => call("/WhoAmI");

  return { call, whoAmI, basis, pruefeKonfiguration };
})();

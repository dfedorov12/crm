"use strict";

/* Anmeldung – OAuth2 Authorization Code Flow mit PKCE, ohne MSAL-Bibliothek.
   Übernommen aus „Rund um den Job“, erweitert um zwei Ressourcen.

   ABLAUF
   1. Token im sessionStorage?          → sofort weiter
   2. Sonst stiller SSO-Versuch (prompt=none) über einen Redirect. Da alle
      Nutzer bereits am M365-Tenant angemeldet sind, kommt der Browser ohne
      jede Interaktion mit einem Code zurück.
   3. Schlägt das fehl (login_required / interaction_required / mehrere
      Konten), wird automatisch die interaktive Anmeldung gestartet.
   4. Erst wenn auch die fehlschlägt, erscheint ein Button.

   ZWEI RESSOURCEN, EIN LOGIN
   Der v2-Endpunkt gibt ein Access-Token immer für genau EINE Ressource aus.
   Graph-Scopes und den Dataverse-Scope in dieselbe /authorize-Anfrage zu
   schreiben, scheitert. Der Refresh-Token dagegen gilt für alles, dem
   zugestimmt wurde. Also: einmal mit den Graph-Scopes anmelden, den
   Refresh-Token behalten und ihn je Ressource einlösen – derselbe Weg, den
   MSAL intern geht.

   Drei Fallstricke, die daran hängen:
   · ROTATION – jede Einlösung liefert einen neuen Refresh-Token und
     entwertet den alten. Wer den neuen nicht zurückschreibt, hat beim
     übernächsten Aufruf einen ungültigen, und der Fehler tritt zeitversetzt
     und scheinbar zufällig auf.
   · 24 STUNDEN – Refresh-Token für Single-Page-Anwendungen leben 24 h und
     lassen sich nicht darüber hinaus verlängern. Danach greift wieder der
     stille Redirect.
   · ZUSTIMMUNG – ohne Administratorzustimmung für user_impersonation
     scheitert die Einlösung für Dataverse mit interaction_required. Dann
     wird interaktiv nachgelegt, statt einen leeren Fehler zu werfen.      */

const AUTH = (() => {

  const TID = CRM_CONFIG.tenantId;
  const CID = CRM_CONFIG.clientId;

  /** Redirect-URI aus der aufgerufenen Adresse ableiten, damit dieselbe
   *  Auslieferung unter mehreren Hosts funktioniert (eigene Domäne
   *  https://crm.dihag.de/ und Fallback github.io/crm/). Ein Dateiname wird
   *  abgeschnitten und ein Schrägstrich am Ende erzwungen – sonst passt die
   *  Adresse nicht mehr zur Registrierung in Entra und der Login bricht mit
   *  AADSTS50011 ab. Genau dieser Fehler ist damit baulich ausgeschlossen.
   *
   *  Abgeschnitten wird JEDER Dateiname auf .htm/.html, nicht nur
   *  „index.html“ wie in rundumdenjob. Sonst entsteht aus
   *  /crm/tests/harness.html die URI /crm/tests/harness.html/ – heute
   *  belanglos, weil index.html der einzige Einstieg ist, aber es fällt
   *  einem beim nächsten Einstiegspunkt auf die Füße. */
  const RURI = (() => {
    let p = location.pathname.replace(/[^/]*\.html?$/i, "");
    if (!p.endsWith("/")) p += "/";
    return location.origin + p;
  })();

  const AU = `https://login.microsoftonline.com/${TID}/oauth2/v2.0/authorize`;
  const TU = `https://login.microsoftonline.com/${TID}/oauth2/v2.0/token`;

  /** Scopes je Ressource. „dataverse“ wird aus der Organisations-URL
   *  gebildet; solange die noch nicht geklärt ist, gibt es die Ressource
   *  schlicht nicht und getToken sagt das auch so. */
  function scopesFuer(res) {
    if (res === "graph") return CRM_CONFIG.scopes.slice();
    if (res === "dataverse") {
      if (istOffen(CRM_CONFIG.dataverseUrl))
        throw new Error("dataverseUrl ist in js/config.js noch nicht gesetzt "
          + "– ohne Organisations-URL gibt es keinen Dataverse-Scope.");
      return [CRM_CONFIG.dataverseUrl.replace(/\/+$/, "") + "/user_impersonation"];
    }
    throw new Error("Unbekannte Ressource: " + res);
  }

  const ss = {
    get: k => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
    del: k => { try { sessionStorage.removeItem(k); } catch {} }
  };

  const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  async function mkPKCE() {
    const v = b64(crypto.getRandomValues(new Uint8Array(32)));
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
    return { v, c: b64(d) };
  }

  /* ── Token-Ablage, je Ressource getrennt ──────────────────────────── */

  const _tok = {};   // res → { t, exp }

  const kT = res => "crm_t_" + res;
  const kE = res => "crm_e_" + res;
  const K_RT = "crm_rt";

  function speichern(res, t, exp) {
    _tok[res] = { t, exp };
    ss.set(kT(res), t);
    ss.set(kE(res), String(exp));
  }

  /** Gültiges Token aus dem Speicher, sonst null. 60 s Sicherheitspuffer. */
  function ausSpeicher(res) {
    const c = _tok[res];
    if (c && Date.now() < c.exp - 60000) return c.t;
    const t = ss.get(kT(res)), e = +ss.get(kE(res));
    if (t && Date.now() < e - 60000) { _tok[res] = { t, exp: e }; return t; }
    return null;
  }

  /* ── Refresh-Token einlösen ───────────────────────────────────────── */

  /** Refresh-Token für eine Ressource einlösen.
   *  @returns {Promise<{token?:string, fehler?:string, code?:string,
   *                     interaktion?:boolean}>}
   *
   *  Der Fehler wird durchgereicht, nicht verschluckt. Entra liefert in
   *  `error_description` den AADSTS-Code und einen Klartext, der die Ursache
   *  benennt – etwa AADSTS65001, wenn für den Dataverse-Scope keine
   *  Zustimmung erteilt wurde. Ohne das steht in der Oberfläche eine
   *  Vermutung statt des Grundes, und man sucht an der falschen Stelle. */
  async function einloesen(rt, res) {
    let scope;
    try { scope = [...scopesFuer(res), "offline_access"].join(" "); }
    catch (e) { return { fehler: e.message, code: "konfiguration" }; }

    const r = await fetch(TU, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CID,
        grant_type: "refresh_token",
        refresh_token: rt,
        scope
      }).toString()
    });
    const d = await r.json().catch(() => ({ error: "invalid_response" }));

    if (d.error || !d.access_token) {
      // invalid_grant heißt: dieser Refresh-Token ist verbraucht oder älter
      // als 24 h. Weg damit, sonst wird er endlos weiterprobiert.
      if (d.error === "invalid_grant") ss.del(K_RT);
      const roh = d.error_description || d.error || "unbekannter Fehler";
      return {
        fehler: String(roh).split(/\r?\n/)[0],   // erste Zeile, der Rest ist Ablaufspur
        code: d.error,
        // Lässt sich das durch eine interaktive Anmeldung heilen? Bei
        // fehlender Zustimmung und abgelaufener Sitzung ja; bei einer
        // fehlenden API-Berechtigung an der Registrierung nicht – dann
        // braucht es erst einen Administrator.
        interaktion: /interaction_required|consent_required|invalid_grant|AADSTS(65001|50076|50079|53)/i
          .test(String(d.error) + " " + roh)
      };
    }
    if (d.refresh_token) ss.set(K_RT, d.refresh_token);   // Rotation
    speichern(res, d.access_token, Date.now() + (d.expires_in || 3600) * 1000);
    return { token: d.access_token };
  }

  /** Access-Token für eine Ressource.
   *  @param {"graph"|"dataverse"} [res]
   *  @throws wenn nicht (mehr) angemeldet oder eine Interaktion nötig ist. */
  async function getToken(res = "graph") {
    const c = ausSpeicher(res);
    if (c) return c;

    const rt = ss.get(K_RT);
    let letzter = null;
    if (rt) {
      letzter = await einloesen(rt, res);
      if (letzter.token) return letzter.token;
    }

    const e = new Error(letzter
      ? `Kein Token für ${res} – ${letzter.fehler}`
      : `Kein Token für ${res} – es liegt kein Refresh-Token vor. `
        + "Die Sitzung ist abgelaufen, bitte neu anmelden.");
    e.code = letzter?.code || "kein_refresh_token";
    e.interaktion = letzter ? letzter.interaktion : true;
    e.res = res;
    throw e;
  }

  /** Liest die Nutzlast eines Access-Tokens aus – nur zur Diagnose. Die
   *  Signatur wird bewusst nicht geprüft, das macht die Gegenstelle.
   *  @returns {{scopes:string[], upn:string, aud:string, exp:Date|null}|null} */
  function tokenInfo(res = "graph") {
    const t = ausSpeicher(res);
    if (!t) return null;
    try {
      const p = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const json = decodeURIComponent(atob(p + "=".repeat((4 - p.length % 4) % 4))
        .split("").map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join(""));
      const d = JSON.parse(json);
      return {
        scopes: String(d.scp || "").split(" ").filter(Boolean),
        upn: d.upn || d.preferred_username || "",
        aud: d.aud || "",
        exp: d.exp ? new Date(d.exp * 1000) : null
      };
    } catch { return null; }
  }

  /* ── Anmeldung ────────────────────────────────────────────────────── */

  /** Startet den Redirect zur Anmeldeseite.
   *  @param {"none"|"select_account"|"consent"} promptMode
   *  @param {"graph"|"dataverse"} [res] Ressource, für die zugestimmt werden
   *    soll. Standard ist Graph; „dataverse“ nur als Nachschlag, wenn die
   *    Einlösung des Refresh-Tokens Zustimmung verlangt. */
  async function startLogin(promptMode, res = "graph") {
    const { v, c } = await mkPKCE();
    const state = b64(crypto.getRandomValues(new Uint8Array(16)));
    ss.set("crm_pv", v);
    ss.set("crm_ps", state);
    ss.set("crm_pm", promptMode);
    ss.set("crm_pr", res);

    const p = new URLSearchParams({
      client_id: CID,
      response_type: "code",
      redirect_uri: RURI,
      scope: [...scopesFuer(res), "offline_access"].join(" "),
      state,
      code_challenge: c,
      code_challenge_method: "S256",
      prompt: promptMode
    });
    location.href = AU + "?" + p.toString();
  }

  /** Wertet die Rückkehr vom Anmelde-Redirect aus.
   *  @returns {Promise<"ok"|"none"|"redirecting"|{error:string}>} */
  async function handleRedirect() {
    const p = new URLSearchParams(location.search);
    const code = p.get("code");
    const err  = p.get("error");
    const wasSilent = ss.get("crm_pm") === "none";
    const res = ss.get("crm_pr") || "graph";

    if (err) {
      history.replaceState({}, document.title, location.pathname);
      ss.del("crm_pm");
      // Stiller Versuch gescheitert → interaktiv nachlegen, für dieselbe
      // Ressource. Sonst käme ein Token für die falsche Gegenstelle.
      if (wasSilent) { await startLogin("select_account", res); return "redirecting"; }
      return { error: p.get("error_description") || err };
    }

    if (!code) return "none";

    if (p.get("state") !== ss.get("crm_ps")) {
      history.replaceState({}, document.title, location.pathname);
      return { error: "Ungültiger State – bitte Seite neu laden." };
    }
    const v = ss.get("crm_pv");
    if (!v) {
      history.replaceState({}, document.title, location.pathname);
      return { error: "PKCE-Verifier fehlt – bitte Seite neu laden." };
    }

    history.replaceState({}, document.title, location.pathname);

    const r = await fetch(TU, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CID,
        grant_type: "authorization_code",
        code,
        redirect_uri: RURI,
        code_verifier: v
      }).toString()
    });
    const d = await r.json().catch(() => ({ error: "Antwort nicht lesbar" }));

    ss.del("crm_pv"); ss.del("crm_ps"); ss.del("crm_pm"); ss.del("crm_pr");

    if (d.error) {
      if (wasSilent) { await startLogin("select_account", res); return "redirecting"; }
      return { error: d.error_description || d.error };
    }

    // Der Refresh-Token ist der Grund, warum ein Login für beide Ressourcen
    // reicht. rundumdenjob fordert offline_access ebenfalls an und wirft ihn
    // weg – hier wird er behalten.
    if (d.refresh_token) ss.set(K_RT, d.refresh_token);
    speichern(res, d.access_token, Date.now() + (d.expires_in || 3600) * 1000);
    return "ok";
  }

  /** Kompletter Anmelde-Ablauf beim Seitenstart.
   *  @returns {Promise<"ok"|"redirecting"|{error:string}>} */
  async function signIn() {
    // PKCE braucht crypto.subtle, und das gibt es nur im sicheren Kontext.
    // Über http:// ist es schlicht undefiniert – ohne diese Prüfung scheitert
    // die Anmeldung mit „Cannot read properties of undefined (reading
    // 'digest')“, einer Meldung, die niemanden zur Ursache führt.
    // Tritt auf, wenn die Seite über http://crm.dihag.de/ aufgerufen wird,
    // solange in den Pages-Einstellungen „Enforce HTTPS“ aus ist.
    if (!window.isSecureContext || !crypto?.subtle) {
      return { error: "Diese Seite muss über HTTPS aufgerufen werden – die "
        + "Anmeldung braucht Web Crypto, und das steht nur im sicheren Kontext "
        + "zur Verfügung. Bitte " + location.href.replace(/^http:/, "https:")
        + " verwenden." };
    }

    if (location.search.includes("code=") || location.search.includes("error=")) {
      const r = await handleRedirect();
      if (r !== "none") return r;
    }
    if (ausSpeicher("graph")) return "ok";
    const rt = ss.get(K_RT);
    if (rt && (await einloesen(rt, "graph")).token) return "ok";
    await startLogin("none");
    return "redirecting";
  }

  function logout() {
    try { sessionStorage.clear(); } catch {}
    for (const k of Object.keys(_tok)) delete _tok[k];
    location.href = `https://login.microsoftonline.com/${TID}/oauth2/v2.0/logout`
      + `?post_logout_redirect_uri=${encodeURIComponent(RURI)}`;
  }

  return { signIn, startLogin, getToken, tokenInfo, logout, redirectUri: RURI };
})();

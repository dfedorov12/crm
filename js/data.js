"use strict";

/* Benutzerkontext und Rolle.

   Die Rolle kommt aus der zentralen Liste AppPermissions auf /sites/IT –
   derselben, die rundumdenjob, powerbi und umfrage1 nutzen. Ein Eintrag mit
   App = "*" gilt app-übergreifend, App = "crm" nur hier.

   Ein Unterschied zu rundumdenjob: dort ist die Standardrolle „viewer“,
   weil jeder im Tenant das Mitarbeiterportal sehen soll. Hier ist sie
   „none“. Ein Werkzeug, das ins CRM schreibt, ist kein Portal.           */

const DATA = (() => {

  const C = CRM_CONFIG;
  const RANK = { none: 0, viewer: 1, editor: 2, admin: 3 };

  /** @type {{me:object|null, email:string, name:string, domain:string, role:string}} */
  const ctx = { me: null, email: "", name: "", domain: "", role: C.defaultRole };

  const domainOf = addr => {
    const s = String(addr || "").toLowerCase().trim();
    const i = s.lastIndexOf("@");
    return i < 0 ? "" : s.slice(i + 1);
  };

  /** Protokoll der letzten Rollenermittlung – damit „warum kein Zugriff?“
   *  beantwortbar ist, ohne im Code zu suchen. Wird in der Diagnose und im
   *  Kein-Zugriff-Schirm angezeigt. */
  const roleInfo = {
    quelle: "standard",   // hauptadmin | liste | standard
    fehler: null,         // Text, wenn die Rechteliste nicht lesbar war
    zeilen: 0,            // gelesene Einträge insgesamt
    treffer: 0,           // Einträge auf die eigene E-Mail
    passend: 0            // davon mit passender App
  };

  const istHauptAdmin = mail =>
    (C.hauptAdmins || []).map(s => String(s).toLowerCase())
      .includes(String(mail || "").toLowerCase());

  async function loadUser() {
    const me = await GRAPH.call("/me?$select=displayName,mail,userPrincipalName,"
      + "jobTitle,department,companyName");
    ctx.me = me;
    ctx.email = (me.mail || me.userPrincipalName || "").toLowerCase();
    ctx.name = me.displayName || ctx.email;
    ctx.domain = domainOf(me.mail) || domainOf(me.userPrincipalName);
    ctx.role = await ermittleRolle();
    return ctx;
  }

  async function ermittleRolle() {
    roleInfo.quelle = "standard";
    roleInfo.fehler = null;
    roleInfo.zeilen = roleInfo.treffer = roleInfo.passend = 0;

    if (istHauptAdmin(ctx.email)) {
      roleInfo.quelle = "hauptadmin";
      return "admin";
    }

    try {
      const rows = await GRAPH.listItems(C.permSite, C.permList,
        ["Title", "UserEmail", "App", "Role"]);
      if (!rows) {
        // listItems liefert null, wenn die Liste nicht gefunden wird – für
        // Konten ohne Zugriff auf die Site sieht das genauso aus.
        roleInfo.fehler = `Liste „${C.permList}“ auf ${C.permSite} nicht gefunden `
          + "oder für dieses Konto nicht lesbar.";
        return C.defaultRole;
      }
      roleInfo.zeilen = rows.length;
      let best = RANK[C.defaultRole] ?? 0;
      for (const r of rows) {
        if ((r.UserEmail || "").toLowerCase() !== ctx.email) continue;
        roleInfo.treffer++;
        if (r.App !== C.appKey && r.App !== "*") continue;
        roleInfo.passend++;
        best = Math.max(best, RANK[String(r.Role || "").toLowerCase()] ?? 0);
      }
      if (roleInfo.passend) roleInfo.quelle = "liste";
      return Object.keys(RANK).find(k => RANK[k] === best) || C.defaultRole;
    } catch (e) {
      roleInfo.fehler = e.detail || e.message;
      console.warn("[Rolle]", roleInfo.fehler);
      // Anders als in rundumdenjob ist der Rückfall hier „none“: eine nicht
      // lesbare Rechteliste darf keinen Schreibzugriff aufs CRM eröffnen.
      return C.defaultRole;
    }
  }

  /** Ein Satz, warum die aktuelle Rolle so ist, wie sie ist. */
  function roleErklaerung() {
    if (roleInfo.quelle === "hauptadmin")
      return "Haupt-Administrator laut js/config.js – Rolle „admin“ unabhängig "
        + "von der Rechteliste.";
    if (roleInfo.fehler)
      return `Rechteliste nicht auswertbar – deshalb Standardrolle „${C.defaultRole}“. `
        + roleInfo.fehler;
    if (roleInfo.quelle === "liste")
      return `Aus ${C.permList}: ${roleInfo.passend} passende(r) Eintrag/Einträge `
        + `(${roleInfo.zeilen} Zeilen gelesen).`;
    if (roleInfo.treffer)
      return `${roleInfo.treffer} Eintrag/Einträge auf diese E-Mail gefunden, aber keiner `
        + `für App „${C.appKey}“ oder „*“ – deshalb Standardrolle „${C.defaultRole}“.`;
    return `Kein Eintrag in ${C.permList} für ${ctx.email} `
      + `(${roleInfo.zeilen} Zeilen gelesen) – deshalb Standardrolle „${C.defaultRole}“.`;
  }

  /** Reicht die Rolle für diese Mindestanforderung? */
  const darf = mindestens => (RANK[ctx.role] ?? 0) >= (RANK[mindestens] ?? 99);

  /** Rolle erneut lesen, ohne neu anzumelden. Nötig, weil ermittleRolle()
   *  sonst nur beim Anmelden läuft – eine danach vergebene Rolle würde bis
   *  zum nächsten Seitenaufruf nicht wirken. */
  async function reloadRole() {
    const alt = ctx.role;
    ctx.role = await ermittleRolle();
    return { alt, neu: ctx.role, geaendert: alt !== ctx.role };
  }

  return { ctx, roleInfo, roleErklaerung, loadUser, reloadRole, darf, RANK };
})();

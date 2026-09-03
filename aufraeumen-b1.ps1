# ══════════════════════════════════════════════════════════════════════
#  Aufräumen nach Befund B1 – und Nachpflege der Opp-ID
#
#  Der Altflow hat am 04.06.2026 durch eine verschachtelte Schleife
#  Verkaufschancen im Kreuzprodukt angelegt (docs/05, B1). Dieses Skript
#  findet sie, listet sie auf und entfernt sie auf Wunsch. Danach kann es
#  new_dagextopid an den verbleibenden Chancen nachpflegen - die
#  Voraussetzung fuer den Alternativschluessel und damit fuer Befund B2.
#
#  REIHENFOLGE IST WICHTIG
#      1. -Bericht      (Standard) nur ansehen, nichts aendern
#      2. -Loeschen     die ueberzaehligen Datensaetze entfernen
#      3. -Nachpflegen  new_dagextopid aus dem #NNNN im Namen setzen
#      4. Alternativschluessel in Power Apps anlegen
#
#  Blind nachpflegen OHNE Schritt 2 wuerde dieselbe Opp-ID auf mehrere
#  Datensaetze stempeln. Deshalb weigert sich -Nachpflegen, solange noch
#  Gruppen mit mehreren Chancen existieren.
#
#  AUFRUF
#      $t = az account get-access-token `
#             --resource https://dihag-test.crm4.dynamics.com `
#             --query accessToken -o tsv
#      ./aufraeumen-b1.ps1 -AccessToken $t                 # nur Bericht
#      ./aufraeumen-b1.ps1 -AccessToken $t -Loeschen
#      ./aufraeumen-b1.ps1 -AccessToken $t -Nachpflegen
# ══════════════════════════════════════════════════════════════════════

param(
    [Parameter(Mandatory = $true)]
    [string] $AccessToken,

    [string] $DataverseUrl = "https://dihag-test.crm4.dynamics.com",

    # Loeschen und Nachpflegen sind bewusst getrennt und beide opt-in.
    [switch] $Loeschen,
    [switch] $Nachpflegen,

    # Sicherheitsnetz: nur an diesen Tagen angelegte Datensaetze kommen
    # ueberhaupt als ueberzaehlig in Frage. Leer = keine Einschraenkung
    # (dann fragt das Skript vor dem Loeschen nach).
    [string[]] $NurVomTag = @("2026-06-04"),

    [string] $BerichtDatei = "aufraeumen-b1-bericht.csv"
)

$ErrorActionPreference = "Stop"
$api = "$($DataverseUrl.TrimEnd('/'))/api/data/v9.2"
$kopf = @{
    Authorization      = "Bearer $AccessToken"
    Accept             = "application/json"
    "OData-Version"    = "4.0"
    "OData-MaxVersion" = "4.0"
}

function Info($t) { Write-Host $t -ForegroundColor Green }
function Warn($t) { Write-Host $t -ForegroundColor Yellow }
function Fehl($t) { Write-Host $t -ForegroundColor Red }

# Alle Seiten einsammeln
function Hole($pfad) {
    $url = "$api$pfad"; $out = @()
    while ($url) {
        $r = Invoke-RestMethod -Uri $url -Headers ($kopf + @{ Prefer = "odata.maxpagesize=1000" })
        $out += $r.value
        $url = $r.'@odata.nextLink'
    }
    return $out
}

Write-Host "=== Aufraeumen nach Befund B1 ===" -ForegroundColor Cyan
Write-Host "Umgebung: $DataverseUrl"

# ── 1 · Bestand einlesen und gruppieren ───────────────────────────────

$alle = Hole "/opportunities?`$select=opportunityid,name,new_dagextopid,createdon,statecode,_parentaccountid_value,estimatedvalue&`$filter=startswith(name,'%23')"
Write-Host "`nVerkaufschancen mit #-Namen: $($alle.Count)"

$mitId = foreach ($o in $alle) {
    if ($o.name -match '^#(\d+)') {
        [PSCustomObject]@{
            Id        = $o.opportunityid
            Name      = $o.name
            OppId     = [int]$Matches[1]
            ExtOpId   = $o.new_dagextopid
            # Sortiert wird nach dem vollen Zeitstempel, angezeigt nur der Tag.
            # Mit Tagesgenauigkeit waere bei Gruppen, die komplett am selben Tag
            # entstanden sind, willkuerlich, welcher Datensatz als Original gilt.
            Zeitpunkt = [datetime]$o.createdon
            Angelegt  = ([datetime]$o.createdon).ToString("yyyy-MM-dd")
            Status    = $o.statecode
            Konto     = $o._parentaccountid_value
            Umsatz    = $o.estimatedvalue
        }
    }
}

$gruppen = $mitId | Group-Object OppId
$mehrfach = @($gruppen | Where-Object { $_.Count -gt 1 })
Write-Host "  verschiedene Opp-IDs:         $($gruppen.Count)"
Write-Host "  Opp-IDs mit mehreren Chancen: $($mehrfach.Count)"

# ── 2 · Ueberzaehlige bestimmen ───────────────────────────────────────
# Aeltester Datensatz je Opp-ID gilt als Original und bleibt.

$ueberzaehlig = foreach ($g in $mehrfach) {
    $sortiert = $g.Group | Sort-Object Zeitpunkt, Id
    $sortiert | Select-Object -Skip 1
}
$ueberzaehlig = @($ueberzaehlig)

# Sicherheitsnetz. Ein Datensatz wird nur dann als ueberzaehlig behandelt,
# wenn ALLE Merkmale des B1-Musters zutreffen: kein Konto, keine Opp-ID im
# Feld, und am erwarteten Tag angelegt. Alles andere ist etwas anderes und
# wird gemeldet statt geloescht.
$sicher = @($ueberzaehlig | Where-Object {
    -not $_.Konto -and $null -eq $_.ExtOpId -and
    ($NurVomTag.Count -eq 0 -or $NurVomTag -contains $_.Angelegt)
})
$unsicher = @($ueberzaehlig | Where-Object { $sicher -notcontains $_ })

Write-Host "`nUeberzaehlige Datensaetze:      $($ueberzaehlig.Count)"
Info    "  entsprechen dem B1-Muster:    $($sicher.Count)"
if ($unsicher.Count) {
    Warn "  WEICHEN AB - werden NICHT angefasst: $($unsicher.Count)"
    $unsicher | Format-Table OppId, Name, Angelegt, Konto, ExtOpId -AutoSize | Out-String | Write-Host
}

if ($sicher.Count) {
    $sicher | Select-Object OppId, Name, Angelegt, Status, Umsatz, Id |
        Export-Csv -Path $BerichtDatei -NoTypeInformation -Encoding UTF8
    Info "  Liste geschrieben: $BerichtDatei"
    Write-Host "`n  Auszug:"
    $sicher | Select-Object -First 8 OppId, Name, Angelegt | Format-Table -AutoSize | Out-String | Write-Host
}

# ── 3 · Loeschen ──────────────────────────────────────────────────────

if ($Loeschen) {
    if (-not $sicher.Count) {
        Info "`nNichts zu loeschen."
    } else {
        Warn "`n[LOESCHEN] $($sicher.Count) Verkaufschancen werden entfernt."
        Warn "Das ist nicht rueckgaengig zu machen. Die Liste steht in $BerichtDatei."
        $n = 0; $fehler = 0
        foreach ($o in $sicher) {
            try {
                Invoke-RestMethod -Method DELETE -Uri "$api/opportunities($($o.Id))" -Headers $kopf | Out-Null
                $n++
                if ($n % 10 -eq 0) { Write-Host "  $n von $($sicher.Count) ..." }
            } catch {
                $fehler++
                Fehl "  #$($o.OppId) $($o.Name): $($_.Exception.Message)"
            }
        }
        Info "`n  geloescht: $n   fehlgeschlagen: $fehler"
    }
}

# ── 4 · new_dagextopid nachpflegen ────────────────────────────────────

if ($Nachpflegen) {
    Write-Host "`n[NACHPFLEGEN] new_dagextopid aus dem #NNNN im Namen"

    # Frisch einlesen - nach einem Loeschlauf ist der Bestand ein anderer.
    $alle2 = Hole "/opportunities?`$select=opportunityid,name,new_dagextopid&`$filter=startswith(name,'%23')"
    $mit2 = foreach ($o in $alle2) {
        if ($o.name -match '^#(\d+)') {
            [PSCustomObject]@{ Id = $o.opportunityid; Name = $o.name
                               OppId = [int]$Matches[1]; ExtOpId = $o.new_dagextopid }
        }
    }
    $rest = @($mit2 | Group-Object OppId | Where-Object { $_.Count -gt 1 })
    if ($rest.Count) {
        Fehl "  ABBRUCH: $($rest.Count) Opp-ID(s) haben noch mehrere Verkaufschancen."
        Fehl "  Erst -Loeschen ausfuehren. Nachpflegen wuerde dieselbe Opp-ID"
        Fehl "  auf mehrere Datensaetze stempeln und den Alternativschluessel"
        Fehl "  endgueltig unmoeglich machen."
        $rest | Select-Object -First 5 Name, Count | Format-Table -AutoSize | Out-String | Write-Host
    } else {
        $offen = @($mit2 | Where-Object { $null -eq $_.ExtOpId })
        Write-Host "  nachzupflegen: $($offen.Count)"
        $n = 0; $fehler = 0
        foreach ($o in $offen) {
            try {
                Invoke-RestMethod -Method PATCH -Uri "$api/opportunities($($o.Id))" `
                    -Headers ($kopf + @{ "Content-Type" = "application/json" }) `
                    -Body (@{ new_dagextopid = $o.OppId } | ConvertTo-Json) | Out-Null
                $n++
                if ($n % 25 -eq 0) { Write-Host "  $n von $($offen.Count) ..." }
            } catch {
                $fehler++
                Fehl "  #$($o.OppId): $($_.Exception.Message)"
            }
        }
        Info "  gesetzt: $n   fehlgeschlagen: $fehler"
        if ($n -and -not $fehler) {
            Write-Host ""
            Info "  Jetzt kann der Alternativschluessel angelegt werden:"
            Write-Host "  Power Apps > Tabellen > Verkaufschance > Schluessel > Neuer Schluessel"
            Write-Host "  Feld: new_dagextopid   - Status muss auf 'Aktiv' gehen, nicht 'Ausstehend'."
        }
    }
}

if (-not $Loeschen -and -not $Nachpflegen) {
    Write-Host ""
    Warn "Nur Bericht. Zum Ausfuehren: -Loeschen, danach -Nachpflegen."
}

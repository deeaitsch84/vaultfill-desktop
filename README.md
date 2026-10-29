# Vaultfill Desktop

Menüleisten-App für Vaultwarden mit systemweiter Schnellsuche (à la Spotlight / 1Password Quick Access).

## Starten

```bash
npm install
npm start            # Entwicklung
npm run pack         # → dist/Vaultfill-darwin-arm64/Vaultfill.app (nach /Applications ziehen)
```

Beim ersten Start: Server, E-Mail, Master-Passwort (SSO läuft in einem eigenen Anmeldefenster).

## Bedienung

- **⌘⇧Leertaste** (änderbar in den Einstellungen): Schnellsuche
  - `⏎` Benutzername ⇥ Passwort in die vorherige App tippen, `⇧⏎` nur Passwort
  - `⌘C` Benutzername, `⌘⇧C` Passwort, `⌘⌥C` 2FA-Code kopieren (Passwort wird nach 30 s aus der Zwischenablage gelöscht)
  - `⌘N` bzw. letzte Zeile: Suchbegriff als neuen Login speichern
  - gesperrt: Touch ID startet sofort, sonst Master-Passwort direkt eintippen
- **Hauptfenster** (Menüleisten-Icon → „Vaultfill öffnen“): Liste, Suche, Neuer Login mit Passwort-Generator, Einstellungen (Kürzel, Touch ID, Autostart).
- **Sicherheit** (Schild-Icon): geleakte (Have I Been Pwned, nur 5 Zeichen des SHA-1 verlassen den Mac), mehrfach verwendete und schwache Passwörter.
- Tippen braucht einmalig **Bedienungshilfen** (+ beim ersten Mal „System Events steuern“) für Vaultfill.

## Agenten (MCP)

Einstellungen → **Agenten (MCP)** → Einträge freigeben („Nur nutzen“ oder „Nutzen + Klartext“), den angezeigten `claude mcp add …`-Befehl kopieren und im Terminal ausführen.

- `list_shared_logins` – nur Name, Benutzername, URL und Referenzen (`vaultfill://<id>/password`), nie Passwörter.
- `run_with_secrets` – führt einen Befehl (`zsh -lc`) mit Secrets als Umgebungsvariablen aus, z. B. `{"command": "npx playwright test", "env": {"TEST_PW": "vaultfill://…/password"}}`. Ausgabe wird geschwärzt (roh, URL-kodiert, Base64).
- `reveal_secret` – Klartext nur für Einträge mit „Nutzen + Klartext“, jedes Mal Touch ID.
- Jede Agent-Sitzung muss einmal bestätigt werden (Dialog + Touch ID); sie endet mit dem Agenten oder beim Sperren. Kein gespeichertes Token. Socket nur für den eigenen macOS-Benutzer (0600). Protokoll und „Trennen“ in der App.
- Grenze: Ein Befehl, der ein Secret absichtlich verfremdet ausgibt (rückwärts, zerstückelt), umgeht die Schwärzung. Schutz gegen Versehen, nicht gegen einen bösartigen Agenten → nur Test-Accounts freigeben.

## Sicherheit

- Gespeicherter Zustand (verschlüsselter Vault, Tokens, Einstellungen) ist zusätzlich per `safeStorage` (Schlüssel im macOS-Schlüsselbund) versiegelt.
- Entschlüsselter Schlüssel nur im Speicher; Auto-Sperre nach 30 min Leerlauf oder Bildschirmsperre.
- Touch ID: Kopie des User-Keys im versiegelten Zustand, freigegeben nach Touch-ID-Bestätigung (gleiches Modell wie Bitwarden Desktop).
- Getippt wird über `osascript` per stdin — das Passwort erscheint nicht in der Prozessliste.

## Tests

`npm test` (Unit). E2E gegen echtes Vaultwarden + offizielle `bw` CLI: Anleitung in `test/vault.test.mjs`.
App-Smoke-Test mit Screenshots: Kopf von `test/smoke.js`.

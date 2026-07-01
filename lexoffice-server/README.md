# Kalkulator ⇄ Lexoffice-Anbindung – Setup-Anleitung

Diese Anleitung bringt den kleinen Server ans Laufen, der bei jeder Angebotsanfrage
automatisch ein Angebot (Entwurf) in Lexoffice / Lexware Office anlegt.

## Was du bekommst

- `server.js` + `package.json` → der Server, der bei Render läuft
- `kalkulator_v6.html` → dein Kalkulator, ruft diesen Server beim Absenden zusätzlich auf

Ablauf beim Kunden: Kalkulation ausfüllen → "Angebot anfordern" klicken →
1) wie bisher öffnet sich das E-Mail-Programm mit der Anfrage an dich
2) **zusätzlich, im Hintergrund**, wird automatisch ein Angebots-Entwurf in Lexoffice angelegt

Falls Lexoffice mal nicht erreichbar ist, schlägt nur Punkt 2 fehl – die E-Mail (Punkt 1)
kommt trotzdem zuverlässig an. Das Angebot in Lexoffice ist bewusst ein **Entwurf**
(nicht automatisch verschickt) – du prüfst und finalisierst es selbst nach der Objektbegehung.

---

## Schritt 1: GitHub-Repository anlegen

1. Auf github.com ein neues, **privates** Repository erstellen (z. B. `kalkulator-lexoffice-server`)
2. Die Dateien `server.js`, `package.json`, `.gitignore` und `.env.example` aus diesem Ordner hochladen
   (per Drag & Drop im Browser reicht, oder `git push` falls du Git gewohnt bist)
3. **Wichtig:** Die Datei `.env` selbst NIEMALS hochladen – die `.gitignore` verhindert das automatisch,
   falls du lokal mit `.env` arbeitest

## Schritt 2: Render-Service erstellen

1. Auf [render.com](https://render.com) einloggen
2. **"New +" → "Web Service"**
3. Das eben erstellte GitHub-Repository auswählen (Render fragt nach Zugriff auf dein GitHub-Konto)
4. Einstellungen:
   - **Name:** z. B. `kalkulator-lexoffice-server`
   - **Region:** Frankfurt (näher an Deutschland = schneller)
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** "Free" reicht zum Start völlig aus

## Schritt 3: Umgebungsvariablen bei Render eintragen

Im Render-Dashboard deines neuen Services → **"Environment"** → **"Add Environment Variable"**:

| Key | Value |
|---|---|
| `LEXOFFICE_API_KEY` | dein Lexoffice-API-Schlüssel (Kontakte + Angebote, lesen/schreiben) |
| `ERLAUBTE_DOMAINS` | `https://www.deine-firma.de` (deine echte Website-Domain, sobald bekannt) |

**Hier und nur hier trägst du den API-Key ein** – nie im Code, nie im Chat, nie auf GitHub.

Nach dem Speichern startet Render den Service automatisch neu.

## Schritt 4: Server-URL im Kalkulator eintragen

1. Render zeigt dir oben die URL deines Services, z. B. `https://kalkulator-lexoffice-server.onrender.com`
2. In `kalkulator_v6.html` im `<script>`-Bereich die Zeile

   ```js
   const LEXOFFICE_SERVER_URL = "BITTE-RENDER-URL-HIER-EINTRAGEN";
   ```

   ersetzen durch z. B.:

   ```js
   const LEXOFFICE_SERVER_URL = "https://kalkulator-lexoffice-server.onrender.com";
   ```

3. Ebenfalls nicht vergessen: `FIRMEN_EMAIL` im gleichen Bereich mit deiner echten E-Mail-Adresse befüllen.

## Schritt 5: Testen

1. Kalkulator im Browser öffnen, Testangebot durchklicken, absenden
2. Browser-Konsole (F12 → "Console") prüfen: dort sollte
   `Lexoffice-Angebot automatisch angelegt: ...` erscheinen
3. In Lexoffice unter "Verkauf → Angebote" nachschauen, ob ein neuer Entwurf aufgetaucht ist

Falls ein Fehler auftaucht, siehst du in der Konsole eine Meldung dazu – meist liegt es an:
- API-Key falsch/abgelaufen
- Berechtigungen des API-Keys zu eng (Kontakte + Angebote müssen lesen+schreiben können)
- Domain in `ERLAUBTE_DOMAINS` stimmt nicht exakt mit der Website-URL überein

---

## Bekannte Einschränkungen dieser ersten Version (Provisorium)

- Es wird bei **jeder** Anfrage ein **neuer** Lexoffice-Kontakt angelegt, auch wenn derselbe
  Kunde schon existiert (keine Dublettenprüfung). Das lässt sich in einem nächsten Schritt
  nachrüsten (Suche nach bestehendem Kontakt per E-Mail, bevor ein neuer angelegt wird).
- Die Preisberechnung läuft im Browser des Kunden – ein technisch versierter Besucher könnte
  theoretisch die im Formular übertragenen Preise manipulieren, bevor sie beim Server ankommen.
  Für den aktuellen Zweck (unverbindlicher Entwurf, den du ohnehin vor Versand prüfst) ist das
  unkritisch. Falls das relevant wird, kann die Preisberechnung serverseitig dupliziert werden.
- CORS ist standardmäßig offen (`ERLAUBTE_DOMAINS` leer = alle Domains erlaubt), bis du deine
  echte Website-Domain einträgst. Sobald bekannt, unbedingt eintragen.

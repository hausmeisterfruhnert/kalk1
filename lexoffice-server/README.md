# Objekt-Kalkulator – Server (Version 2)

Der Server läuft bei Render (kalk1.onrender.com). Der Kalkulator selbst ist die Datei `index.html`
im Hauptordner und läuft über GitHub Pages unter kalkulator.hausmeister-fruhnert.de.

## Was der Server macht

| Adresse | Aufgabe |
|---|---|
| `POST /api/erstelle-angebot` | Kunde in Lexoffice suchen (gleiche E-Mail) oder neu anlegen – mit Name, E-Mail, Telefon, Adresse und Notiz zum Objekt. Danach Angebots-Entwurf anlegen. |
| `POST /api/sende-anfrage` | Anfrage per E-Mail an Sie + Zusammenfassung an den Kunden |
| `POST /api/admin-login` | Prüft E-Mail + Passwort für das Zahnrad |
| `GET/POST /api/preise` | Preise aus dem Zahnrad-Menü für alle Besucher speichern/laden |

Im Angebot steht jede Leistung als **Lexoffice-Artikel (Dienstleistung) mit Preis** aus dem Rechner
(Monatsleistungen in der Einheit „Monat“, Tiefgarage und Dachrinne als „Stück“).
Die Artikel legt der Server beim ersten Angebot selbst an (Artikelnummern `KALK-TREPPENHAUS`, `KALK-HAUSMEISTER`,
`KALK-TONNEN`, `KALK-FAHRSTUHL`, `KALK-GARTEN`, `KALK-WINTER`, `KALK-ZUSCHLAG`, `KALK-TIEFGARAGE`, `KALK-DACHRINNE`)
und verwendet sie danach immer wieder. Sie finden sie in Lexoffice unter Artikel.
Wer eigene, schon vorhandene Artikel nutzen will, trägt deren ID als Umgebungsvariable ein, z. B. `ARTIKEL_TREPPENHAUS=<ID>`.

## Umgebungsvariablen bei Render (Environment)

Siehe `.env.example`. Neu gegenüber Version 1:

- `ERLAUBTE_DOMAINS` = `https://kalkulator.hausmeister-fruhnert.de`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `MAIL_EMPFAENGER` – für den E-Mail-Versand
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` – damit Preisänderungen dauerhaft bleiben
- optional `ARTIKEL_TREPPENHAUS`, `ARTIKEL_HAUSMEISTER`, `ARTIKEL_TONNEN`, `ARTIKEL_FAHRSTUHL`, `ARTIKEL_GARTEN`, `ARTIKEL_WINTER`, `ARTIKEL_KORREKTUR`, `ARTIKEL_TIEFGARAGE`, `ARTIKEL_DACHRINNE` – feste Artikel-IDs

Ohne SMTP öffnet der Kalkulator wie bisher das E-Mail-Programm des Kunden (mit Kunde in Kopie).
Ohne Upstash werden Preisänderungen nur bis zum nächsten Neustart des Servers gespeichert.

## Lexoffice-API-Schlüssel

Der Schlüssel braucht Rechte für **Kontakte lesen + schreiben**, **Artikel lesen + schreiben** und **Angebote schreiben**.

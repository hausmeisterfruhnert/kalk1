/**
 * Kleiner Server für den Objekt-Kalkulator.
 *
 * Aufgabe: Nimmt eine Angebotsanfrage vom Kalkulator entgegen und legt
 * daraus automatisch ein Angebot (Quotation) in Lexoffice / Lexware Office an.
 *
 * WICHTIG: Der Lexoffice-API-Key wird NUR über eine Umgebungsvariable
 * (LEXOFFICE_API_KEY) eingelesen — niemals im Code fest eintragen!
 * Bei Render unter "Environment" als Variable hinterlegen.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json({ limit: '100kb' }));

/* ------------------------------------------------------------------ */
/* CORS: Nur Anfragen von deiner eigenen Website erlauben.             */
/* Trage hier später die echte(n) Domain(s) deiner Website ein, z. B.  */
/* ["https://www.deine-firma.de"]. Solange leer / "*",                */
/* sind Anfragen von JEDER Website erlaubt (nur für die Testphase ok). */
/* ------------------------------------------------------------------ */
const ERLAUBTE_DOMAINS = (process.env.ERLAUBTE_DOMAINS || '')
  .split(',')
  .map(d => d.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (ERLAUBTE_DOMAINS.length === 0) return callback(null, true); // Testphase: alles erlauben
    if (!origin) return callback(null, true); // z.B. direkte Server-zu-Server-Aufrufe / curl
    if (ERLAUBTE_DOMAINS.includes(origin)) return callback(null, true);
    return callback(new Error('Diese Domain ist nicht freigeschaltet.'));
  }
}));

/* Einfacher Schutz gegen Missbrauch/Spam: max. 10 Anfragen pro 15 Min pro IP */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { fehler: 'Zu viele Anfragen. Bitte später erneut versuchen.' }
});
app.use('/api/', limiter);

const LEXOFFICE_API_KEY = process.env.LEXOFFICE_API_KEY;
const LEXOFFICE_BASE_URL = 'https://api.lexware.io/v1';

if (!LEXOFFICE_API_KEY) {
  console.warn('⚠️  WARNUNG: LEXOFFICE_API_KEY ist nicht gesetzt. Der Server startet, aber /api/erstelle-angebot wird fehlschlagen.');
}

/* ------------------------------------------------------------------ */
/* Hilfsfunktion: Aufruf der Lexoffice-API                             */
/* ------------------------------------------------------------------ */
async function lexofficeRequest(pfad, methode, body) {
  const antwort = await fetch(LEXOFFICE_BASE_URL + pfad, {
    method: methode,
    headers: {
      'Authorization': 'Bearer ' + LEXOFFICE_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await antwort.text();
  let daten = null;
  try { daten = text ? JSON.parse(text) : null; } catch (e) { daten = { rohtext: text }; }

  if (!antwort.ok) {
    const fehler = new Error('Lexoffice-API-Fehler: ' + antwort.status);
    fehler.status = antwort.status;
    fehler.details = daten;
    throw fehler;
  }
  return daten;
}

/* ------------------------------------------------------------------ */
/* Kontakt in Lexoffice anlegen                                        */
/* ------------------------------------------------------------------ */
async function legeKontaktAn({ name, email }) {
  const payload = {
    version: 0,
    roles: { customer: {} },
    company: { name: name },
    emailAddresses: { business: [email] }
  };
  const ergebnis = await lexofficeRequest('/contacts', 'POST', payload);
  return ergebnis.id;
}

/* ------------------------------------------------------------------ */
/* Angebot (Quotation) in Lexoffice anlegen                            */
/* ------------------------------------------------------------------ */
async function legeAngebotAn({ contactId, objektAdresse, details, preise }) {
  const lineItems = [];

  const leistungenListe = [];
  if (details.reinigung) leistungenListe.push('Treppenhausreinigung (wöchentlich)');
  if (details.fahrstuhl) leistungenListe.push('Fahrstuhlreinigung');
  if (details.garten) leistungenListe.push('Gartenpflege & Rasenmähen');
  if (details.winter) {
    const winterText = details.winterFlaeche && details.winterFlaeche > 0
      ? ('Winterdienst-Pauschale (' + details.winterFlaeche + ' qm, ' + (details.winterMaterial === 'salz' ? 'Streusalz' : 'Splitt') + ')')
      : 'Winterdienst-Pauschale';
    leistungenListe.push(winterText);
  }
  if (details.tonnen) leistungenListe.push('Mülltonnendienst (App)');

  lineItems.push({
    type: 'custom',
    name: 'Facility-Management Monatspauschale – ' + details.einheiten + ' WE',
    description: 'Enthaltene Leistungen:\n- ' + leistungenListe.join('\n- ')
      + (details.stockwerkText ? ('\nHöchstes Stockwerk: ' + details.stockwerkText) : '')
      + (details.gartenText ? ('\nGartenfläche: ' + details.gartenText) : ''),
    quantity: 1,
    unitName: 'Monat',
    unitPrice: {
      currency: 'EUR',
      netAmount: preise.monatsNetto,
      taxRatePercentage: 19
    }
  });

  if (details.tgAktiv && preise.tgNetto && preise.tgNetto > 0) {
    lineItems.push({
      type: 'custom',
      name: 'Einmalige Tiefgaragenreinigung (Nassreinigung)',
      description: (details.tgPlaetze || 0) + ' Stellplätze / ' + (details.tgQm || 0) + ' qm',
      quantity: 1,
      unitName: 'Stück',
      unitPrice: {
        currency: 'EUR',
        netAmount: preise.tgNetto,
        taxRatePercentage: 19
      }
    });
  }

  if (details.rinneAktiv && preise.rinneNetto && preise.rinneNetto > 0) {
    lineItems.push({
      type: 'custom',
      name: 'Einmalige Dachrinnenreinigung (Dachrinnensauger mit Kamera)',
      description: 'Vorne ' + (details.rinneVorne || 0) + 'm / Hinten ' + (details.rinneHinten || 0)
        + 'm, ' + (details.fallrohre || 0) + ' Fallrohre, Arbeitshöhe ' + (details.rinneHoehe || 0) + 'm',
      quantity: 1,
      unitName: 'Stück',
      unitPrice: {
        currency: 'EUR',
        netAmount: preise.rinneNetto,
        taxRatePercentage: 19
      }
    });
  }

  const payload = {
    voucherDate: new Date().toISOString(),
    address: { contactId: contactId },
    lineItems: lineItems,
    totalPrice: { currency: 'EUR' },
    taxConditions: { taxType: 'net' },
    introduction: 'Vielen Dank für Ihre Anfrage über unseren Online-Kalkulator.'
      + (objektAdresse ? ('\nObjektadresse: ' + objektAdresse) : ''),
    remark: 'Unverbindlicher Richtpreis auf Basis der Online-Kalkulation. Der finale Preis wird nach einer Objektbegehung bestätigt.'
  };

  const ergebnis = await lexofficeRequest('/quotations', 'POST', payload);
  return ergebnis;
}

/* ------------------------------------------------------------------ */
/* Haupt-Endpunkt: wird vom Kalkulator-Formular aufgerufen              */
/* ------------------------------------------------------------------ */
app.post('/api/erstelle-angebot', async (req, res) => {
  try {
    const { name, email, objektAdresse, details, preise } = req.body || {};

    if (!name || !email || !details || !preise) {
      return res.status(400).json({ fehler: 'Unvollständige Daten erhalten.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ fehler: 'Ungültige E-Mail-Adresse.' });
    }
    if (!LEXOFFICE_API_KEY) {
      return res.status(500).json({ fehler: 'Server ist nicht korrekt konfiguriert (fehlender API-Key).' });
    }

    const contactId = await legeKontaktAn({ name, email });
    const angebot = await legeAngebotAn({ contactId, objektAdresse, details, preise });

    res.json({
      erfolg: true,
      angebotId: angebot.id,
      hinweis: 'Angebot wurde in Lexoffice als Entwurf angelegt.'
    });

  } catch (err) {
    console.error('Fehler beim Erstellen des Angebots:', err.status, err.details || err.message);
    res.status(502).json({
      fehler: 'Angebot konnte nicht automatisch in Lexoffice angelegt werden.',
      details: err.details || err.message
    });
  }
});

/* Einfacher Gesundheitscheck, u.a. für Render */
app.get('/', (req, res) => {
  res.send('Kalkulator-Lexoffice-Server läuft.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server läuft auf Port ' + PORT);
});

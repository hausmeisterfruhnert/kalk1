/**
 * Server für den Objekt-Kalkulator (kalkulator.hausmeister-fruhnert.de)
 *
 * Aufgaben:
 *  1. /api/erstelle-angebot  – legt aus einer Anfrage ein Angebot (Entwurf) in Lexoffice an
 *  2. /api/sende-anfrage     – verschickt die Anfrage per E-Mail an die Firma
 *                              und eine Zusammenfassung als Kopie an den Kunden
 *  3. /api/admin-login       – prüft E-Mail + Passwort für das Zahnrad-Menü
 *  4. /api/preise            – liefert (GET) bzw. speichert (POST, nur Admin) die Preise,
 *                              damit Änderungen im Zahnrad-Menü für alle Besucher gelten
 *
 * Alle Zugangsdaten kommen NUR aus Umgebungsvariablen (bei Render unter "Environment").
 * Niemals API-Keys oder Passwörter in den Code schreiben.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');

const app = express();
app.set('trust proxy', 1); // Render läuft hinter einem Proxy
app.use(express.json({ limit: '100kb' }));

/* ------------------------------------------------------------------ */
/* CORS: nur die eigene Website erlauben (ERLAUBTE_DOMAINS)           */
/* z. B. https://kalkulator.hausmeister-fruhnert.de                   */
/* ------------------------------------------------------------------ */
const ERLAUBTE_DOMAINS = (process.env.ERLAUBTE_DOMAINS || '')
  .split(',').map(d => d.trim()).filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (ERLAUBTE_DOMAINS.length === 0) return callback(null, true); // Testphase: alles erlauben
    if (!origin) return callback(null, true);
    if (ERLAUBTE_DOMAINS.includes(origin)) return callback(null, true);
    return callback(new Error('Diese Domain ist nicht freigeschaltet.'));
  }
}));

/* ------------------------------------------------------------------ */
/* Schutz gegen Missbrauch                                             */
/* ------------------------------------------------------------------ */
const anfrageLimiter = rateLimit({   // Angebot + E-Mail: max. 10 pro 15 Min pro IP
  windowMs: 15 * 60 * 1000, max: 10,
  message: { fehler: 'Zu viele Anfragen. Bitte später erneut versuchen.' }
});
const loginLimiter = rateLimit({     // Admin-Login und Preise speichern
  windowMs: 15 * 60 * 1000, max: 8,
  message: { ok: false, fehler: 'Zu viele Login-Versuche. Bitte später erneut versuchen.' }
});
const leseLimiter = rateLimit({      // Preise lesen (jeder Seitenaufruf) – großzügig
  windowMs: 60 * 1000, max: 60,
  message: { fehler: 'Zu viele Anfragen.' }
});

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORT = process.env.ADMIN_PASSWORT;
if (!ADMIN_EMAIL || !ADMIN_PASSWORT) {
  console.warn('⚠️  ADMIN_EMAIL und/oder ADMIN_PASSWORT ist nicht gesetzt. Der Admin-Bereich kann nicht entsperrt werden.');
}
function istAdmin(email, passwort) {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORT) return false;
  return typeof email === 'string' && email.trim().toLowerCase() === ADMIN_EMAIL.trim().toLowerCase()
    && typeof passwort === 'string' && passwort === ADMIN_PASSWORT;
}

app.post('/api/admin-login', loginLimiter, (req, res) => {
  const { email, passwort } = req.body || {};
  if (!ADMIN_EMAIL || !ADMIN_PASSWORT) {
    return res.status(500).json({ ok: false, fehler: 'Server nicht korrekt konfiguriert.' });
  }
  if (istAdmin(email, passwort)) return res.json({ ok: true });
  return res.status(401).json({ ok: false });
});

/* ------------------------------------------------------------------ */
/* Preise speichern / lesen                                            */
/* Dauerhaft speichern geht über Upstash Redis (kostenlos):            */
/*   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN                 */
/* Ohne Upstash wird in eine Datei geschrieben. Achtung: Im kostenlosen */
/* Render-Tarif geht die Datei bei jedem Neustart verloren.            */
/* ------------------------------------------------------------------ */
const PREIS_SCHLUESSEL = [
  'hausmeisterProWE', 'treppenhausProTH', 'treppenhausProWE', 'etageZuschlag',
  'tonnenProWE', 'fahrstuhlProAufzug',
  'winterQmMonat', 'salzZuschlag', 'winterMinMonat', 'winterInklQm',
  'rabatt5', 'rabatt10', 'rabatt20', 'mindestpreis', 'mindestpreisMehrfach',
  'gartenQmMonat', 'laubMittel', 'laubViel', 'gartenMinMonat',
  'tgQm', 'tgMin', 'tgPlatzQm', 'tgFahrQm',
  'rinneGrund', 'rinneMeter', 'rinneFallrohr', 'rinneZuschlagMittel', 'rinneZuschlagHoch'
];
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PREIS_DATEI = process.env.PREIS_DATEI || path.join(__dirname, 'data', 'preise.json');
const REDIS_KEY = 'kalkulator_preise';
let preisCache = null;

function bereinigePreise(eingabe) {
  const sauber = {};
  if (!eingabe || typeof eingabe !== 'object') return sauber;
  for (const k of PREIS_SCHLUESSEL) {
    const v = Number(eingabe[k]);
    if (Number.isFinite(v) && v >= 0 && v <= 100000) sauber[k] = v;
  }
  return sauber;
}

async function ladePreise() {
  if (preisCache) return preisCache;
  try {
    if (UPSTASH_URL && UPSTASH_TOKEN) {
      const r = await fetch(UPSTASH_URL + '/get/' + REDIS_KEY, { headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN } });
      const d = await r.json();
      preisCache = d && d.result ? bereinigePreise(JSON.parse(d.result)) : {};
    } else if (fs.existsSync(PREIS_DATEI)) {
      preisCache = bereinigePreise(JSON.parse(fs.readFileSync(PREIS_DATEI, 'utf8')));
    } else {
      preisCache = {};
    }
  } catch (e) {
    console.warn('Preise konnten nicht geladen werden:', e.message);
    preisCache = {};
  }
  return preisCache;
}

async function speicherePreise(preise) {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    const r = await fetch(UPSTASH_URL + '/set/' + REDIS_KEY, {
      method: 'POST', headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN }, body: JSON.stringify(preise)
    });
    if (!r.ok) throw new Error('Upstash-Fehler ' + r.status);
  } else {
    fs.mkdirSync(path.dirname(PREIS_DATEI), { recursive: true });
    fs.writeFileSync(PREIS_DATEI, JSON.stringify(preise, null, 2));
  }
  preisCache = preise;
}

app.get('/api/preise', leseLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ preise: await ladePreise() });
});

app.post('/api/preise', loginLimiter, async (req, res) => {
  const { email, passwort, preise } = req.body || {};
  if (!istAdmin(email, passwort)) return res.status(401).json({ ok: false });
  try {
    const sauber = bereinigePreise(preise);
    await speicherePreise(sauber);
    res.json({ ok: true, dauerhaft: !!(UPSTASH_URL && UPSTASH_TOKEN) });
  } catch (e) {
    console.error('Preise speichern fehlgeschlagen:', e.message);
    res.status(500).json({ ok: false, fehler: 'Speichern fehlgeschlagen.' });
  }
});

/* ------------------------------------------------------------------ */
/* Hilfen                                                              */
/* ------------------------------------------------------------------ */
const kurz = (v, max = 120) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const kurz2 = (v, max = 1000) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max); // mit Zeilenumbrüchen
const zahl = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const euro = (v) => zahl(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const euro0 = (v) => zahl(v).toLocaleString('de-DE', { maximumFractionDigits: 0 }) + ' €';
const istEmail = (e) => typeof e === 'string' && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const material = (m) => (m === 'salz' ? 'Streusalz' : 'Splitt');

function pruefeAnfrage(body) {
  const { name, email, details, preise } = body || {};
  if (!name || !email || !details || !preise) return 'Unvollständige Daten erhalten.';
  if (!istEmail(email)) return 'Ungültige E-Mail-Adresse.';
  return null;
}

/* ------------------------------------------------------------------ */
/* Lexoffice                                                           */
/* ------------------------------------------------------------------ */
const LEXOFFICE_API_KEY = process.env.LEXOFFICE_API_KEY;
const LEXOFFICE_BASE_URL = 'https://api.lexware.io/v1';
if (!LEXOFFICE_API_KEY) {
  console.warn('⚠️  LEXOFFICE_API_KEY ist nicht gesetzt. /api/erstelle-angebot wird fehlschlagen.');
}

/* Lexoffice erlaubt nur ca. 2 Anfragen pro Sekunde. Deshalb laufen alle Aufrufe
   nacheinander mit mindestens 600 ms Abstand, und bei "Rate limit exceeded" (429)
   wird automatisch mit Wartezeit wiederholt. */
const LEX_ABSTAND_MS = 600;
let lexWarteschlange = Promise.resolve();
let lexLetzterAufruf = 0;
const warte = (ms) => new Promise(r => setTimeout(r, ms));

function lexofficeRequest(pfad, methode, body) {
  const auftrag = lexWarteschlange.then(() => lexofficeAufruf(pfad, methode, body));
  lexWarteschlange = auftrag.catch(() => {}); // Fehler blockieren die Warteschlange nicht
  return auftrag;
}

async function lexofficeAufruf(pfad, methode, body) {
  for (let versuch = 1; ; versuch++) {
    const seitLetztem = Date.now() - lexLetzterAufruf;
    if (seitLetztem < LEX_ABSTAND_MS) await warte(LEX_ABSTAND_MS - seitLetztem);
    lexLetzterAufruf = Date.now();

    const antwort = await fetch(LEXOFFICE_BASE_URL + pfad, {
      method: methode,
      headers: {
        'Authorization': 'Bearer ' + LEXOFFICE_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (antwort.status === 429 && versuch < 6) {
      await warte(1000 * versuch); // 1 s, 2 s, 3 s … warten und erneut versuchen
      continue;
    }
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
}

/* Kunde in Lexoffice: vorhandenen Kontakt (gleiche E-Mail) wiederverwenden, sonst neu anlegen
   – mit Name, E-Mail, Telefon, Rechnungs- und Objektadresse und einer Notiz zum Objekt */
async function findeKontakt(email) {
  try {
    const r = await lexofficeRequest('/contacts?customer=true&email=' + encodeURIComponent(email), 'GET');
    return r && Array.isArray(r.content) && r.content[0] ? r.content[0] : null;
  } catch (e) {
    console.warn('Kontaktsuche fehlgeschlagen, lege neuen Kontakt an:', e.status || e.message);
    return null;
  }
}

/* Vorhandenen Kunden ergänzen: fehlende Adresse und Telefonnummer eintragen, Notiz anhängen */
async function ergaenzeKontakt(kontakt, { telefon, adr, notiz }) {
  const k = await lexofficeRequest('/contacts/' + kontakt.id, 'GET'); // aktuelle Version holen
  let geaendert = false;
  k.addresses = k.addresses || {};
  const billing = (k.addresses.billing || [])[0];
  if (adr && !(billing && billing.street && billing.zip && billing.city)) {
    k.addresses.billing = [adr]; geaendert = true;
  }
  if (adr && !(k.addresses.shipping || []).some(s => s.street === adr.street && s.zip === adr.zip)) {
    k.addresses.shipping = [...(k.addresses.shipping || []), Object.assign({ supplement: 'Objektadresse' }, adr)]; geaendert = true;
  }
  if (telefon) {
    k.phoneNumbers = k.phoneNumbers || {};
    const alle = Object.values(k.phoneNumbers).flat();
    if (!alle.includes(telefon)) { k.phoneNumbers.business = [...(k.phoneNumbers.business || []), telefon]; geaendert = true; }
  }
  if (notiz) {
    k.note = kurz2(((k.note ? k.note + '\n\n' : '') + notiz), 1000); geaendert = true;
  }
  if (geaendert) {
    if (!k.addresses.billing && !k.addresses.shipping) delete k.addresses;
    await lexofficeRequest('/contacts/' + kontakt.id, 'PUT', k);
  }
  const b = (k.addresses && k.addresses.billing || [])[0];
  return !!(b && b.zip && b.city);
}

async function legeKontaktAn({ name, email, telefon, rechnungsadresse, objektAdresse, notiz }) {
  const a = rechnungsadresse || {};
  const adr = (a.strasse && a.plz && a.ort)
    ? { street: kurz(a.strasse, 100), zip: kurz(a.plz, 10), city: kurz(a.ort, 80), countryCode: 'DE' } : null;
  const tel = telefon ? kurz(telefon, 30) : '';

  const vorhanden = await findeKontakt(email);
  if (vorhanden) {
    let hatAdresse = false;
    try { hatAdresse = await ergaenzeKontakt(vorhanden, { telefon: tel, adr, notiz }); }
    catch (e) { console.warn('Kunde konnte nicht ergänzt werden:', e.status || e.message, e.details ? JSON.stringify(e.details) : ''); }
    return { contactId: vorhanden.id, hatAdresse, neu: false };
  }

  const payload = {
    version: 0,
    roles: { customer: {} },
    company: { name: kurz(name, 100) },
    emailAddresses: { business: [email] }
  };
  if (notiz) payload.note = kurz2(notiz, 1000);
  if (tel) payload.phoneNumbers = { business: [tel] };
  if (adr) payload.addresses = { billing: [adr], shipping: [Object.assign({ supplement: 'Objektadresse' }, adr)] };
  const ergebnis = await lexofficeRequest('/contacts', 'POST', payload);
  return { contactId: ergebnis.id, hatAdresse: !!adr, neu: true };
}

/* Texte zu den Leistungen – werden für Lexoffice und die E-Mails genutzt */
function leistungsTexte(d) {
  const umgelegt = (m) => (m && m < 12 ? ('Saison ' + m + ' Monate, gleichmäßig auf 12 Monate umgelegt') : '');
  const verbinde = (...t) => t.filter(Boolean).join(' · ');
  return {
    treppenhaus: {
      name: 'Treppenhausreinigung (' + kurz(d.treppenhausTurnus || 'wöchentlich', 30) + ')',
      beschreibung: verbinde(zahl(d.treppenhaeuser || 1) + ' Treppenhaus/-häuser', zahl(d.einheiten) + ' WE',
        d.stockwerkText ? ('höchstes Stockwerk: ' + kurz(d.stockwerkText, 40)) : '')
    },
    hausmeister: {
      name: 'Hausmeisterservice (' + kurz(d.hausmeisterTurnus || 'wöchentlich', 30) + ')',
      beschreibung: 'Kontrollgang, Kleinreparaturen, Mängelmeldung an die Verwaltung · ' + zahl(d.einheiten) + ' WE'
    },
    tonnen: { name: 'Mülltonnendienst (App)', beschreibung: 'Bereitstellung und Rückstellung · ' + zahl(d.einheiten) + ' WE' },
    fahrstuhl: { name: 'Fahrstuhlreinigung', beschreibung: zahl(d.aufzuege || 1) + ' Aufzug/Aufzüge' },
    garten: {
      name: 'Gartenpflege & Rasenmähen',
      beschreibung: verbinde('ca. ' + zahl(d.gartenQm) + ' m² Gartenfläche', d.laub ? ('Laub: ' + kurz(d.laub, 10)) : '',
        'inkl. Laubbeseitigung', umgelegt(zahl(d.gartenMonate)))
    },
    winter: {
      name: (d.nurWinter ? 'Eigenständiger Winterdienst' : 'Winterdienst') + ' (' + zahl(d.winterFlaeche) + ' m², ' + material(d.winterMaterial) + ')',
      beschreibung: verbinde(
        'Gehweg ' + zahl(d.winterGehweg) + ' m²' + (zahl(d.winterExtra) ? (' + Extrafläche ' + zahl(d.winterExtra) + ' m²') : ''),
        'inkl. Streumittel', umgelegt(zahl(d.winterMonate)))
    },
    korrektur: { name: 'Objektzuschlag', beschreibung: 'Individuelle Anpassung für dieses Objekt' }
  };
}
const REIHENFOLGE = [
  ['treppenhaus', 'reinigung'], ['hausmeister', 'hausmeister'], ['tonnen', 'tonnen'],
  ['fahrstuhl', 'fahrstuhl'], ['garten', 'garten'], ['winter', 'winter'], ['korrektur', null]
];

/* ------------------------------------------------------------------ */
/* Lexoffice-Artikel für die Leistungen                                */
/* Optional feste Artikel-IDs per Umgebungsvariable, z. B.             */
/*   ARTIKEL_TREPPENHAUS=<Lexoffice-Artikel-ID>                        */
/* Sonst sucht der Server den Artikel per Artikelnummer (KALK-...)     */
/* und legt ihn an, falls es ihn noch nicht gibt.                      */
/* ------------------------------------------------------------------ */
const ARTIKEL = {
  treppenhaus: { nr: 'KALK-TREPPENHAUS', titel: 'Treppenhausreinigung' },
  hausmeister: { nr: 'KALK-HAUSMEISTER', titel: 'Hausmeisterservice' },
  tonnen:      { nr: 'KALK-TONNEN',      titel: 'Mülltonnendienst' },
  fahrstuhl:   { nr: 'KALK-FAHRSTUHL',   titel: 'Fahrstuhlreinigung' },
  garten:      { nr: 'KALK-GARTEN',      titel: 'Gartenpflege & Rasenmähen' },
  winter:      { nr: 'KALK-WINTER',      titel: 'Winterdienst' },
  korrektur:   { nr: 'KALK-ZUSCHLAG',    titel: 'Objektzuschlag' },
  tiefgarage:  { nr: 'KALK-TIEFGARAGE',  titel: 'Tiefgaragenreinigung (Nassreinigung)' },
  dachrinne:   { nr: 'KALK-DACHRINNE',   titel: 'Dachrinnenreinigung (Dachrinnensauger mit Kamera)' }
};
const artikelCache = {};
let artikelGeladen = false;

/* Einmal alle Dienstleistungs-Artikel laden (1 Anfrage statt 9), danach aus dem Speicher */
async function ladeArtikelListe() {
  if (artikelGeladen) return;
  for (let seite = 0; seite < 10; seite++) {
    const r = await lexofficeRequest('/articles?type=SERVICE&size=250&page=' + seite, 'GET');
    const liste = (r && Array.isArray(r.content)) ? r.content : [];
    for (const art of liste) {
      for (const [key, a] of Object.entries(ARTIKEL)) {
        if (art.articleNumber === a.nr) artikelCache[key] = art.id;
      }
    }
    if (!r || r.last !== false || liste.length === 0) break;
  }
  artikelGeladen = true;
}

async function artikelFuer(key, einheit) {
  const a = ARTIKEL[key];
  if (!a) return null;
  const envId = process.env['ARTIKEL_' + key.toUpperCase()];
  if (envId) return envId;
  try {
    await ladeArtikelListe();
    if (artikelCache[key]) return artikelCache[key];
    const neu = await lexofficeRequest('/articles', 'POST', {
      title: a.titel, type: 'SERVICE', articleNumber: a.nr, unitName: einheit || 'Monat',
      price: { netPrice: 0, leadingPrice: 'NET', taxRate: 19 }
    });
    if (neu && neu.id) artikelCache[key] = neu.id;
    return artikelCache[key] || null;
  } catch (e) {
    console.warn('Artikel ' + a.nr + ' nicht verfügbar, nutze Freitext-Position:', e.status || e.message, e.details ? JSON.stringify(e.details) : '');
    return null;
  }
}

async function legeAngebotAn({ contactId, kundenName, hatAdresse, objektAdresse, details, preise }) {
  const d = details;
  const pos = preise.positionen || {};
  const texte = leistungsTexte(d);
  const lineItems = [];

  // Jede Leistung wird als Lexoffice-ARTIKEL (Dienstleistung) mit Preis eingefügt.
  // Die Artikel werden beim ersten Mal automatisch in Lexoffice angelegt (Artikelnummer KALK-...)
  // und danach wiederverwendet. Klappt das nicht, wird die Position ersatzweise als
  // Freitext-Position mit Preis eingefügt, damit das Angebot trotzdem entsteht.
  const zeilen = [];
  const zeile = (artikelKey, name, betrag, beschreibung, einheit) => {
    if (!betrag || zahl(betrag) <= 0) return;
    zeilen.push({ artikelKey, name, betrag, beschreibung, einheit, index: lineItems.length });
    lineItems.push(null); // Platzhalter, wird unten gefüllt
  };

  const hatMonatsleistung = REIHENFOLGE.some(([, flag]) => flag && d[flag]);
  if (hatMonatsleistung) {
    const z = [];
    z.push('Wohneinheiten: ' + zahl(d.einheiten) + ' WE · Treppenhäuser: ' + zahl(d.treppenhaeuser || 1) + ' · Aufzüge: ' + zahl(d.aufzuege));
    z.push('Höchstes Stockwerk: ' + kurz(d.stockwerkText || 'Standard (bis 2. OG)', 40));
    z.push('Gartenfläche: ca. ' + zahl(d.gartenQm) + ' m²' + (d.laub ? (' (Laub: ' + kurz(d.laub, 10) + ')') : ''));
    z.push('Winterdienst-Fläche: ' + zahl(d.winterFlaeche) + ' m², ' + material(d.winterMaterial));
    z.push('Abrechnung als gleichbleibende Monatspauschale – Winterdienst und Gartenpflege sind auf 12 Monate umgelegt.');
    lineItems.push({ type: 'text', name: 'Hausmeisterservice – Objektübersicht', description: z.join('\n') });
  }

  for (const [key, flag] of REIHENFOLGE) {
    if (flag && !d[flag]) continue;
    if (key === 'korrektur' && Math.abs(zahl(pos.korrektur)) < 0.01) continue;
    zeile(key, texte[key].name, pos[key], texte[key].beschreibung, 'Monat');
  }

  if (d.tgAktiv) {
    zeile('tiefgarage', 'Einmalige Tiefgaragenreinigung (Nassreinigung)', preise.tgNetto,
      zahl(d.tgPlaetze) + ' Stellplätze (ca. ' + zahl(d.tgStellflaeche) + ' m²) + Fahrgasse ca. ' + zahl(d.tgFahrgasse)
      + ' m² = ' + zahl(d.tgFlaeche) + ' m² Reinigungsfläche' + (d.tgFlaecheGerechnet ? ' (errechnet)' : ''), 'Stück');
  }
  if (d.rinneAktiv) {
    zeile('dachrinne', 'Einmalige Dachrinnenreinigung (Dachrinnensauger mit Kamera)', preise.rinneNetto,
      'Vorne ' + zahl(d.rinneVorne) + ' m / hinten ' + zahl(d.rinneHinten) + ' m, ' + zahl(d.fallrohre)
      + ' Fallrohre, Arbeitshöhe ' + zahl(d.rinneHoehe) + ' m', 'Stück');
  }

  if (zeilen.length === 0 && zahl(preise.monatsNetto) > 0) {
    zeile('hausmeister', 'Hausmeisterservice – ' + zahl(d.einheiten) + ' WE', preise.monatsNetto, '', 'Monat');
  }
  for (const z of zeilen) {
    const preis = Math.round(zahl(z.betrag) * 100) / 100;
    const basis = {
      name: kurz(z.name, 250), description: z.beschreibung ? kurz(z.beschreibung, 1000) : undefined,
      quantity: 1, unitName: z.einheit,
      unitPrice: { currency: 'EUR', netAmount: preis, taxRatePercentage: 19 }
    };
    const artikelId = await artikelFuer(z.artikelKey, z.einheit);
    lineItems[z.index] = artikelId ? Object.assign({ id: artikelId, type: 'service' }, basis) : Object.assign({ type: 'custom' }, basis);
  }

  if (lineItems.length === 0) {
    lineItems.push({ type: 'text', name: 'Individuelle Anfrage',
      description: 'Keine konkreten Leistungen im Online-Kalkulator ausgewählt. Bitte mit dem Kunden klären.' });
  }

  const heute = new Date();
  const ablaufdatum = new Date(heute);
  ablaufdatum.setDate(ablaufdatum.getDate() + 30);

  const payload = {
    voucherDate: heute.toISOString(),
    expirationDate: ablaufdatum.toISOString(),
    address: hatAdresse ? { contactId } : { name: kurz(kundenName, 100), countryCode: 'DE' },
    lineItems,
    totalPrice: { currency: 'EUR' },
    taxConditions: { taxType: 'net' },
    introduction: 'Vielen Dank für Ihre Anfrage über unseren Online-Kalkulator.'
      + (objektAdresse ? ('\nObjektadresse: ' + kurz(objektAdresse, 200)) : ''),
    remark: 'Unverbindlicher Richtpreis auf Basis der Online-Kalkulation. Der finale Preis wird nach einer Objektbegehung bestätigt.\n'
      + 'Sämtliche Arbeitskosten werden auf der Rechnung als Lohnkosten im Sinne von § 35a EStG ausgewiesen.'
  };
  return lexofficeRequest('/quotations', 'POST', payload);
}

app.post('/api/erstelle-angebot', anfrageLimiter, async (req, res) => {
  try {
    const fehler = pruefeAnfrage(req.body);
    if (fehler) return res.status(400).json({ fehler });
    if (!LEXOFFICE_API_KEY) return res.status(500).json({ fehler: 'Server ist nicht korrekt konfiguriert (fehlender API-Key).' });

    const { name, email, telefon, objektAdresse, rechnungsadresse, details, preise } = req.body;
    const notiz = 'Anfrage über Online-Kalkulator vom ' + new Date().toLocaleDateString('de-DE') + '\n'
      + baueMails(req.body).objektKurz;
    const { contactId, hatAdresse, neu } = await legeKontaktAn({ name, email, telefon, rechnungsadresse, objektAdresse, notiz });
    const angebot = await legeAngebotAn({ contactId, kundenName: name, hatAdresse, objektAdresse, details, preise });
    res.json({ erfolg: true, angebotId: angebot.id, kontaktNeu: neu, hinweis: 'Angebot wurde in Lexoffice als Entwurf angelegt.' });
  } catch (err) {
    console.error('Fehler beim Erstellen des Angebots:', err.status, err.details || err.message);
    res.status(502).json({ fehler: 'Angebot konnte nicht automatisch in Lexoffice angelegt werden.', details: err.details || err.message });
  }
});

/* ------------------------------------------------------------------ */
/* E-Mail-Versand                                                      */
/* Umgebungsvariablen: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,     */
/* optional SMTP_FROM und MAIL_EMPFAENGER (Standard: ADMIN_EMAIL)      */
/* ------------------------------------------------------------------ */
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const MAIL_EMPFAENGER = process.env.MAIL_EMPFAENGER || ADMIN_EMAIL;
const FIRMA = {
  name: process.env.FIRMA_NAME || 'Fruhnert Hausmeisterservice',
  telefon: process.env.FIRMA_TELEFON || '08141 5098956',
  web: process.env.FIRMA_WEB || 'www.hausmeister-fruhnert.de'
};

const mailer = (SMTP_HOST && SMTP_USER && SMTP_PASS)
  ? nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } })
  : null;
if (!mailer) console.warn('ℹ️  SMTP ist nicht eingerichtet – /api/sende-anfrage antwortet mit 503, der Kalkulator öffnet dann das E-Mail-Programm.');

/* Die Mailtexte werden hier auf dem Server gebaut (nicht im Browser),
   damit niemand über den Kalkulator beliebige Texte an fremde Adressen schicken kann. */
function baueMails(body) {
  const d = body.details, p = body.preise, a = body.anzeige || {};
  const texte = leistungsTexte(d);
  const objekt = [
    'OBJEKT',
    '• Adresse: ' + (kurz(body.objektAdresse, 200) || '-'),
    '• Wohneinheiten: ' + zahl(d.einheiten) + ' · Treppenhäuser: ' + zahl(d.treppenhaeuser || 1) + ' · Aufzüge: ' + zahl(d.aufzuege),
    '• Höchstes Stockwerk: ' + kurz(d.stockwerkText, 40),
    '• Gartenfläche: ca. ' + zahl(d.gartenQm) + ' m²' + (d.laub ? (' (Laub: ' + kurz(d.laub, 10) + ')') : ''),
    '• Winterdienst-Fläche: ' + zahl(d.winterGehweg) + ' m² Gehweg + ' + zahl(d.winterExtra) + ' m² Extrafläche, ' + material(d.winterMaterial)
  ];
  const leistungen = ['GEWÄHLTE LEISTUNGEN'];
  for (const [key, flag] of REIHENFOLGE) {
    if (!flag) continue;
    leistungen.push('• ' + texte[key].name + ': ' + (d[flag] ? 'JA' : 'NEIN'));
  }
  leistungen.push('• Tiefgaragenreinigung: ' + (d.tgAktiv ? (zahl(d.tgPlaetze) + ' Stellplätze, gesamt ' + zahl(d.tgFlaeche) + ' m²') : 'NEIN'));
  leistungen.push('• Dachrinnenreinigung: ' + (d.rinneAktiv ? ('vorne ' + zahl(d.rinneVorne) + ' m / hinten ' + zahl(d.rinneHinten) + ' m, ' + zahl(d.fallrohre) + ' Fallrohre, Höhe ' + zahl(d.rinneHoehe) + ' m') : 'NEIN'));

  const spanne = (von, bis) => (zahl(von) > 0 ? ('ca. ' + euro0(von) + ' – ' + euro0(bis)) : '–');
  const preisKunde = [
    'UNVERBINDLICHER RICHTPREIS (inkl. 19 % MwSt.)',
    '• Monatspauschale: ' + (zahl(a.monatVon) > 0 ? spanne(a.monatVon, a.monatBis) + ' pro Monat (gleichbleibend über 12 Monate)' : '–'),
    '• Tiefgaragenreinigung einmalig: ' + spanne(a.tgVon, a.tgBis),
    '• Dachrinnenreinigung einmalig: ' + spanne(a.rinneVon, a.rinneBis),
    '',
    'Der genaue Preis folgt nach einer kostenlosen Besichtigung vor Ort. Arbeitskosten sind nach § 35a EStG steuerlich absetzbar.'
  ];
  const pos = p.positionen || {};
  const preisIntern = ['RICHTPREIS INTERN (netto)'];
  for (const [key, flag] of REIHENFOLGE) {
    if (zahl(pos[key]) > 0 && (!flag || d[flag])) preisIntern.push('• ' + texte[key].name + ': ' + euro(pos[key]) + ' / Monat');
  }
  preisIntern.push('• Monatspauschale: ' + euro(p.monatsNetto) + ' netto / ' + euro(p.monatsBrutto) + ' brutto');
  preisIntern.push('• Tiefgarage einmalig: ' + (zahl(p.tgNetto) ? euro(p.tgNetto) : '–'));
  preisIntern.push('• Dachrinne einmalig: ' + (zahl(p.rinneNetto) ? euro(p.rinneNetto) : '–'));

  const name = kurz(body.name, 100);
  const kontakt = ['KONTAKT', '• Name / Hausverwaltung: ' + name, '• E-Mail: ' + body.email, '• Telefon: ' + (kurz(body.telefon, 30) || '-')];
  const intern = ['Neue Anfrage über den Online-Kalkulator', '', ...kontakt, '', ...objekt, '', ...leistungen, '',
    ...preisIntern, '', 'Dem Kunden angezeigt:', ...preisKunde.slice(1, 4)].join('\n');
  const kunde = ['Guten Tag ' + name + ',', '',
    'vielen Dank für Ihre Anfrage über unseren Online-Kalkulator. Hier Ihre Angaben im Überblick – wir melden uns zeitnah für einen Besichtigungstermin.', '',
    ...objekt, '', ...leistungen, '', ...preisKunde, '', 'Mit freundlichen Grüßen', FIRMA.name,
    'Tel. ' + FIRMA.telefon + ' · ' + MAIL_EMPFAENGER, FIRMA.web].join('\n');
  const objektKurz = [...objekt.slice(1), ...leistungen.slice(1).filter(z => !z.endsWith('NEIN'))].join('\n');
  return { intern, kunde, name, objektKurz };
}

app.post('/api/sende-anfrage', anfrageLimiter, async (req, res) => {
  const fehler = pruefeAnfrage(req.body);
  if (fehler) return res.status(400).json({ ok: false, fehler });
  if (!mailer || !MAIL_EMPFAENGER) return res.status(503).json({ ok: false, fehler: 'E-Mail-Versand ist nicht eingerichtet.' });
  try {
    const { intern, kunde, name } = baueMails(req.body);
    await mailer.sendMail({
      from: SMTP_FROM, to: MAIL_EMPFAENGER, replyTo: req.body.email,
      subject: 'Online-Kalkulation: ' + name, text: intern
    });
    await mailer.sendMail({
      from: SMTP_FROM, to: req.body.email, replyTo: MAIL_EMPFAENGER,
      subject: 'Ihre Anfrage bei ' + FIRMA.name + ' – Zusammenfassung', text: kunde
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('E-Mail-Versand fehlgeschlagen:', err.message);
    res.status(502).json({ ok: false, fehler: 'E-Mail konnte nicht gesendet werden.' });
  }
});

/* Gesundheitscheck für Render */
app.get('/', (req, res) => res.send('Kalkulator-Lexoffice-Server läuft.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server läuft auf Port ' + PORT));

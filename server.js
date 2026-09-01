/**
 * KfzGut-AI – Backend Server (Railway-kompatibel)
 * Verwendet PostgreSQL (Railway Plugin) statt SQLite
 */

require('dotenv').config();
const express    = require('express');
const { Pool }   = require('pg');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const Stripe     = require('stripe');
const nodemailer = require('nodemailer');
const cors       = require('cors');
const cron       = require('node-cron');
const path       = require('path');
const multer     = require('multer');
const { execSync } = require('child_process');
const fs         = require('fs');
const os         = require('os');

// Multer: store PDF in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'text/plain'];
    if (allowed.includes(file.mimetype) || file.originalname.endsWith('.txt')) {
      cb(null, true);
    } else {
      cb(new Error('Nur PDF und TXT erlaubt'));
    }
  }
});

// ─── ABSTURZSICHERUNG ─────────────────────────────────────────────────────────
// Ab Node 15 beendet eine unbehandelte Promise-Rejection den Prozess.
// Ohne diese Handler legt ein einzelner DB-Fehler den Server für alle lahm.
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err && err.stack ? err.stack : err);
});

const app    = express();

// ─── ASYNC-FEHLER AN DIE FEHLER-MIDDLEWARE WEITERREICHEN ──────────────────────
// Express 4 fängt Rejections aus async-Handlern nicht ab. Ohne diese Umhüllung
// bleibt die Anfrage unbeantwortet hängen und der Prozess kann abstürzen.
// Wir überschreiben die Registrierungsmethoden einmalig – alle Endpunkte
// darunter sind damit automatisch abgesichert.
['get', 'post', 'put', 'delete', 'patch'].forEach((verb) => {
  const original = app[verb].bind(app);
  app[verb] = (path, ...handlers) => {
    const wrapped = handlers.map((h) =>
      typeof h === 'function' && h.constructor.name === 'AsyncFunction'
        ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)
        : h
    );
    return original(path, ...wrapped);
  };
});
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ─── DATABASE (PostgreSQL) ────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

// ─── INIT DATABASE ────────────────────────────────────────────────────────────
async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id                     SERIAL PRIMARY KEY,
      email                  TEXT UNIQUE NOT NULL,
      password_hash          TEXT NOT NULL,
      name                   TEXT DEFAULT '',
      company                TEXT DEFAULT '',
      stripe_customer_id     TEXT,
      stripe_subscription_id TEXT,
      plan                   TEXT DEFAULT 'trial',
      plan_status            TEXT DEFAULT 'active',
      trial_starts_at        INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
      trial_ends_at          INTEGER,
      trial_warning_sent     INTEGER DEFAULT 0,
      api_calls_month        INTEGER DEFAULT 0,
      api_calls_reset_at     INTEGER DEFAULT 0,
      created_at             INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
      last_login_at          INTEGER,
      email_verified         INTEGER DEFAULT 0,
      verify_token           TEXT
    )
  `);
  // Add columns if they don't exist (for existing DBs)
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER DEFAULT 0').catch(()=>{});
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token TEXT').catch(()=>{});
  // Team/Multi-User: team_owner_id = NULL bei Eigentümer/Einzelnutzer, sonst ID des Hauptaccounts
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS team_owner_id INTEGER').catch(()=>{});
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_seats INTEGER DEFAULT 1').catch(()=>{});
  // Nutzungszähler: getrennt nach Prüfungen und Textbausteinen, plus Gesamtsummen
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS checks_total INTEGER DEFAULT 0').catch(()=>{});
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS prompts_total INTEGER DEFAULT 0').catch(()=>{});
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_activity_at INTEGER').catch(()=>{});
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS activation_mail_sent INTEGER DEFAULT 0').catch(()=>{});
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS winback_mail_sent INTEGER DEFAULT 0').catch(()=>{});
  // Einmalige Bereinigung: Team-Mitglieder einheitlich als 'team_member' führen,
  // damit sie nicht als eigenständige zahlende Kunden gezählt werden.
  await query("UPDATE users SET plan='team_member', plan_seats=1 WHERE team_owner_id IS NOT NULL AND plan <> 'team_member'").catch(()=>{});
  // Team-Mitglieder erhalten keine eigene Bestätigungsmail – der Hauptaccount bürgt für sie
  await query("UPDATE users SET email_verified=1 WHERE team_owner_id IS NOT NULL AND email_verified=0").catch(()=>{});
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS free_checks_used INTEGER DEFAULT 0').catch(()=>{});
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS free_prompts_used INTEGER DEFAULT 0').catch(()=>{});

  await query(`
    CREATE TABLE IF NOT EXISTS api_logs (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER,
      prompt_type TEXT,
      tokens      INTEGER DEFAULT 0,
      cost_eur    REAL DEFAULT 0,
      created_at  INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER,
      email      TEXT,
      rating     INTEGER,
      categories TEXT,
      message    TEXT,
      created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
    )
  `);

  console.log('✅ Datenbank initialisiert');
}

// ─── E-MAIL ───────────────────────────────────────────────────────────────────
// SMTP config replaced by Resend API

// Netzaufruf mit Zeitlimit – ohne dieses kann eine hängende Anfrage
// die gesamte Prüfung blockieren (Node-fetch hat keinen Standard-Timeout).
async function fetchWithTimeout(url, options, ms = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function sendMail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY || process.env.SMTP_PASS;
  if (!apiKey) { console.log('[Mail skipped – no API key]', subject); return; }
  try {
    const from = process.env.SMTP_FROM || 'noreply@kfzgut-ai.de';
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({ from: `KfzGut-AI <${from}>`, to, subject, html }),
    });
    if (!r.ok) {
      const e = await r.json();
      console.error('[Mail error]', e.message || JSON.stringify(e));
    } else {
      console.log('[Mail sent]', subject, '->', to);
    }
  } catch (err) {
    console.error('[Mail error]', err.message);
  }
}

const mailBase = (content, footerExtra = '') => `<!DOCTYPE html>
<html><body style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;background:#f0f2f6;padding:32px 16px;margin:0">
<div style="max-width:540px;margin:0 auto">
  <div style="background:#1e2433;border-radius:12px 12px 0 0;padding:22px 32px;display:flex;align-items:center">
    <span style="font-size:22px;color:white;font-family:Georgia,serif;letter-spacing:-0.01em">Kfz<span style="color:rgba(255,255,255,0.6)">Gut</span>-<span style="color:#d95f1a">AI</span></span>
  </div>
  <div style="background:white;padding:32px;border-left:1px solid #e4e6ed;border-right:1px solid #e4e6ed">${content}</div>
  <div style="background:#f0f2f6;border:1px solid #e4e6ed;border-top:none;border-radius:0 0 12px 12px;padding:16px 32px;font-size:12px;color:#9aa0ae;text-align:center;line-height:1.7">
    ${footerExtra}
    <a href="${process.env.FRONTEND_URL}/impressum.html" style="color:#9aa0ae;text-decoration:none">Impressum</a> · 
    <a href="${process.env.FRONTEND_URL}/datenschutz.html" style="color:#9aa0ae;text-decoration:none">Datenschutz</a><br>
    KfzGut-AI · KI-Assistent für Kfz-Sachverständige
  </div>
</div></body></html>`;

const mails = {
  welcome: (name, verifyUrl) => ({
    subject: 'Willkommen bei KfzGut-AI – bestätige deine E-Mail',
    html: mailBase(`
      <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#1e2433;margin:0 0 8px">Willkommen bei KfzGut-AI!</h2>
      <p style="color:#5a6478;font-size:15px;line-height:1.75;margin:0 0 20px">Hallo ${name},<br><br>
      schön, dass Sie dabei sind. Bitte bestätigen Sie zunächst Ihre E-Mail-Adresse um Ihren 7-tägigen Testzugang zu aktivieren – keine Kreditkarte erforderlich.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${verifyUrl}" style="display:inline-block;background:#1a56a0;color:white;padding:14px 32px;border-radius:9px;text-decoration:none;font-size:15px;font-weight:500;letter-spacing:0.01em">E-Mail bestätigen →</a>
      </div>
      <div style="background:#f0f2f6;border-radius:10px;padding:18px 20px;margin:20px 0">
        <p style="font-size:13px;font-weight:600;color:#1e2433;margin:0 0 12px">Was Sie in den nächsten 7 Tagen erwartet:</p>
        <div style="font-size:13px;color:#5a6478;line-height:1.8">
          <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:8px"><span style="color:#d95f1a;font-size:15px;flex-shrink:0">🔍</span> <div><strong style="color:#1e2433">Automatische Prüfung Ihrer Schadengutachten</strong><br>Kompatibilität und Plausibilität des Schadenbildes, Kalkulation und Wertansätze (WBW, Restwert, 130-%-Grenze, merkantiler Minderwert) sowie Formales und Honorar – mit exakten Seitenzahlen und Korrekturvorschlägen.</div></div>
          <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:8px"><span style="color:#1a56a0;font-size:15px;flex-shrink:0">✓</span> Vorschadenabgrenzung und BVSK-Honorarprüfung inklusive</div>
          <div style="display:flex;align-items:flex-start;gap:8px"><span style="color:#1a56a0;font-size:15px;flex-shrink:0">✓</span> Word-Export des Prüfberichts als formatierte Checkliste</div>
        </div>
      </div>
      <div style="background:#e8f5ed;border-radius:8px;padding:12px 16px;margin:16px 0;font-size:13px;color:#1a6e3a">
        🛡️ <strong>Datenschutz:</strong> Ihre Gutachten bleiben lokal in Ihrem Browser. Es werden keine personenbezogenen Daten gespeichert.
      </div>
      <p style="color:#9aa0ae;font-size:12px;line-height:1.65;margin:16px 0 0">Falls Sie sich nicht registriert haben, können Sie diese E-Mail ignorieren.<br><br>Mit freundlichen Grüßen<br><strong style="color:#1e2433">KfzGut-AI</strong></p>`,
      'Falls der Button nicht funktioniert, kopieren Sie diesen Link: ' + verifyUrl + '<br><br>'
    )
  }),
  teamInvite: (name, ownerName, email, password) => ({
    subject: 'Ihr Zugang zu KfzGut-AI',
    html: mailBase(`
      <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#1e2433;margin:0 0 8px">Ihr Zugang zu KfzGut-AI</h2>
      <p style="color:#5a6478;font-size:15px;line-height:1.75;margin:0 0 20px">Hallo ${name},<br><br>
      ${ownerName} hat für Sie einen Zugang zu KfzGut-AI eingerichtet. Sie können sich ab sofort mit folgenden Zugangsdaten anmelden:</p>
      <div style="background:#f0f2f6;border-radius:10px;padding:18px 20px;margin:20px 0">
        <div style="font-size:13px;color:#5a6478;line-height:1.9">
          <strong style="color:#1e2433">E-Mail:</strong> ${email}<br>
          <strong style="color:#1e2433">Passwort:</strong> ${password}
        </div>
      </div>
      <p style="color:#5a6478;font-size:13px;line-height:1.7;margin:0 0 20px">Bitte ändern Sie Ihr Passwort nach der ersten Anmeldung unter „Mein Konto“.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${process.env.FRONTEND_URL}/login.html" style="display:inline-block;background:#1a56a0;color:white;padding:14px 32px;border-radius:9px;text-decoration:none;font-size:15px;font-weight:500">Jetzt anmelden →</a>
      </div>
      <p style="color:#9aa0ae;font-size:12px;margin:16px 0 0">Mit freundlichen Grüßen<br><strong style="color:#1e2433">KfzGut-AI</strong></p>`)
  }),
  // Tag 2 – nur an Nutzer, die noch keine Prüfung gestartet haben
  activation: (name) => ({
    subject: 'Ihr erstes Gutachten in 3 Minuten geprüft',
    html: mailBase(`
      <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#1e2433;margin:0 0 8px">Noch kein Gutachten geprüft?</h2>
      <p style="color:#5a6478;font-size:15px;line-height:1.75;margin:0 0 20px">Hallo ${name},<br><br>
      Ihr Testzugang läuft – bisher haben Sie das Tool aber noch nicht ausprobiert. Der Einstieg dauert weniger als drei Minuten:</p>
      <div style="background:#f0f2f6;border-radius:10px;padding:18px 20px;margin:20px 0">
        <div style="font-size:13px;color:#5a6478;line-height:2">
          <strong style="color:#1e2433">1.</strong> Ein fertiges Gutachten als PDF hochladen<br>
          <strong style="color:#1e2433">2.</strong> Auf „Jetzt prüfen" klicken<br>
          <strong style="color:#1e2433">3.</strong> Prüfbericht mit Seitenzahlen erhalten
        </div>
      </div>
      <p style="color:#5a6478;font-size:14px;line-height:1.7;margin:0 0 20px">Am aussagekräftigsten ist ein Gutachten, das Sie bereits abgegeben haben – dann sehen Sie direkt, was das Tool zusätzlich findet.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${process.env.FRONTEND_URL}/app.html" style="display:inline-block;background:#d95f1a;color:white;padding:14px 32px;border-radius:9px;text-decoration:none;font-size:15px;font-weight:500">Jetzt erstes Gutachten prüfen →</a>
      </div>
      <p style="color:#9aa0ae;font-size:12px;line-height:1.65;margin:16px 0 0">Falls etwas nicht funktioniert, antworten Sie einfach auf diese E-Mail.<br><br>Mit freundlichen Grüßen<br><strong style="color:#1e2433">KfzGut-AI</strong></p>`)
  }),
  // Tag 10 – Rückholmail nach abgelaufenem Test
  winback: (name, usedTool) => ({
    subject: 'Ihr Testzugang ist abgelaufen – kurze Rückfrage',
    html: mailBase(`
      <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#1e2433;margin:0 0 8px">Kurze Rückfrage</h2>
      <p style="color:#5a6478;font-size:15px;line-height:1.75;margin:0 0 20px">Hallo ${name},<br><br>
      ${usedTool
        ? 'Sie haben KfzGut-AI im Testzeitraum genutzt, sich aber bisher nicht für ein Abonnement entschieden. Mich würde interessieren, woran es lag – hat etwas nicht funktioniert, oder passt das Tool nicht zu Ihrem Arbeitsablauf?'
        : 'Ihr Testzugang ist abgelaufen, ohne dass Sie dazu gekommen sind, das Tool auszuprobieren. Falls Sie noch Interesse haben, richte ich Ihnen gerne einen neuen Testzeitraum ein – schreiben Sie mir einfach kurz.'}</p>
      <p style="color:#5a6478;font-size:14px;line-height:1.7;margin:0 0 20px">Eine kurze Antwort auf diese E-Mail genügt. Jede Rückmeldung hilft mir, das Tool besser zu machen.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${process.env.FRONTEND_URL}/konto.html" style="display:inline-block;background:#1a56a0;color:white;padding:14px 32px;border-radius:9px;text-decoration:none;font-size:15px;font-weight:500">Zugang reaktivieren →</a>
      </div>
      <p style="color:#9aa0ae;font-size:12px;margin:16px 0 0">Mit freundlichen Grüßen<br><strong style="color:#1e2433">KfzGut-AI</strong></p>`)
  }),
  teamOwnerLeft: (name) => ({
    subject: 'Ihr KfzGut-AI Zugang wurde umgestellt',
    html: mailBase(`
      <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#1e2433;margin:0 0 8px">Ihr Zugang wurde umgestellt</h2>
      <p style="color:#5a6478;font-size:15px;line-height:1.75;margin:0 0 20px">Hallo ${name},<br><br>
      der Hauptaccount Ihres Büros wurde gelöscht. Damit endet der bisherige Büro-Zugang.</p>
      <p style="color:#5a6478;font-size:15px;line-height:1.75;margin:0 0 20px">
      Ihr persönlicher Zugang bleibt bestehen und wurde auf einen eigenständigen Account mit
      <strong style="color:#1e2433">7 Tagen Testzeitraum</strong> umgestellt. Ihre Anmeldedaten bleiben unverändert.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${process.env.FRONTEND_URL}/login.html" style="display:inline-block;background:#1a56a0;color:white;padding:14px 32px;border-radius:9px;text-decoration:none;font-size:15px;font-weight:500">Zum Login →</a>
      </div>
      <p style="color:#9aa0ae;font-size:12px;margin:16px 0 0">Mit freundlichen Grüßen<br><strong style="color:#1e2433">KfzGut-AI</strong></p>`)
  }),
  trialWarning: (name, days) => ({
    subject: `Ihr KfzGut-AI Testzugang endet in ${days} ${days === 1 ? 'Tag' : 'Tagen'}`,
    html: mailBase(`
      <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#1e2433;margin:0 0 8px">Noch ${days} ${days === 1 ? 'Tag' : 'Tage'} Testzugang</h2>
      <p style="color:#5a6478;font-size:15px;line-height:1.75;margin:0 0 20px">Hallo ${name},<br><br>
      Ihr kostenloser Testzeitraum endet in ${days} ${days === 1 ? 'Tag' : 'Tagen'}. Um weiterhin alle Funktionen zu nutzen, abonnieren Sie jetzt für 99 €/Monat inkl. 19% USt..</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${process.env.FRONTEND_URL}/konto.html" style="display:inline-block;background:#d95f1a;color:white;padding:14px 32px;border-radius:9px;text-decoration:none;font-size:15px;font-weight:500">Jetzt abonnieren →</a>
      </div>
      <p style="color:#9aa0ae;font-size:12px;margin:16px 0 0">Mit freundlichen Grüßen<br><strong style="color:#1e2433">KfzGut-AI</strong></p>`)
  }),
  trialExpired: (name) => ({
    subject: 'Ihr KfzGut-AI Testzeitraum ist abgelaufen',
    html: mailBase(`
      <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#1e2433;margin:0 0 8px">Testzeitraum abgelaufen</h2>
      <p style="color:#5a6478;font-size:15px;line-height:1.75;margin:0 0 20px">Hallo ${name},<br><br>
      Ihr kostenloser Testzeitraum ist abgelaufen. Abonnieren Sie jetzt um wieder vollen Zugriff auf alle Prüf- und Generierungsfunktionen zu erhalten.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${process.env.FRONTEND_URL}/konto.html" style="display:inline-block;background:#1a56a0;color:white;padding:14px 32px;border-radius:9px;text-decoration:none;font-size:15px;font-weight:500">Jetzt abonnieren – ab 69 €/Monat →</a>
      </div>
      <p style="color:#9aa0ae;font-size:12px;margin:16px 0 0">Mit freundlichen Grüßen<br><strong style="color:#1e2433">KfzGut-AI</strong></p>`)
  }),
  paymentFailed: (name) => ({
    subject: 'Zahlungsproblem bei KfzGut-AI – Bitte aktualisieren',
    html: mailBase(`
      <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#1e2433;margin:0 0 8px">Zahlung fehlgeschlagen</h2>
      <p style="color:#5a6478;font-size:15px;line-height:1.75;margin:0 0 20px">Hallo ${name},<br><br>
      bei deiner letzten Zahlung gab es leider ein Problem. Bitte aktualisiere deine Zahlungsdaten um deinen Zugang zu sichern.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${process.env.FRONTEND_URL}/konto.html" style="display:inline-block;background:#d95f1a;color:white;padding:14px 32px;border-radius:9px;text-decoration:none;font-size:15px;font-weight:500">Zahlungsdaten aktualisieren →</a>
      </div>
      <p style="color:#9aa0ae;font-size:12px;margin:16px 0 0">Mit freundlichen Grüßen<br><strong style="color:#1e2433">KfzGut-AI</strong></p>`)
  }),
  subscriptionActive: (name) => ({
    subject: 'KfzGut-AI – Abonnement aktiv ✓',
    html: mailBase(`
      <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#1e2433;margin:0 0 8px">Abonnement aktiv ✓</h2>
      <p style="color:#5a6478;font-size:15px;line-height:1.75;margin:0 0 20px">Hallo ${name},<br><br>
      dein Abonnement ist aktiv. Du hast vollen Zugriff auf alle Funktionen von KfzGut-AI.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${process.env.FRONTEND_URL}/app.html" style="display:inline-block;background:#1a56a0;color:white;padding:14px 32px;border-radius:9px;text-decoration:none;font-size:15px;font-weight:500">Zum Tool →</a>
      </div>
      <p style="color:#9aa0ae;font-size:12px;margin:16px 0 0">Mit freundlichen Grüßen<br><strong style="color:#1e2433">KfzGut-AI</strong></p>`)
  }),
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || (() => { console.warn('WARNING: JWT_SECRET not set!'); return 'change-me-in-production'; })();

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Nicht angemeldet' });
  try { req.user = jwt.verify(auth.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Sitzung abgelaufen' }); }
}

function adminMiddleware(req, res, next) {
  if (!process.env.ADMIN_SECRET) {
    console.error('ADMIN_SECRET ist nicht gesetzt – Admin-Zugriff nicht möglich');
    return res.status(500).json({ error: 'ADMIN_SECRET ist auf dem Server nicht konfiguriert' });
  }
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'Falsches Admin-Passwort' });
  next();
}

// Lädt einen User inkl. Team-Kontext. Bei Team-Mitgliedern wird das Abo
// des Hauptaccounts (team_owner_id) als _billing angehängt.
async function loadUser(userId) {
  const r = await query('SELECT * FROM users WHERE id=$1', [userId]);
  const user = r.rows[0];
  if (!user) return null;
  if (user.team_owner_id) {
    const o = await query('SELECT * FROM users WHERE id=$1', [user.team_owner_id]);
    user._billing = o.rows[0] || null;
    user._isTeamMember = true;
  } else {
    user._billing = user;
    user._isTeamMember = false;
  }
  return user;
}

function hasAccess(user) {
  if (!user) return false;
  // Eigenständige Accounts müssen ihre E-Mail bestätigt haben.
  // Team-Mitglieder werden vom Hauptaccount angelegt – dieser bürgt für sie,
  // sie erhalten keine eigene Bestätigungsmail.
  if (!user._isTeamMember && !user.email_verified) return false;
  // Team-Mitglieder: Zugang richtet sich nach dem Abo des Hauptaccounts
  const b = user._billing || user;
  if (!b) return false;
  if (user._isTeamMember && !b.email_verified) return false;
  // 7-Tage-Test ohne Zahlungsmittel
  if (b.plan === 'trial' && b.plan_status === 'active') {
    return Math.floor(Date.now() / 1000) < b.trial_ends_at;
  }
  // Aktives Abo
  if (b.plan === 'active_sub' && b.plan_status === 'active') return true;
  return false;
}

// Zählt eine Nutzung. kind: 'check' (Prüfung) oder 'prompt' (Textbaustein).
// Setzt den Monatszähler zurück, wenn der Zeitraum abgelaufen ist – für BEIDE Endpunkte.
async function trackUsage(userId, kind) {
  const now = Math.floor(Date.now() / 1000);
  const r = await query('SELECT api_calls_reset_at FROM users WHERE id=$1', [userId]);
  const resetAt = r.rows[0] ? r.rows[0].api_calls_reset_at : 0;
  if (!resetAt || now > resetAt) {
    await query('UPDATE users SET api_calls_month=0, api_calls_reset_at=$1 WHERE id=$2',
      [now + 30 * 24 * 3600, userId]);
  }
  const totalCol = kind === 'check' ? 'checks_total' : 'prompts_total';
  await query(
    `UPDATE users SET api_calls_month=api_calls_month+1, ${totalCol}=${totalCol}+1, last_activity_at=$1 WHERE id=$2`,
    [now, userId]
  );
}

function trialDaysRemaining(user) {
  if (!user || user.plan !== 'trial') return 0;
  const secs = (user.trial_ends_at || 0) - Math.floor(Date.now() / 1000);
  return Math.max(0, Math.ceil(secs / 86400));
}


// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

// ─── REGISTER ─────────────────────────────────────────────────────────────────
// ─── EINGABEPRÜFUNG & BRUTE-FORCE-SCHUTZ ──────────────────────────────────────
function cleanStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}
function isValidEmail(v) {
  if (typeof v !== 'string') return false;
  const e = v.trim();
  if (e.length < 5 || e.length > 254) return false;
  // Struktur: etwas@etwas.tld – fängt Tippfehler wie fehlende Endung ab
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e);
}

// Einfacher Zähler im Arbeitsspeicher – reicht für einen einzelnen Serverprozess
const loginAttempts = new Map();
function tooManyAttempts(key, max = 8, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (!rec || now - rec.first > windowMs) {
    loginAttempts.set(key, { count: 1, first: now });
    return false;
  }
  rec.count++;
  return rec.count > max;
}
function resetAttempts(key) { loginAttempts.delete(key); }
// Alte Einträge stündlich aufräumen, damit die Map nicht wächst
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [k, v] of loginAttempts) if (v.first < cutoff) loginAttempts.delete(k);
}, 60 * 60 * 1000).unref();

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  const name    = cleanStr(req.body.name, 120);
  const company = cleanStr(req.body.company, 160);
  if (!email || !password) return res.status(400).json({ error: 'E-Mail und Passwort erforderlich' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Passwort mindestens 8 Zeichen' });
  if (password.length > 200) return res.status(400).json({ error: 'Passwort zu lang' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Bitte geben Sie eine gültige E-Mail-Adresse ein' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const now = Math.floor(Date.now() / 1000);
    const trialEnd = now + 7 * 24 * 3600; // 7-day free trial, no credit card

    // Generate email verification token
    const verifyToken = require('crypto').randomBytes(32).toString('hex');

    // No Stripe customer created at registration – only when user subscribes after trial
    const result = await query(
      `INSERT INTO users (email, password_hash, name, company, plan, plan_status, trial_starts_at, trial_ends_at, email_verified, verify_token)
       VALUES ($1,$2,$3,$4,'trial','active',$5,$6,0,$7) RETURNING id`,
      [email.toLowerCase(), hash, name||'', company||'', now, trialEnd, verifyToken]
    );

    const authToken = signToken(result.rows[0].id);

    // Send verification email
    const verifyUrl = `${process.env.FRONTEND_URL}/verify.html?token=${verifyToken}`;
    const m = mails.welcome(name || email.split('@')[0], verifyUrl);
    await sendMail(email, m.subject, m.html);

    res.json({ token: authToken, user: { email, name, plan: 'trial', trialEndsAt: trialEnd, hasAccess: false, emailVerified: false } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'E-Mail bereits registriert' });
    console.error(err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'E-Mail und Passwort erforderlich' });
  }
  // Brute-Force-Schutz: nach 8 Fehlversuchen je E-Mail 15 Minuten Sperre
  const key = email.toLowerCase();
  if (tooManyAttempts(key)) {
    return res.status(429).json({ error: 'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.' });
  }
  const result = await query('SELECT * FROM users WHERE email=$1', [key]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'E-Mail oder Passwort falsch' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'E-Mail oder Passwort falsch' });
  resetAttempts(key);
  await query('UPDATE users SET last_login_at=$1 WHERE id=$2', [Math.floor(Date.now()/1000), user.id]);
  // Team-Kontext auflösen: Mitglieder erben Plan und Zugang vom Hauptaccount
  const full = await loadUser(user.id);
  const b = (full && full._billing) || user;
  res.json({
    token: signToken(user.id),
    user: { email: user.email, name: user.name, company: user.company,
      plan: b.plan, planStatus: b.plan_status, trialEndsAt: b.trial_ends_at,
      hasAccess: hasAccess(full || user), callsThisMonth: user.api_calls_month,
      trialDaysRemaining: trialDaysRemaining(b),
      isTeamMember: !!(full && full._isTeamMember),
      planSeats: b.plan_seats || 1,
      emailVerified: !!user.email_verified }
  });
});

// ─── ME ───────────────────────────────────────────────────────────────────────
app.get('/api/me', authMiddleware, async (req, res) => {
  // Fast path: JWT is valid, return minimal response immediately if DB is slow
  res.setTimeout(8000, () => {
    if (!res.headersSent) res.json({ email: '', name: '', plan: 'trial', hasAccess: true, emailVerified: true, _cached: true });
  });
  const user = await loadUser(req.user.userId);
  if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
  const b = user._billing || user;
  let teamMembers = [];
  if (!user._isTeamMember) {
    const tm = await query('SELECT id, email, name, created_at FROM users WHERE team_owner_id=$1 ORDER BY id', [user.id]);
    teamMembers = tm.rows;
  }
  res.json({ email: user.email, name: user.name, company: user.company,
    plan: b.plan, planStatus: b.plan_status, trialEndsAt: b.trial_ends_at,
    hasAccess: hasAccess(user), callsThisMonth: user.api_calls_month, createdAt: user.created_at,
    trialDaysRemaining: trialDaysRemaining(b),
    checksTotal: user.checks_total || 0,
    promptsTotal: user.prompts_total || 0,
    lastActivityAt: user.last_activity_at || null,
    emailVerified: !!user.email_verified,
    isTeamMember: !!user._isTeamMember,
    planSeats: b.plan_seats || 1,
    teamMembers,
    seatsUsed: teamMembers.length + 1 });
});

// ─── UPDATE PROFILE ───────────────────────────────────────────────────────────
app.put('/api/me', authMiddleware, async (req, res) => {
  const { name, company, password, currentPassword } = req.body;
  const user = await loadUser(req.user.userId);
  if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
  if (password) {
    const ok = await bcrypt.compare(currentPassword||'', user.password_hash);
    if (!ok) return res.status(400).json({ error: 'Aktuelles Passwort falsch' });
    const hash = await bcrypt.hash(password, 12);
    await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user.id]);
  }
  await query('UPDATE users SET name=$1, company=$2 WHERE id=$3', [name??user.name, company??user.company, user.id]);
  res.json({ ok: true });
});

// ─── TEAM / MULTI-USER ────────────────────────────────────────────────────────
// Nur der Hauptaccount (team_owner_id IS NULL) mit Team-Tarif kann Mitglieder verwalten.

app.get('/api/team', authMiddleware, async (req, res) => {
  const user = await loadUser(req.user.userId);
  if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
  if (user._isTeamMember) return res.status(403).json({ error: 'Nur der Hauptaccount kann das Team verwalten' });
  const tm = await query('SELECT id, email, name, created_at FROM users WHERE team_owner_id=$1 ORDER BY id', [user.id]);
  res.json({
    seats: user.plan_seats || 1,
    seatsUsed: tm.rows.length + 1,
    members: tm.rows,
    canAdd: (user.plan_seats || 1) > (tm.rows.length + 1),
  });
});

app.post('/api/team', authMiddleware, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'E-Mail und Passwort erforderlich' });
  if (password.length < 8) return res.status(400).json({ error: 'Passwort mindestens 8 Zeichen' });

  const user = await loadUser(req.user.userId);
  if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
  if (user._isTeamMember) return res.status(403).json({ error: 'Nur der Hauptaccount kann Mitglieder hinzufügen' });

  const seats = user.plan_seats || 1;
  if (seats < 2) return res.status(403).json({ error: 'Ihr Tarif erlaubt keine weiteren Nutzer. Bitte auf den Büro-Tarif wechseln.', code: 'UPGRADE_SEATS' });

  const tm = await query('SELECT id FROM users WHERE team_owner_id=$1', [user.id]);
  if (tm.rows.length + 1 >= seats) {
    return res.status(403).json({ error: `Maximale Nutzerzahl erreicht (${seats}).`, code: 'SEATS_FULL' });
  }

  const exists = await query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
  if (exists.rows.length) return res.status(400).json({ error: 'Diese E-Mail-Adresse ist bereits registriert' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const now = Math.floor(Date.now() / 1000);
    const ins = await query(
      `INSERT INTO users (email, password_hash, name, company, plan, plan_status, trial_starts_at, trial_ends_at, email_verified, team_owner_id, plan_seats)
       VALUES ($1,$2,$3,$4,'team_member','active',$5,$5,1,$6,1) RETURNING id, email, name, created_at`,
      [email.toLowerCase(), hash, name || '', user.company || '', now, user.id]
    );
    const member = ins.rows[0];
    try {
      const m = mails.teamInvite(name || email.split('@')[0], user.name || user.email, email, password);
      await sendMail(email, m.subject, m.html);
    } catch (e) { console.warn('Team-Invite Mail:', e.message); }
    res.json({ ok: true, member });
  } catch (err) {
    console.error('Team add error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/team/:id', authMiddleware, async (req, res) => {
  const user = await loadUser(req.user.userId);
  if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
  if (user._isTeamMember) return res.status(403).json({ error: 'Nur der Hauptaccount kann Mitglieder entfernen' });
  const memberId = parseInt(req.params.id, 10);
  const m = await query('SELECT id FROM users WHERE id=$1 AND team_owner_id=$2', [memberId, user.id]);
  if (!m.rows.length) return res.status(404).json({ error: 'Mitglied nicht gefunden' });
  await query('DELETE FROM users WHERE id=$1', [memberId]);
  res.json({ ok: true });
});

// ─── VERIFY EMAIL ────────────────────────────────────────────────────────────
app.get('/api/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Kein Token' });
  try {
    const result = await query('SELECT * FROM users WHERE verify_token=$1', [token]);
    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: 'Ungültiger oder abgelaufener Link' });
    if (user.email_verified) return res.json({ ok: true, alreadyVerified: true });
    await query('UPDATE users SET email_verified=1, verify_token=NULL WHERE id=$1', [user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// ─── CHECKOUT ─────────────────────────────────────────────────────────────────
app.post('/api/checkout', authMiddleware, async (req, res) => {
  const user = await loadUser(req.user.userId);
  if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
  try {
    // Create Stripe customer on demand if not exists yet
    let stripeCustomerId = user.stripe_customer_id;
    if (!stripeCustomerId) {
      const cust = await stripe.customers.create({
        email: user.email,
        name: user.name || user.email,
        description: 'KfzGut-AI Abonnent',
        metadata: { userId: String(user.id) },
      });
      stripeCustomerId = cust.id;
      await query('UPDATE users SET stripe_customer_id=$1 WHERE id=$2', [stripeCustomerId, user.id]);
    }

    if (user._isTeamMember) return res.status(403).json({
      error: 'Ihr Zugang läuft über den Hauptaccount Ihres Büros. Ein eigenes Abonnement ist nicht erforderlich.',
      code: 'TEAM_MEMBER' });

    // Tarif: 'solo' (1 Nutzer, 69 €) oder 'team' (bis 5 Nutzer, 99 €)
    const planType = (req.body && req.body.plan === 'team') ? 'team' : 'solo';
    const priceId = planType === 'team'
      ? (process.env.STRIPE_PRICE_ID_TEAM || process.env.STRIPE_PRICE_ID)
      : (process.env.STRIPE_PRICE_ID_SOLO || process.env.STRIPE_PRICE_ID);
    if (!priceId) return res.status(500).json({ error: 'Preis-ID nicht konfiguriert' });
    const seats = planType === 'team' ? 5 : 1;

    const baseSession = {
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/app.html?checkout=success`,
      payment_method_types: ['card', 'sepa_debit'],
      billing_address_collection: 'required',
      cancel_url: `${process.env.FRONTEND_URL}/konto.html`,
      metadata: { userId: String(user.id), planType, seats: String(seats) },
      subscription_data: {
        metadata: { userId: String(user.id), planType, seats: String(seats) },
      },
    };

    let session;
    try {
      // Bevorzugt: mit automatischer Steuerberechnung (19% USt)
      session = await stripe.checkout.sessions.create({
        ...baseSession,
        automatic_tax: { enabled: true },
        customer_update: { address: 'auto', name: 'auto' },
        tax_id_collection: { enabled: true },
      });
    } catch (taxErr) {
      // Fallback: falls Stripe Tax nicht aktiviert/konfiguriert ist, Checkout trotzdem ermöglichen
      console.warn('automatic_tax fehlgeschlagen, Fallback ohne Steuerautomatik:', taxErr.message);
      session = await stripe.checkout.sessions.create(baseSession);
    }
    res.json({ url: session.url });
  } catch (err) {
    console.error('=== CHECKOUT ERROR ===');
    console.error('Message:', err.message);
    console.error('Type:', err.type);
    console.error('Code:', err.code);
    console.error('STRIPE_PRICE_ID:', process.env.STRIPE_PRICE_ID);
    console.error('SK prefix:', process.env.STRIPE_SECRET_KEY?.slice(0,12));
    res.status(500).json({ error: err.message });
  }
});

// ─── PORTAL ───────────────────────────────────────────────────────────────────
app.post('/api/portal', authMiddleware, async (req, res) => {
  const user = await loadUser(req.user.userId);
  if (!user?.stripe_customer_id) return res.status(400).json({ error: 'Kein Stripe-Konto' });
  try {
    const s = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id, return_url: `${process.env.FRONTEND_URL}/konto.html` });
    res.json({ url: s.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.error('[WEBHOOK] STRIPE_WEBHOOK_SECRET fehlt – Zahlungen werden nicht verbucht!');
    } else {
      console.error('[WEBHOOK] Signaturprüfung fehlgeschlagen:', err.message);
    }
    return res.status(400).send('Webhook error: ' + err.message);
  }

  const obj = event.data.object;
  const userId = obj.metadata?.userId;

  if (event.type === 'checkout.session.completed' && userId) {
    const seats = parseInt(obj.metadata?.seats || '1', 10) || 1;
    await query(`UPDATE users SET stripe_subscription_id=$1, plan='active_sub', plan_status='active', plan_seats=$3 WHERE id=$2`,
      [obj.subscription, userId, seats]);
    const u = (await query('SELECT * FROM users WHERE id=$1', [userId])).rows[0];
    if (u) { const m = mails.subscriptionActive(u.name||u.email.split('@')[0]); await sendMail(u.email, m.subject, m.html); }
  }
  if (event.type === 'customer.subscription.updated' && userId) {
    // 'trialing' zählt wie aktiv – sonst würde ein Stripe-Trial den Zugang sperren
    const active = obj.status === 'active' || obj.status === 'trialing';
    await query('UPDATE users SET plan_status=$1 WHERE id=$2', [active ? 'active' : obj.status, userId]);
  }

  // Rückweg aus 'past_due': gelingt eine zuvor gescheiterte Zahlung doch noch
  // (bei SEPA häufig), muss der Zugang wieder freigeschaltet werden.
  if (event.type === 'invoice.payment_succeeded' || event.type === 'invoice.paid') {
    const u = (await query('SELECT * FROM users WHERE stripe_customer_id=$1', [obj.customer])).rows[0];
    if (u && u.plan_status !== 'active') {
      await query("UPDATE users SET plan='active_sub', plan_status='active' WHERE id=$1", [u.id]);
      console.log(`[WEBHOOK] Zahlung eingegangen – Zugang reaktiviert für ${u.email}`);
    }
  }
  if (event.type === 'customer.subscription.deleted' && userId) {
    await query(`UPDATE users SET plan='cancelled', plan_status='cancelled' WHERE id=$1`, [userId]);
  }
  if (event.type === 'invoice.payment_failed') {
    const u = (await query('SELECT * FROM users WHERE stripe_customer_id=$1', [obj.customer])).rows[0];
    if (u) {
      await query(`UPDATE users SET plan_status='past_due' WHERE id=$1`, [u.id]);
      const m = mails.paymentFailed(u.name||u.email.split('@')[0]); await sendMail(u.email, m.subject, m.html);
    }
  }
  res.json({ received: true });
});

// ─── GENERATE (API Proxy) ─────────────────────────────────────────────────────
app.post('/api/generate', authMiddleware, async (req, res) => {
  const user = await loadUser(req.user.userId);
  if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
  if (!hasAccess(user)) {
    const expired = user.plan === 'trial' && Math.floor(Date.now()/1000) >= user.trial_ends_at;
    return res.status(403).json({ error: expired ? 'Testzeitraum abgelaufen' : 'Kein Zugriff', code: 'UPGRADE_REQUIRED' });
  }


  const { system, prompt, promptType } = req.body;
  if (!system || !prompt) return res.status(400).json({ error: 'system und prompt erforderlich' });

  try {
    await trackUsage(user.id, 'prompt');

    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, system, messages: [{ role: 'user', content: prompt }], stream: true }),
    });
    if (!response.ok) { const e = await response.json(); return res.status(502).json({ error: e.error?.message || 'KI-Fehler' }); }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    let tokens = 0;
    const reader = response.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value);
      res.write(chunk);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try { const p = JSON.parse(line.slice(6)); if (p.usage) tokens += p.usage.output_tokens||0; } catch {}
      }
    }
    const cost = (tokens/1000)*0.003;
    await query('INSERT INTO api_logs (user_id, prompt_type, tokens, cost_eur) VALUES ($1,$2,$3,$4)',
      [user.id, promptType||'unknown', tokens, cost]);
    res.end();
  } catch (err) { console.error(err); if (!res.headersSent) res.status(500).json({ error: 'Serverfehler' }); }
});

// ─── EXTRACT PDF TEXT ────────────────────────────────────────────────────────
app.post('/api/extract-pdf', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen' });

  try {
    // For TXT files: just return the text
    if (req.file.mimetype === 'text/plain' || req.file.originalname.endsWith('.txt')) {
      const text = req.file.buffer.toString('utf-8').replace(/\s+/g, ' ').trim();
      return res.json({ text: text, pages: 1, method: 'txt' });
    }

    // For PDFs: use Python pdfplumber
    const tmpIn = path.join(os.tmpdir(), 'upload_' + Date.now() + '.pdf');
    const tmpPy = path.join(os.tmpdir(), 'extract_' + Date.now() + '.py');

    try {
      fs.writeFileSync(tmpIn, req.file.buffer);

      // Install pdfplumber if needed (cached after first install)
      try {
        execSync('pip install pdfplumber --break-system-packages -q 2>/dev/null || pip3 install pdfplumber --break-system-packages -q 2>/dev/null', { timeout: 30000 });
      } catch {}

      const pyScript = `
import sys, json
try:
    import pdfplumber
    pages = []
    with pdfplumber.open(sys.argv[1]) as pdf:
        for page in pdf.pages:
            try:
                t = page.extract_text()
                if t and t.strip():
                    pages.append(t.strip())
            except:
                pass
    text = "\n\n".join(pages)
    # Remove personal data patterns (names from Grundbuch etc not needed)
    print(json.dumps({"text": text[:15000], "pages": len(pdf.pages) if hasattr(pdf, "pages") else 0}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

      fs.writeFileSync(tmpPy, pyScript);

      let pyOut;
      try {
        pyOut = execSync(`python3 "${tmpPy}" "${tmpIn}" 2>/dev/null`, { timeout: 30000 }).toString().trim();
      } catch (e) {
        pyOut = JSON.stringify({ error: e.message });
      }

      // Clean up
      try { fs.unlinkSync(tmpIn); } catch {}
      try { fs.unlinkSync(tmpPy); } catch {}

      let result;
      try { result = JSON.parse(pyOut); } catch { result = { error: 'Parse error' }; }

      if (result.error || !result.text || result.text.length < 100) {
        return res.status(422).json({
          error: 'PDF enthält keinen lesbaren Text – möglicherweise gescannt. Bitte Text manuell kopieren.',
          suggestion: 'text'
        });
      }

      // Clean text
      const clean = result.text
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();

      res.json({ text: clean, pages: result.pages || 0, method: 'pdfplumber' });

    } catch (execErr) {
      try { fs.unlinkSync(tmpIn); } catch {}
      try { fs.unlinkSync(tmpPy); } catch {}
      throw execErr;
    }

  } catch (err) {
    console.error('PDF extract error:', err.message);
    res.status(500).json({ error: 'PDF konnte nicht verarbeitet werden: ' + err.message });
  }
});

// ─── REVIEW – 3-Ebenen-Prüfung ───────────────────────────────────────────────
app.post('/api/review', authMiddleware, async (req, res) => {
  const user = await loadUser(req.user.userId);
  if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
  if (!hasAccess(user)) return res.status(403).json({ error: 'Testzeitraum abgelaufen', code: 'UPGRADE_REQUIRED', trialDaysRemaining: 0 });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt erforderlich' });

  const systemPrompt = `Du bist öffentlich bestellter und vereidigter Sachverständiger für das Kraftfahrzeugwesen (BVSK, DEKRA/TÜV-Prüfingenieur) mit 20 Jahren Erfahrung in der Schadengutachten-Erstellung. Du prüfst Schadengutachten wie ein erfahrener Kollege der gegenliest – oder wie ein Prüfdienstleister der Versicherung, der nach Kürzungsansätzen sucht.

Der Text stammt aus einem PDF mit Seitenmarkierungen [Seite X]. PDF-Layoutartefakte und Zahlenkolonnen (Kalkulationsausdrucke, Ersatzteilnummern, AW-Werte) ignorieren.

GRUNDPRINZIP – SEHR WICHTIG:
Nenne NUR echte Fehler und klare Lücken. Nenne KEINE plausiblen, üblichen oder fachlich vertretbaren Aussagen.
Wenn ein Wert oder eine Formulierung im Rahmen des Üblichen liegt → NICHT nennen, auch wenn du es anders machen würdest.
Lieber 3 echte Fehler als 10 Pseudo-Hinweise. Kurze, konkrete Liste – kein Vollständigkeitsanspruch.

AMPEL:
- "rot" = echter schwerer Fehler, der das Gutachten angreifbar macht oder eine Kürzung durch die Versicherung provoziert
- "gelb" = echte Lücke oder Unklarheit die behoben werden sollte
- "gruen" = alles in Ordnung
- Kategorie ohne Beanstandungen → ampel IMMER "gruen"
- Kategorien Rechtschreibung, Platzhalter, Formales → maximal "gelb", nie "rot"

Antworte NUR als reines JSON, kein Text, keine Backticks:

{
  "kategorien": [
    { "name": "Kritische Fehler", "ampel": "gruen", "punkte": ["Keine Beanstandungen"] },
    { "name": "Plausibilitaet und Kompatibilitaet", "ampel": "gruen", "punkte": ["Keine Beanstandungen"] },
    { "name": "Kalkulation und Wertansaetze", "ampel": "gruen", "punkte": ["Keine Beanstandungen"] },
    { "name": "Offene Platzhalter", "ampel": "gruen", "punkte": ["Keine Beanstandungen"] },
    { "name": "Rechtschreibung und Sprache", "ampel": "gruen", "punkte": ["Keine Beanstandungen"] },
    { "name": "Formales und Honorar", "ampel": "gruen", "punkte": ["Keine Beanstandungen"] }
  ]
}

KATEGORIE 1 – Kritische Fehler (ampel "rot" wenn vorhanden):
Nur eintragen wenn EINDEUTIG nachweisbar:
- Netto/Brutto-Verwechslung: Reparaturkosten netto gegen Wiederbeschaffungswert brutto gerechnet, oder Restwert netto angesetzt (Restwert ist immer brutto)
- Gleicher Wert (Reparaturkosten, WBW, Restwert, Laufleistung) an zwei Stellen unterschiedlich
- Fahrzeugidentität widersprüchlich: FIN, amtliches Kennzeichen, Typschlüssel oder Erstzulassung passen nicht zusammen
- Rechnerischer Fehler in der Schadenhöhe: Summe der Positionen stimmt nicht mit dem ausgewiesenen Endbetrag überein
- Besichtigungsdatum liegt vor dem Schadendatum oder Stichtag fehlt komplett
- Satz bricht mitten im Text ab oder ein Abschnitt fehlt erkennbar

KATEGORIE 2 – Plausibilitaet und Kompatibilitaet (ampel "rot" oder "gelb"):
Das Herzstück. Nur eintragen wenn eine ECHTE Lücke vorliegt:
- Kompatibilitätsprüfung fehlt vollständig: kein Abgleich der Schadenbilder beider Fahrzeuge, obwohl ein Unfallgegner benannt ist
- Plausibilität im engeren Sinne nicht geprüft: Anstoßrichtung, Kontakthöhe oder Schadenintensität werden nicht mit dem geschilderten Unfallhergang abgeglichen
- EES-Wert oder Kollisionsgeschwindigkeit wird behauptet ohne jede Herleitung oder Vergleichsdatenbasis
- Vorschäden sind erkennbar vorhanden (Hinweise im Text, Reparaturspuren, Vorschadenanfrage) aber nicht vom aktuellen Schaden abgegrenzt
- Altschäden werden erwähnt aber weder bewertet noch vom Schadenumfang abgezogen
- Reparaturweg widerspricht dem Schadenbild: Austausch kalkuliert wo instandsetzbar, oder umgekehrt, ohne Begründung
NUR dann nennen wenn die Lücke für ein Gericht oder den Prüfdienstleister der Versicherung ein echtes Problem wäre.
Plausible Ansätze, übliche Bandbreiten, vertretbare Annahmen → NICHT nennen.

KATEGORIE 3 – Kalkulation und Wertansaetze (ampel "rot" oder "gelb"):
Nur eintragen wenn eine ECHTE Lücke vorliegt – nicht wenn der Ansatz lediglich ungewöhnlich ist:
- Wiederbeschaffungswert ohne Herleitung: keine Vergleichsangebote, keine Bewertungssystem-Angabe, keine Marktrecherche dokumentiert
- Restwert ohne Nachweis: die konkreten Angebote des allgemeinen regionalen Marktes sind nicht im Gutachten aufgeführt. Regelfall sind drei Angebote (BGH VI ZR 318/08). Pauschale Restwertangaben ohne Gebotsnachweis sind ein Mangel. Eine Pflicht zur Nutzung überregionaler Restwertbörsen besteht NICHT – deren Fehlen also nicht beanstanden
- 130-Prozent-Grenze: Reparaturkosten liegen nahe an oder über der Grenze, aber die Prüfung wird nicht dokumentiert
- Totalschaden festgestellt, aber die Gegenüberstellung der Reparaturkosten zum Wiederbeschaffungswert und zum Wiederbeschaffungsaufwand (WBW brutto abzüglich Restwert brutto) fehlt
- Merkantiler Minderwert angesetzt ohne jede Angabe der Ermittlungsmethode oder ohne nachvollziehbare Herleitung. Die Methodenwahl selbst NICHT beanstanden: Ruhkopf/Sahm, Halbgewachs, Hamburger Modell, Bremer Modell, BVSK, MFM und HTS sind sämtlich gebräuchlich, der BGH hat keine Methode vorgeschrieben. Nur die fehlende Benennung oder eine erkennbar unpassende Anwendung ist ein Mangel
- Merkantiler Minderwert fehlt komplett obwohl das Fahrzeug jung und der Schaden erheblich ist – ohne Begründung
- Stundenverrechnungssätze ohne Bezug: weder markengebundener Fachbetrieb noch BVSK-Honorarbefragung als Grundlage genannt
- Nutzungsausfall oder Wiederbeschaffungsdauer angesetzt ohne Fahrzeuggruppe oder Zeitraum zu benennen

KATEGORIE 4 – Offene Platzhalter (maximal "gelb"):
Nur ungefüllte [Platzhalter in eckigen Klammern] die noch konkrete Werte benötigen.

KATEGORIE 5 – Rechtschreibung und Sprache (maximal "gelb"):
Sei hier besonders zurückhaltend – Falschmeldungen sind hier besonders ärgerlich.
Nur nennen wenn EINDEUTIG ein Fehler vorliegt: klare Tippfehler oder mitten im Satz abgebrochener Text.
NICHT nennen:
- Fachbegriffe, Abkürzungen und Normbezeichnungen (WBW, RW, EES, AW, VKW, FIN, HSN/TSN, StVG, BVSK, DAT, Audatex, Bj., u. a.)
- Eigennamen, Ortsnamen, Werkstattnamen, Straßennamen, Fahrzeugmodell- und Ausstattungsbezeichnungen
- Auseinandergerissene Wörter, fehlende Umlaute, doppelte Leerzeichen, Silbentrennung, verrutschte
  Zeilenumbrüche – das sind fast immer Artefakte der PDF-Textextraktion, keine Fehler im Gutachten
- Zahlen-, Datums- und Einheitenformate (1.234,56 EUR, 15.03.2026, 12.500 km)
- Ersatzteilnummern, Positionsnummern, AW-Werte aus dem Kalkulationsausdruck
- Stilistische Vorlieben, Kommasetzung in Grenzfällen, Groß-/Kleinschreibung bei Fachwörtern
Im Zweifel NICHT nennen. Lieber einen echten Tippfehler übersehen als einen erfinden.
Wenn du unsicher bist, ob es ein Extraktionsartefakt ist: nicht nennen.

KATEGORIE 6 – Formales und Honorar (maximal "gelb"):
- Honorarabrechnung ohne erkennbare Grundlage: weder Honorarvereinbarung noch Bezug auf die BVSK-Honorarbefragung (Korridor HB V, vom BGH als Schätzgrundlage nach § 287 ZPO anerkannt) genannt
- Grundhonorar passt erkennbar nicht zur ermittelten Schadenhöhe. Die Befragung ist keine Gebührenordnung – eine Abweichung allein ist KEIN Fehler, nur eine völlig unplausible Relation
- Nebenkosten pauschal ohne Aufschlüsselung (Fahrtkosten, Lichtbilder, Porto/Telefon, Schreibkosten)
- Pflichtangaben fehlen: Auftraggeber, Besichtigungsort, Besichtigungsdatum, Unterschrift bzw. Verfasserangabe
- Anlagenverweise oder Lichtbildnummern sind nachweislich falsch

REGELN:
- Jeden Punkt mit "Seite X:" beginnen
- Fehler konkret benennen + Korrekturvorschlag
- Max. 5 Punkte pro Kategorie
- Keine Beanstandungen → punkte: ["Keine Beanstandungen"], ampel: "gruen"`;

  try {
    await trackUsage(user.id, 'check');

    // Split at page boundaries
    // Split text into chunks at page boundaries
    // Each chunk max 18000 chars, break at [Seite X] marker if possible
    const chunkSize = 18000;
    const chunks = [];
    let pos = 0;
    while (pos < prompt.length) {
      if (pos >= prompt.length) break;
      let end = Math.min(pos + chunkSize, prompt.length);
      // Try to break at a [Seite X] boundary for cleaner context
      // Search FORWARD from 70% of chunk size to avoid going backwards
      if (end < prompt.length) {
        const searchFrom = pos + Math.floor(chunkSize * 0.6);
        const searchTo   = Math.min(pos + chunkSize, prompt.length);
        const region     = prompt.slice(searchFrom, searchTo);
        const pageMatch  = region.lastIndexOf('[Seite ');
        if (pageMatch !== -1) {
          end = searchFrom + pageMatch;
        }
      }
      // Safety: ensure we always advance
      if (end <= pos) end = pos + chunkSize;
      chunks.push(prompt.slice(pos, end));
      pos = end;
    }

    const maxChunks = Math.min(chunks.length, 25); // raised from 20 to 25
    console.log(`Review: ${prompt.length} chars → ${chunks.length} chunks, analysing ${maxChunks} (max 25)`);
    // Log page coverage
    const totalPages = (prompt.match(/\[Seite \d+\]/g) || []).length;
    const lastChunk = chunks[Math.min(maxChunks, chunks.length) - 1] || '';
    const lastPageInAnalysis = (lastChunk.match(/\[Seite (\d+)\]/g) || []).pop() || '?';
    console.log(`Pages: ${totalPages} total, last page in analysis: ${lastPageInAnalysis}`);

    // Normalize category names from KI to canonical keys
    // KI may return umlauts, &, or slight variations – we normalize everything
    function normName(s) {
      return (s || '').toLowerCase()
        .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
        .replace(/[&]/g,'und').replace(/[^a-z0-9]/g,'');
    }

    const katDefs = [
      { key: 'kritischefehler',                  display: 'Kritische Fehler',                 maxAmpel: 'rot'  },
      { key: 'plausibilitaetundkompatibilitaet', display: 'Plausibilität & Kompatibilität',   maxAmpel: 'rot'  },
      { key: 'kalkulationundwertansaetze',       display: 'Kalkulation & Wertansätze',        maxAmpel: 'rot'  },
      { key: 'offeneplatzhalter',                display: 'Offene Platzhalter',               maxAmpel: 'gelb' },
      { key: 'rechtschreibungundsprache',        display: 'Rechtschreibung & Sprache',        maxAmpel: 'gelb' },
      { key: 'formalesundhonorar',               display: 'Formales & Honorar',               maxAmpel: 'gelb' },
    ];

    function findKat(name) {
      const n = normName(name);
      return katDefs.find(k => k.key === n)
        || katDefs.find(k => n.includes(k.key.slice(0,8)))
        || null;
    }

    // Initialize with gruen
    const allKategorien = {};
    katDefs.forEach(k => allKategorien[k.key] = { ampel: 'gruen', punkte: [] });

    const ampelOrder = { gruen: 0, gelb: 1, orange: 1, rot: 2 };
    let totalTokens = 0;
    let successfulChunks = 0;

    // Process in batches of 4
    const BATCH = 5;
    for (let b = 0; b < maxChunks; b += BATCH) {
      const batchIdx = Array.from({ length: Math.min(BATCH, maxChunks - b) }, (_, i) => b + i);
      const batchResults = await Promise.all(batchIdx.map(async ci => {
        try {
          const resp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              max_tokens: 3000,
              system: systemPrompt,
              messages: [{
                role: 'user',
                content: (() => {
                  const c = chunks[ci];
                  const pages = c.match(/\[Seite (\d+)\]/g) || [];
                  const firstPage = pages[0] ? pages[0].replace(/\D/g,'') : '?';
                  const lastPage  = pages[pages.length-1] ? pages[pages.length-1].replace(/\D/g,'') : '?';
                  const totalPages = (prompt.match(/\[Seite \d+\]/g) || []).length;
                  return `Prüfe Abschnitt ${ci+1} von ${maxChunks} des Schadengutachtens.\nSeiten in diesem Abschnitt: ${firstPage}–${lastPage} (von insgesamt ${totalPages} Seiten).\nNur Fehler aus DIESEM Abschnitt benennen – keine Vermutungen über andere Abschnitte.\n\n${c}`;
                })()
              }],
            }),
          });
          if (!resp.ok) { console.error('API chunk', ci, resp.status); return null; }
          const data = await resp.json();
          totalTokens += data.usage?.output_tokens || 0;
          const raw = (data.content[0]?.text || '').trim()
            .replace(/\`\`\`json/gi, '').replace(/\`\`\`/g, '').trim();
          const s = raw.indexOf('{');
          const e = raw.lastIndexOf('}');
          if (s === -1 || e === -1) return null;
          return JSON.parse(raw.slice(s, e + 1));
        } catch (err) {
          console.error('Chunk', ci, 'error:', err.message);
          return null;
        }
      }));

      for (const parsed of batchResults) {
        if (!parsed?.kategorien) continue;
        successfulChunks++;

        for (const kat of parsed.kategorien) {
          const def = findKat(kat.name);
          if (!def) {
            console.log('Unknown category:', kat.name, '→ normalized:', normName(kat.name));
            continue;
          }
          const key = def.key;

          // Normalize + cap ampel
          const rawAmpel = (kat.ampel || 'gruen').trim().toLowerCase().replace(/[^a-z]/g, '');
          const ampelRaw2 = rawAmpel === 'orange' ? 'gelb' : rawAmpel;
          const ampel = ['rot', 'gelb', 'gruen'].includes(ampelRaw2) ? ampelRaw2 : 'gruen';
          const cappedAmpel = (ampelOrder[ampel] || 0) > (ampelOrder[def.maxAmpel] || 0)
            ? def.maxAmpel : ampel;

          if ((ampelOrder[cappedAmpel] || 0) > (ampelOrder[allKategorien[key].ampel] || 0)) {
            allKategorien[key].ampel = cappedAmpel;
          }

          for (const p of (kat.punkte || [])) {
            if (!p || p.toLowerCase().includes('keine beanstandungen')) continue;
            const pPage = (p.match(/^Seite (\d+)/i) || ['',''])[1];
            const pSig = p.slice(0, 50).toLowerCase();
            const isDup = allKategorien[key].punkte.some(e => {
              const ePage = (e.match(/^Seite (\d+)/i) || ['',''])[1];
              return ePage === pPage && e.slice(0, 50).toLowerCase() === pSig;
            });
            if (!isDup) allKategorien[key].punkte.push(p);
          }
        }
      }
    }

    // Fallback: if no chunks succeeded return error
    if (successfulChunks === 0) {
      return res.status(500).json({ error: 'Prüfung fehlgeschlagen – bitte erneut versuchen.' });
    }

    // Build final sorted result
    const finalKategorien = katDefs.map(def => {
      const kat = allKategorien[def.key];

      if (kat.punkte.length === 0) {
        return { name: def.display, ampel: 'gruen', punkte: ['Keine Beanstandungen'] };
      }

      const sorted = kat.punkte.sort((a, b) => {
        const pa = parseInt((a.match(/Seite (\d+)/i) || ['','999'])[1]);
        const pb = parseInt((b.match(/Seite (\d+)/i) || ['','999'])[1]);
        return pa - pb;
      });

      return { name: def.display, ampel: kat.ampel, punkte: sorted.slice(0, 15) };
    });

    const hasRot    = finalKategorien.some(k => k.ampel === 'rot'    && k.punkte[0] !== 'Keine Beanstandungen');
    const hasOrange = finalKategorien.some(k => (k.ampel === 'gelb' || k.ampel === 'orange') && k.punkte[0] !== 'Keine Beanstandungen');
    const gesamtbewertung = hasRot ? 'rot' : hasOrange ? 'orange' : 'gruen';

    const totalProblems = finalKategorien.reduce((s, k) =>
      s + (k.punkte[0] === 'Keine Beanstandungen' ? 0 : k.punkte.length), 0);

    const seiten = (prompt.match(/\[Seite \d+\]/g) || []).length;

    // Ehrlichkeit über die Abdeckung: Wurden nicht alle Abschnitte ausgewertet,
    // darf das Ergebnis nicht als vollständige Entwarnung erscheinen.
    const skipped     = chunks.length - maxChunks;          // wegen Längenbegrenzung nicht gesendet
    const failed      = maxChunks - successfulChunks;       // gesendet, aber fehlgeschlagen
    const incomplete  = skipped > 0 || failed > 0;
    const coverage    = Math.round((successfulChunks / chunks.length) * 100);

    let warnung = null;
    if (incomplete) {
      const teile = [];
      if (failed  > 0) teile.push(`${failed} von ${maxChunks} Abschnitten konnten nicht ausgewertet werden`);
      if (skipped > 0) teile.push(`${skipped} Abschnitt(e) wurden wegen der Dokumentlänge nicht geprüft`);
      warnung = `Unvollständige Prüfung: ${teile.join('; ')}. `
              + `Etwa ${coverage}% des Dokuments wurden analysiert – bitte erneut prüfen, `
              + `bevor Sie sich auf das Ergebnis verlassen.`;
      console.warn(`[REVIEW] Unvollständig: ${successfulChunks}/${chunks.length} Abschnitte (User ${user.id})`);
    }

    const zusammenfassung = totalProblems === 0
      ? (incomplete
          ? `In den ausgewerteten Abschnitten keine Beanstandungen – die Prüfung war jedoch unvollständig.`
          : `Gutachten ohne Beanstandungen – bereit zur Fertigstellung. (${seiten} Seiten analysiert)`)
      : `${totalProblems} Hinweis${totalProblems !== 1 ? 'e' : ''} auf ${seiten} Seiten gefunden – bitte vor Fertigstellung prüfen.`;

    const cost = (totalTokens / 1000) * 0.003;
    await query('INSERT INTO api_logs (user_id, prompt_type, tokens, cost_eur) VALUES ($1,$2,$3,$4)',
      [user.id, 'review', totalTokens, cost]);

    res.json({ result: { gesamtbewertung, zusammenfassung, kategorien: finalKategorien, warnung, coverage, incomplete } });

  } catch (err) {
    console.error('Review error:', err);
    res.status(500).json({ error: 'Serverfehler: ' + err.message });
  }
});


// ─── CHECKLIST DOCX ───────────────────────────────────────────────────────────
app.post('/api/checklist', authMiddleware, async (req, res) => {
  const { kategorien, zusammenfassung, gesamtbewertung } = req.body;
  if (!kategorien) return res.status(400).json({ error: 'kategorien erforderlich' });
  try {
    let buildChecklist;
    try { buildChecklist = require('./checklist').buildChecklist; }
    catch(e) { return res.status(503).json({ error: 'Checklisten-Modul nicht verfügbar: ' + e.message }); }
    const buf = await buildChecklist({ kategorien, zusammenfassung, gesamtbewertung });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="KfzGut-AI_Pruefbericht.docx"');
    res.send(buf);
  } catch(err) {
    console.error('Checklist error:', err);
    res.status(500).json({ error: 'Fehler: ' + err.message });
  }
});


// ─── CONTACT FORM ────────────────────────────────────────────────────────────
app.post('/api/contact', async (req, res) => {
  const { name, email, subject, message } = req.body;
  if (!email || !message) return res.status(400).json({ error: 'E-Mail und Nachricht erforderlich' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Ungültige E-Mail' });
  try {
    const bodyHtml = '<h2>Neue Kontaktanfrage</h2>'
      + '<p><strong>Name:</strong> ' + (name||'–') + '</p>'
      + '<p><strong>E-Mail:</strong> ' + email + '</p>'
      + '<p><strong>Betreff:</strong> ' + (subject||'–') + '</p>'
      + '<p><strong>Nachricht:</strong></p>'
      + '<div style="padding:12px;background:#f0f2f6;border-radius:8px">' + message.replace(/\n/g,'<br>') + '</div>'
      + '<p style="color:#999;font-size:12px">Eingegangen: ' + new Date().toLocaleString('de-DE') + '</p>';
    await sendMail('info@kfzgut-ai.de',
      'Kontaktformular: ' + (subject||'Anfrage') + ' – ' + (name||email),
      bodyHtml
    );
    const replyHtml = '<p>Sehr geehrte/r ' + (name||'Nutzerin/Nutzer') + ',</p>'
      + '<p>vielen Dank für Ihre Nachricht. Wir melden uns in der Regel innerhalb von 2 Werktagen.</p>'
      + '<p>Mit freundlichen Grüßen<br>KfzGut-AI · info@kfzgut-ai.de</p>';
    await sendMail(email, 'Ihre Anfrage an KfzGut-AI', replyHtml);
    res.json({ ok: true });
  } catch (err) {
    console.error('Contact form error:', err);
    res.status(500).json({ error: 'Fehler beim Senden' });
  }
});


// ─── DELETE ACCOUNT ──────────────────────────────────────────────────────────
app.delete('/api/me', authMiddleware, async (req, res) => {
  const user = await loadUser(req.user.userId);
  if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
  try {
    // 1. Cancel & delete Stripe subscription
    if (user.stripe_subscription_id) {
      try { await stripe.subscriptions.cancel(user.stripe_subscription_id); }
      catch (e) { console.warn('Stripe subscription cancel:', e.message); }
    }
    // 2. Delete Stripe customer (removes saved payment methods)
    if (user.stripe_customer_id) {
      try { await stripe.customers.del(user.stripe_customer_id); }
      catch (e) { console.warn('Stripe customer delete:', e.message); }
    }
    // 3. Team-Mitglieder nicht verwaisen lassen: eigenständig machen + informieren
    if (!user._isTeamMember) {
      const members = (await query('SELECT id, email, name FROM users WHERE team_owner_id=$1', [user.id])).rows;
      if (members.length) {
        const now = Math.floor(Date.now()/1000);
        await query(
          `UPDATE users SET team_owner_id=NULL, plan='trial', plan_status='active',
                            plan_seats=1, trial_starts_at=$1, trial_ends_at=$2
           WHERE team_owner_id=$3`,
          [now, now + 7*24*3600, user.id]
        );
        for (const m of members) {
          try {
            const mail = mails.teamOwnerLeft(m.name || m.email.split('@')[0]);
            await sendMail(m.email, mail.subject, mail.html);
          } catch (e) { console.warn('Mail an Team-Mitglied:', e.message); }
        }
        console.log(`[DELETE] ${members.length} Team-Mitglied(er) von Account ${user.id} eigenständig gemacht`);
      }
    }

    // 4. Delete DB records
    await query('DELETE FROM api_logs WHERE user_id=$1', [user.id]);
    await query('DELETE FROM feedback WHERE user_id=$1', [user.id]);
    await query('DELETE FROM users WHERE id=$1', [user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Fehler beim Löschen: ' + err.message });
  }
});

// ─── CANCEL TRIAL / SUBSCRIPTION ─────────────────────────────────────────────
app.post('/api/cancel', authMiddleware, async (req, res) => {
  const user = await loadUser(req.user.userId);
  if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
  if (user._isTeamMember) return res.status(403).json({
    error: 'Ihr Zugang läuft über den Hauptaccount Ihres Büros. Eine Kündigung ist dort vorzunehmen.',
    code: 'TEAM_MEMBER' });
  try {
    if (user.plan === 'trial') {
      // End trial immediately
      await query("UPDATE users SET plan_status='expired', trial_ends_at=$1 WHERE id=$2",
        [Math.floor(Date.now()/1000), user.id]);
      return res.json({ ok: true, message: 'Trial beendet' });
    }
    if (user.stripe_subscription_id) {
      // Cancel at period end via Stripe
      await stripe.subscriptions.update(user.stripe_subscription_id, {
        cancel_at_period_end: true
      });
      await query("UPDATE users SET plan='cancelled' WHERE id=$1", [user.id]);
      return res.json({ ok: true, message: 'Abonnement wird zum Ende der Laufzeit gekündigt' });
    }
    await query("UPDATE users SET plan='cancelled', plan_status='cancelled' WHERE id=$1", [user.id]);
    res.json({ ok: true, message: 'Abonnement gekündigt' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HEALTH & KEEP-ALIVE ─────────────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), uptime: process.uptime() }));

// Self-ping every 5 minutes to prevent cold starts (Railway Hobby Plan)
if (process.env.FRONTEND_URL) {
  setInterval(async () => {
    try {
      await fetch(`${process.env.FRONTEND_URL.replace('kfzgut-ai.de', 'kfzgut-ai.up.railway.app')}/ping`);
    } catch {}
  }, 4 * 60 * 1000); // every 4 minutes
}

// ─── FEEDBACK ─────────────────────────────────────────────────────────────────
app.post('/api/feedback', authMiddleware, async (req, res) => {
  const user = await loadUser(req.user.userId);
  const { rating, categories, message } = req.body;
  await query('INSERT INTO feedback (user_id, email, rating, categories, message) VALUES ($1,$2,$3,$4,$5)',
    [user?.id||null, user?.email||'', rating||0, JSON.stringify(categories||[]), message||'']);
  res.json({ ok: true });
});

// ─── ADMIN STATS ──────────────────────────────────────────────────────────────
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  const users = (await query(`SELECT id, email, name, company, plan, plan_status, email_verified,
    trial_ends_at, api_calls_month, checks_total, prompts_total, last_activity_at, plan_seats, team_owner_id, created_at, last_login_at FROM users ORDER BY created_at DESC`)).rows;
  const costs = (await query('SELECT SUM(tokens) as tokens, SUM(cost_eur) as cost FROM api_logs')).rows[0];
  const payingRows = (await query(
    `SELECT plan_seats FROM users
      WHERE plan='active_sub' AND plan_status='active' AND team_owner_id IS NULL`)).rows;
  const paying = { n: payingRows.length };
  // Umsatz nach Tarif: Büro (mehr als 1 Platz) 99 €, Einzelplatz 69 €
  const revenue = payingRows.reduce((sum, r) => sum + ((r.plan_seats || 1) > 1 ? 99 : 69), 0);
  const trials = (await query(`SELECT COUNT(*) as n FROM users WHERE plan='trial' AND plan_status='active' AND team_owner_id IS NULL`)).rows[0];
  const feedback = (await query('SELECT * FROM feedback ORDER BY created_at DESC LIMIT 50')).rows;
  const now = Math.floor(Date.now()/1000);

  // Zugriff team-bewusst berechnen: Mitglieder erben vom Hauptaccount
  const byId = new Map(users.map(u => [u.id, u]));
  const accessOf = (u) => {
    const b = u.team_owner_id ? byId.get(u.team_owner_id) : u;
    if (!b) return false;                       // Hauptaccount existiert nicht mehr
    if (!u.team_owner_id && !u.email_verified) return false;   // eigenständige Accounts
    if (u.team_owner_id && !b.email_verified) return false;     // Hauptaccount muss verifiziert sein
    if (b.plan === 'active_sub') return b.plan_status === 'active';
    if (b.plan === 'trial') return b.plan_status === 'active' && now < b.trial_ends_at;
    return false;
  };

  res.json({
    users: users.map(u => ({ ...u,
      hasAccess: accessOf(u),
      isOrphan: !!(u.team_owner_id && !byId.has(u.team_owner_id)) || (u.plan === 'team_member' && !u.team_owner_id),
      ownerEmail: u.team_owner_id ? (byId.get(u.team_owner_id)?.email || null) : null,
      trialDaysLeft: u.plan==='trial' ? Math.max(0, Math.ceil((u.trial_ends_at-now)/86400)) : null,
    })),
    summary: {
      totalUsers: users.length,
      paying: paying.n,
      trials: parseInt(trials.n),
      teamMembers: users.filter(u => u.team_owner_id).length,
      revenue,
      apiCost: Math.round((costs.cost||0)*100)/100 },
    feedback,
  });
});

app.put('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  const { plan, plan_status, email_verified, plan_seats, team_owner_id } = req.body;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Ungültige ID' });

  try {
    // Team-Zuordnung validieren
    let ownerId = null;
    if (team_owner_id !== undefined && team_owner_id !== null && team_owner_id !== '') {
      ownerId = parseInt(team_owner_id, 10);
      if (ownerId === id) return res.status(400).json({ error: 'Ein Nutzer kann sich nicht selbst zugeordnet werden' });

      const owner = (await query('SELECT id, plan_seats, team_owner_id FROM users WHERE id=$1', [ownerId])).rows[0];
      if (!owner) return res.status(400).json({ error: 'Hauptaccount nicht gefunden' });
      if (owner.team_owner_id) return res.status(400).json({ error: 'Der gewählte Hauptaccount ist selbst Team-Mitglied' });

      // Platzkontrolle: Hauptaccount + Mitglieder dürfen plan_seats nicht überschreiten
      const seats = owner.plan_seats || 1;
      const current = (await query('SELECT id FROM users WHERE team_owner_id=$1 AND id<>$2', [ownerId, id])).rows.length;
      if (current + 1 >= seats) {
        return res.status(400).json({ error: `Hauptaccount hat nur ${seats} Plätze – bereits ${current + 1} belegt` });
      }
    }

    // Wird ein Nutzer zum Team-Mitglied, gilt für ihn plan='team_member' und 1 Platz
    const finalPlan  = ownerId ? 'team_member' : (plan || null);
    let finalSeats   = ownerId ? 1 : (plan_seats !== undefined ? parseInt(plan_seats, 10) || 1 : null);

    // Platzzahl darf bestehende Mitglieder nicht aussperren – lieber ablehnen als kündigen
    if (!ownerId && finalSeats) {
      const memberCount = (await query('SELECT id FROM users WHERE team_owner_id=$1', [id])).rows.length;
      if (memberCount + 1 > finalSeats) {
        return res.status(400).json({
          error: `Dieser Account hat ${memberCount} zugeordnete Mitglieder. Für ${finalSeats} Plätze müssten zuerst ${memberCount + 1 - finalSeats} Mitglied(er) entfernt werden.`,
          code: 'SEATS_TOO_LOW', memberCount, requestedSeats: finalSeats
        });
      }
    }

    await query(
      `UPDATE users SET
         plan           = COALESCE($1, plan),
         plan_status    = COALESCE($2, plan_status),
         email_verified = COALESCE($3, email_verified),
         plan_seats     = COALESCE($4, plan_seats),
         team_owner_id  = $5
       WHERE id=$6`,
      [finalPlan, plan_status || null,
       email_verified !== undefined ? email_verified : null,
       finalSeats, ownerId, id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Admin-Update fehlgeschlagen:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Diagnose + Reparatur: Accounts mit plan='team_member', aber ohne Hauptaccount
// haben dauerhaft keinen Zugang und können sich nicht selbst befreien.
app.get('/api/admin/broken', adminMiddleware, async (req, res) => {
  const orphans = (await query(
    `SELECT id, email, name, company, plan, plan_status, created_at
       FROM users
      WHERE (plan='team_member' AND team_owner_id IS NULL)
         OR (team_owner_id IS NOT NULL
             AND team_owner_id NOT IN (SELECT id FROM users))`
  )).rows;
  res.json({ orphans });
});

app.post('/api/admin/repair/:id', adminMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { mode, owner_id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Ungültige ID' });
  try {
    if (mode === 'reassign' && owner_id) {
      const owner = (await query('SELECT id, plan_seats FROM users WHERE id=$1', [owner_id])).rows[0];
      if (!owner) return res.status(400).json({ error: 'Hauptaccount nicht gefunden' });
      const used = (await query('SELECT id FROM users WHERE team_owner_id=$1 AND id<>$2', [owner_id, id])).rows.length;
      if (used + 2 > (owner.plan_seats || 1)) return res.status(400).json({ error: 'Keine freien Plätze beim Hauptaccount' });
      await query("UPDATE users SET team_owner_id=$1, plan='team_member', plan_status='active', plan_seats=1 WHERE id=$2", [owner_id, id]);
      return res.json({ ok: true, mode: 'reassign' });
    }
    // Standard: als eigenständigen Account mit 7 Tagen Test wiederherstellen
    const now = Math.floor(Date.now()/1000);
    await query(
      "UPDATE users SET team_owner_id=NULL, plan='trial', plan_status='active', plan_seats=1, trial_starts_at=$1, trial_ends_at=$2 WHERE id=$3",
      [now, now + 7*24*3600, id]
    );
    res.json({ ok: true, mode: 'standalone' });
  } catch (err) {
    console.error('Reparatur fehlgeschlagen:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Ungültige ID' });
  try {
    // Team-Mitglieder des Hauptaccounts mitlöschen, sonst bleiben verwaiste Zugänge zurück
    const members = await query('DELETE FROM users WHERE team_owner_id=$1 RETURNING id', [id]);
    const ids = [id, ...members.rows.map(m => m.id)];
    await query('DELETE FROM api_logs WHERE user_id = ANY($1)', [ids]).catch(()=>{});
    await query('DELETE FROM feedback WHERE user_id = ANY($1)', [ids]).catch(()=>{});
    const del = await query('DELETE FROM users WHERE id=$1 RETURNING id, email', [id]);
    if (!del.rows.length) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    console.log(`[ADMIN] Nutzer ${del.rows[0].email} gelöscht (+${members.rows.length} Team-Mitglieder)`);
    res.json({ ok: true, deleted: del.rows[0].email, teamMembersDeleted: members.rows.length });
  } catch (err) {
    console.error('Löschen fehlgeschlagen:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── CRON: Trial Management ───────────────────────────────────────────────────
// Mailstrecke gilt nur für Nutzer, die sich AB dieser Umstellung registriert haben.
// Bestandsnutzer erhalten keine nachträglichen Aktivierungs-/Rückholmails.
const SEQUENCE_START = parseInt(process.env.SEQUENCE_START || '0', 10)
  || Math.floor(new Date('2026-07-28T00:00:00Z').getTime() / 1000);

cron.schedule('0 8 * * *', async () => {
  const now = Math.floor(Date.now()/1000);
  const warnAt = now + 2*24*3600;

  // ── Tag 2: Aktivierungsmail, nur wenn noch keine Prüfung gelaufen ist ──
  const day2From = now - 3*24*3600;
  const day2To   = now - 2*24*3600;
  const toActivate = (await query(`SELECT * FROM users WHERE plan='trial' AND plan_status='active'
    AND email_verified=1
    AND team_owner_id IS NULL
    AND created_at >= $1
    AND created_at BETWEEN $2 AND $3
    AND COALESCE(checks_total,0) = 0
    AND COALESCE(activation_mail_sent,0) = 0`, [SEQUENCE_START, day2From, day2To])).rows;
  for (const user of toActivate) {
    const m = mails.activation(user.name || user.email.split('@')[0]);
    await sendMail(user.email, m.subject, m.html);
    await query('UPDATE users SET activation_mail_sent=1 WHERE id=$1', [user.id]);
  }

  const toWarn = (await query(`SELECT * FROM users WHERE plan='trial' AND plan_status='active'
    AND trial_ends_at <= $1 AND trial_ends_at > $2 AND trial_warning_sent=0`, [warnAt, now])).rows;
  for (const user of toWarn) {
    const days = Math.ceil((user.trial_ends_at-now)/86400);
    const m = mails.trialWarning(user.name||user.email.split('@')[0], days);
    await sendMail(user.email, m.subject, m.html);
    await query('UPDATE users SET trial_warning_sent=1 WHERE id=$1', [user.id]);
  }

  const expired = (await query(`SELECT * FROM users WHERE plan='trial' AND plan_status='active' AND trial_ends_at <= $1`, [now])).rows;
  for (const user of expired) {
    await query(`UPDATE users SET plan_status='expired' WHERE id=$1`, [user.id]);
    const m = mails.trialExpired(user.name||user.email.split('@')[0]);
    await sendMail(user.email, m.subject, m.html);
  }
  // ── Tag 10: Rückholmail, 3 Tage nach Ablauf des Tests ──
  const winbackFrom = now - 4*24*3600;
  const winbackTo   = now - 3*24*3600;
  const toWinback = (await query(`SELECT * FROM users WHERE plan='trial'
    AND email_verified=1
    AND team_owner_id IS NULL
    AND created_at >= $1
    AND trial_ends_at BETWEEN $2 AND $3
    AND COALESCE(winback_mail_sent,0) = 0`, [SEQUENCE_START, winbackFrom, winbackTo])).rows;
  for (const user of toWinback) {
    const usedTool = (user.checks_total || 0) > 0 || (user.prompts_total || 0) > 0;
    const m = mails.winback(user.name || user.email.split('@')[0], usedTool);
    await sendMail(user.email, m.subject, m.html);
    await query('UPDATE users SET winback_mail_sent=1 WHERE id=$1', [user.id]);
  }

  console.log(`[CRON] Aktivierung: ${toActivate.length}, Warnung: ${toWarn.length}, Abgelaufen: ${expired.length}, Rückholung: ${toWinback.length}`);
});

// ─── START ────────────────────────────────────────────────────────────────────
// ─── ZENTRALE FEHLERBEHANDLUNG ────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err && err.message ? err.message : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Serverfehler – bitte erneut versuchen' });
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 KfzGut-AI Server läuft auf Port ${PORT}`);
    console.log(`   Frontend: ${process.env.FRONTEND_URL || 'nicht gesetzt'}`);
  });
}).catch(err => { console.error('DB Fehler:', err); process.exit(1); });

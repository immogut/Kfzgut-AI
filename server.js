/**
 * KfzGut-AI — Backend
 * Registrierung, Login, E-Mail-Verifizierung, Trial, Stripe, Pruef-API, Admin.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

// ------------------------------------------------------------- Konfiguration
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ABSENDER = process.env.MAIL_FROM || 'KfzGut-AI <noreply@kfzgut-ai.de>';
const BASIS_URL = (process.env.BASIS_URL || 'http://localhost:3000').replace(/\/$/, '');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

const TRIAL_TAGE = 7;
const LAUNCH_KONTINGENT = 50;
const PREIS_LAUNCH = 79;
const PRUEFUNGEN_PRO_TAG = 25; // Fair-Use-Grenze

const stripe = STRIPE_SECRET ? require('stripe')(STRIPE_SECRET) : null;

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// ------------------------------------------------------------- Datenbank
async function initDb() {
  if (!pool) { console.warn('DATABASE_URL fehlt — nur Static-Modus.'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT, firma TEXT,
      plan TEXT NOT NULL DEFAULT 'trial',
      plan_status TEXT NOT NULL DEFAULT 'aktiv',
      email_verified SMALLINT NOT NULL DEFAULT 0,
      verify_token TEXT,
      reset_token TEXT, reset_ablauf TIMESTAMPTZ,
      trial_ends_at TIMESTAMPTZ,
      stripe_customer_id TEXT, stripe_subscription_id TEXT,
      launch_preis SMALLINT NOT NULL DEFAULT 0,
      pruefungen_gesamt INTEGER NOT NULL DEFAULT 0,
      pruefungen_heute INTEGER NOT NULL DEFAULT 0,
      pruefungen_datum DATE,
      notiz TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS users_created_idx ON users (created_at DESC);
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
  `);
  console.log('Datenbank bereit.');
}

// ------------------------------------------------------------- Helfer
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req, roh = false) {
  return new Promise((resolve, reject) => {
    const teile = [];
    let laenge = 0;
    req.on('data', (c) => {
      laenge += c.length;
      if (laenge > 12e6) { req.destroy(); return reject(new Error('Zu gross')); }
      teile.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(teile);
      if (roh) return resolve(buf);
      try { resolve(buf.length ? JSON.parse(buf.toString('utf8')) : {}); }
      catch { reject(new Error('Ungueltiges JSON')); }
    });
    req.on('error', reject);
  });
}

function token() { return crypto.randomBytes(32).toString('hex'); }
function gueltigeMail(m) { return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(m || '').trim()); }

function adminOk(req) {
  if (!ADMIN_SECRET) return false;
  const a = Buffer.from(String(req.headers['x-admin-secret'] || ''));
  const b = Buffer.from(ADMIN_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function nutzerAusSession(req) {
  if (!pool) return null;
  const auth = req.headers.authorization || '';
  const t = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!t) return null;
  const { rows } = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.created_at > NOW() - INTERVAL '30 days'`, [t]);
  return rows[0] || null;
}

// Zugriffsrecht: Trial laeuft, oder bezahlt, und nicht gesperrt
function zugriffOk(u) {
  if (!u || u.plan_status === 'gesperrt' || !u.email_verified) return false;
  if (u.plan === 'aktiv') return true;
  if (u.plan === 'trial' && u.trial_ends_at && new Date(u.trial_ends_at) > new Date()) return true;
  return false;
}

function oeffentlich(u) {
  return {
    id: u.id, email: u.email, name: u.name, firma: u.firma,
    plan: u.plan, plan_status: u.plan_status, email_verified: !!u.email_verified,
    trial_ends_at: u.trial_ends_at, launch_preis: !!u.launch_preis,
    pruefungen_gesamt: u.pruefungen_gesamt, zugriff: zugriffOk(u),
    hat_abo: !!u.stripe_subscription_id
  };
}

// ------------------------------------------------------------- E-Mail
async function mailSenden(an, betreff, html) {
  if (!RESEND_API_KEY) { console.warn('RESEND_API_KEY fehlt — Mail an', an, 'nicht gesendet.'); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: ABSENDER, to: [an], subject: betreff, html })
    });
    if (!r.ok) { console.error('Resend-Fehler:', r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.error('Mailversand fehlgeschlagen:', e.message); return false; }
}

function mailRahmen(titel, inhalt, knopfText, knopfLink) {
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#1B2530">
    <div style="border-bottom:3px solid #E8590C;padding-bottom:12px;margin-bottom:22px">
      <span style="font-size:19px;font-weight:800">KfzGut<span style="color:#E8590C">-AI</span></span>
    </div>
    <h1 style="font-size:21px;margin:0 0 14px">${titel}</h1>
    <div style="font-size:15px;line-height:1.6;color:#46525F">${inhalt}</div>
    ${knopfLink ? `<p style="margin:26px 0"><a href="${knopfLink}" style="background:#E8590C;color:#fff;text-decoration:none;padding:13px 26px;border-radius:6px;font-weight:700;display:inline-block">${knopfText}</a></p>
    <p style="font-size:12.5px;color:#8A97A3">Falls der Knopf nicht funktioniert:<br><span style="word-break:break-all">${knopfLink}</span></p>` : ''}
    <p style="font-size:12px;color:#8A97A3;border-top:1px solid #DDE1E4;padding-top:16px;margin-top:26px">
      KfzGut-AI · Prüfassistent für Kfz-Schadengutachten</p></div>`;
}

// ------------------------------------------------------------- Auth-Routen
async function handleAuth(req, res, p) {
  if (!pool) return json(res, 503, { error: 'Keine Datenbank verbunden' });

  // ---- Registrierung
  if (p === '/api/register' && req.method === 'POST') {
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const pw = String(b.passwort || '');
    if (!gueltigeMail(email)) return json(res, 400, { error: 'Bitte eine gültige E-Mail-Adresse angeben.' });
    if (pw.length < 8) return json(res, 400, { error: 'Das Passwort muss mindestens 8 Zeichen haben.' });

    const da = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (da.rows.length) return json(res, 409, { error: 'Diese E-Mail-Adresse ist bereits registriert.' });

    const hash = await bcrypt.hash(pw, 10);
    const vt = token();
    // Die ersten 50 zahlenden Kunden bekommen den Launch-Preis dauerhaft
    const { rows: z } = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE plan = 'aktiv'`);
    const launch = z[0].n < LAUNCH_KONTINGENT ? 1 : 0;

    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, firma, verify_token, trial_ends_at, launch_preis)
       VALUES ($1,$2,$3,$4,$5, NOW() + ($6 || ' days')::interval, $7) RETURNING *`,
      [email, hash, b.name || null, b.firma || null, vt, TRIAL_TAGE, launch]);

    await mailSenden(email, 'Willkommen bei KfzGut-AI — E-Mail bestätigen',
      mailRahmen('Nur noch ein Klick',
        `<p>Schön, dass du KfzGut-AI testest. Bestätige kurz deine E-Mail-Adresse, dann startet dein kostenloser Test über ${TRIAL_TAGE} Tage.</p>`,
        'E-Mail bestätigen', `${BASIS_URL}/api/verify?token=${vt}`));

    return json(res, 201, { ok: true, user: oeffentlich(rows[0]) });
  }

  // ---- E-Mail bestätigen
  if (p === '/api/verify' && req.method === 'GET') {
    const t = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
    const { rows } = await pool.query(
      `UPDATE users SET email_verified = 1, verify_token = NULL WHERE verify_token = $1 RETURNING id`, [t]);
    const ziel = rows.length ? '/login.html?bestaetigt=1' : '/login.html?fehler=token';
    res.writeHead(302, { Location: ziel });
    return res.end();
  }

  // ---- Login
  if (p === '/api/login' && req.method === 'POST') {
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const u = rows[0];
    // Gleiche Meldung fuer beide Faelle — verraet nicht, ob die Adresse existiert
    if (!u || !(await bcrypt.compare(String(b.passwort || ''), u.password_hash))) {
      return json(res, 401, { error: 'E-Mail oder Passwort ist falsch.' });
    }
    if (!u.email_verified) return json(res, 403, { error: 'Bitte bestätige zuerst deine E-Mail-Adresse.', unbestaetigt: true });

    const t = token();
    await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1,$2)', [t, u.id]);
    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [u.id]);
    return json(res, 200, { token: t, user: oeffentlich(u) });
  }

  // ---- Logout
  if (p === '/api/logout' && req.method === 'POST') {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) await pool.query('DELETE FROM sessions WHERE token = $1', [auth.slice(7)]);
    return json(res, 200, { ok: true });
  }

  // ---- Bestätigungsmail erneut senden
  if (p === '/api/resend-verify' && req.method === 'POST') {
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1 AND email_verified = 0', [email]);
    if (rows.length) {
      const vt = rows[0].verify_token || token();
      await pool.query('UPDATE users SET verify_token = $1 WHERE id = $2', [vt, rows[0].id]);
      await mailSenden(email, 'KfzGut-AI — E-Mail bestätigen',
        mailRahmen('E-Mail bestätigen', '<p>Hier ist dein Bestätigungslink.</p>',
          'E-Mail bestätigen', `${BASIS_URL}/api/verify?token=${vt}`));
    }
    return json(res, 200, { ok: true }); // immer ok — verraet nicht, ob die Adresse existiert
  }

  // ---- Passwort vergessen
  if (p === '/api/passwort-vergessen' && req.method === 'POST') {
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (rows.length) {
      const rt = token();
      await pool.query(`UPDATE users SET reset_token = $1, reset_ablauf = NOW() + INTERVAL '1 hour' WHERE id = $2`, [rt, rows[0].id]);
      await mailSenden(email, 'KfzGut-AI — Passwort zurücksetzen',
        mailRahmen('Passwort zurücksetzen',
          '<p>Du kannst jetzt ein neues Passwort vergeben. Der Link ist eine Stunde gültig.</p>',
          'Neues Passwort vergeben', `${BASIS_URL}/passwort-neu.html?token=${rt}`));
    }
    return json(res, 200, { ok: true });
  }

  // ---- Neues Passwort setzen
  if (p === '/api/passwort-neu' && req.method === 'POST') {
    const b = await readBody(req);
    if (String(b.passwort || '').length < 8) return json(res, 400, { error: 'Mindestens 8 Zeichen.' });
    const hash = await bcrypt.hash(String(b.passwort), 10);
    const { rows } = await pool.query(
      `UPDATE users SET password_hash = $1, reset_token = NULL, reset_ablauf = NULL
       WHERE reset_token = $2 AND reset_ablauf > NOW() RETURNING id`, [hash, b.token]);
    if (!rows.length) return json(res, 400, { error: 'Der Link ist ungültig oder abgelaufen.' });
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]); // alle Geraete abmelden
    return json(res, 200, { ok: true });
  }

  return null;
}

// ------------------------------------------------------------- Konto
async function handleKonto(req, res, p) {
  const u = await nutzerAusSession(req);
  if (!u) return json(res, 401, { error: 'Nicht angemeldet' });

  if (p === '/api/me' && req.method === 'GET') return json(res, 200, { user: oeffentlich(u) });

  if (p === '/api/me' && req.method === 'PATCH') {
    const b = await readBody(req);
    const { rows } = await pool.query(
      'UPDATE users SET name = COALESCE($1,name), firma = COALESCE($2,firma) WHERE id = $3 RETURNING *',
      [b.name ?? null, b.firma ?? null, u.id]);
    return json(res, 200, { user: oeffentlich(rows[0]) });
  }

  if (p === '/api/feedback' && req.method === 'POST') {
    const b = await readBody(req);
    if (!String(b.text || '').trim()) return json(res, 400, { error: 'Bitte einen Text eingeben.' });
    await pool.query('INSERT INTO feedback (user_id, text) VALUES ($1,$2)', [u.id, String(b.text).slice(0, 4000)]);
    return json(res, 200, { ok: true });
  }

  // ---- Stripe: Bezahlvorgang starten
  if (p === '/api/checkout' && req.method === 'POST') {
    if (!stripe || !STRIPE_PRICE_ID) return json(res, 503, { error: 'Zahlung ist noch nicht eingerichtet.' });
    let kunde = u.stripe_customer_id;
    if (!kunde) {
      const c = await stripe.customers.create({ email: u.email, name: u.firma || u.name || undefined });
      kunde = c.id;
      await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [kunde, u.id]);
    }
    const sitzung = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: kunde,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${BASIS_URL}/konto.html?bezahlt=1`,
      cancel_url: `${BASIS_URL}/konto.html`,
      client_reference_id: String(u.id),
      allow_promotion_codes: true
    });
    return json(res, 200, { url: sitzung.url });
  }

  // ---- Stripe: Kundenportal (Kuendigung, Rechnungen, Zahlungsmittel)
  if (p === '/api/portal' && req.method === 'POST') {
    if (!stripe || !u.stripe_customer_id) return json(res, 400, { error: 'Kein Abo vorhanden.' });
    const s = await stripe.billingPortal.sessions.create({
      customer: u.stripe_customer_id, return_url: `${BASIS_URL}/konto.html`
    });
    return json(res, 200, { url: s.url });
  }

  // ---- Gutachten pruefen
  if (p === '/api/review' && req.method === 'POST') {
    if (!zugriffOk(u)) return json(res, 402, { error: 'Dein Testzeitraum ist beendet. Bitte schalte den Zugang frei.' });
    if (!ANTHROPIC_API_KEY) return json(res, 503, { error: 'Die Prüfung ist noch nicht eingerichtet.' });

    const heute = new Date().toISOString().slice(0, 10);
    const zaehler = (u.pruefungen_datum && u.pruefungen_datum.toISOString().slice(0, 10) === heute) ? u.pruefungen_heute : 0;
    if (zaehler >= PRUEFUNGEN_PRO_TAG) {
      return json(res, 429, { error: `Tagesgrenze von ${PRUEFUNGEN_PRO_TAG} Prüfungen erreicht (Fair Use). Morgen geht es weiter.` });
    }

    const b = await readBody(req);
    const text = String(b.text || '').trim();
    if (text.length < 200) return json(res, 400, { error: 'Der Text ist zu kurz für eine sinnvolle Prüfung.' });

    const system = `Du bist ein erfahrener Prüfer für Kfz-Schadengutachten in Deutschland.
Prüfe das Gutachten in genau diesen sechs Feldern:
1. Schadensbild und Kompatibilität (passen die Schadenbilder beider Fahrzeuge, ist der Hergang physikalisch plausibel)
2. Wiederbeschaffungswert und Restwert (Konsistenz, Marktreferenzen DAT/Schwacke, netto/brutto sauber getrennt)
3. 130-Prozent-Regel und Totalschadenabgrenzung (Vergleichsbasis ist der WBW brutto; Reparaturkosten netto plus merkantile Wertminderung)
4. Merkantiler Minderwert (aktuelle Modelle BVSK oder MFM; veraltete Methoden wie Halbgewachs sind zu rügen; reine Werkstattreferenz ist ein Fehler)
5. Vor- und Altschäden (erfasst, abgegrenzt, herausgerechnet)
6. Formales und Honorar (Vollständigkeit, Quellenangaben, Stundenverrechnungssätze mit Bezug zum BVSK-Honorarkorridor, EES-Werte nie ohne Berechnung)

Antworte AUSSCHLIESSLICH mit JSON, ohne Vorrede und ohne Markdown-Zeichen:
{"befunde":[{"ampel":"rot|gelb|gruen","feld":"<Prüffeld>","titel":"<kurz>","text":"<Begründung und konkreter Korrekturvorschlag>","fundstelle":"<Seite oder Abschnitt, sonst leer>"}],"zusammenfassung":"<2 Sätze>"}
Sei fachlich präzise und formuliere in der Sprache der Sachverständigenpraxis. Bewerte nur, was im Text steht.`;

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 4000, system,
          messages: [{ role: 'user', content: text.slice(0, 180000) }]
        })
      });
      if (!r.ok) { console.error('Anthropic:', r.status, await r.text()); return json(res, 502, { error: 'Die Prüfung ist fehlgeschlagen. Bitte erneut versuchen.' }); }
      const d = await r.json();
      const roh = (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('').replace(/```json|```/g, '').trim();
      let erg;
      try { erg = JSON.parse(roh); }
      catch { return json(res, 502, { error: 'Antwort konnte nicht gelesen werden. Bitte erneut versuchen.' }); }

      await pool.query(
        `UPDATE users SET pruefungen_gesamt = pruefungen_gesamt + 1,
         pruefungen_heute = $1, pruefungen_datum = CURRENT_DATE WHERE id = $2`, [zaehler + 1, u.id]);

      return json(res, 200, { ...erg, verbleibend_heute: PRUEFUNGEN_PRO_TAG - zaehler - 1 });
    } catch (e) {
      console.error('Pruef-Fehler:', e.message);
      return json(res, 500, { error: 'Serverfehler bei der Prüfung.' });
    }
  }

  return null;
}

// ------------------------------------------------------------- Stripe-Webhook
async function handleWebhook(req, res) {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return json(res, 503, { error: 'Webhook nicht eingerichtet' });
  const roh = await readBody(req, true);
  let ev;
  try {
    ev = stripe.webhooks.constructEvent(roh, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook-Signatur ungueltig:', e.message);
    return json(res, 400, { error: 'Signatur ungültig' });
  }

  const o = ev.data.object;
  try {
    if (ev.type === 'checkout.session.completed') {
      await pool.query(
        `UPDATE users SET plan = 'aktiv', plan_status = 'aktiv', stripe_subscription_id = $1
         WHERE stripe_customer_id = $2`, [o.subscription, o.customer]);
    }
    if (ev.type === 'invoice.payment_failed') {
      await pool.query(`UPDATE users SET plan_status = 'gesperrt' WHERE stripe_customer_id = $1`, [o.customer]);
    }
    if (ev.type === 'customer.subscription.deleted') {
      await pool.query(
        `UPDATE users SET plan = 'beendet', stripe_subscription_id = NULL WHERE stripe_customer_id = $1`, [o.customer]);
    }
  } catch (e) { console.error('Webhook-Verarbeitung:', e.message); }
  return json(res, 200, { received: true });
}

// ------------------------------------------------------------- Admin
async function handleAdmin(req, res, p, q) {
  if (!adminOk(req)) return json(res, 401, { error: 'Nicht autorisiert' });
  if (!pool) return json(res, 503, { error: 'Keine Datenbank verbunden' });

  if (p === '/api/admin/stats' && req.method === 'GET') {
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS gesamt,
        COUNT(*) FILTER (WHERE plan='trial' AND plan_status='aktiv')::int AS im_test,
        COUNT(*) FILTER (WHERE plan='aktiv')::int AS zahlend,
        COUNT(*) FILTER (WHERE plan_status='gesperrt')::int AS gesperrt,
        COUNT(*) FILTER (WHERE email_verified=0)::int AS unbestaetigt,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS neu_7t,
        COUNT(*) FILTER (WHERE plan='trial' AND trial_ends_at BETWEEN NOW() AND NOW() + INTERVAL '2 days')::int AS test_endet_bald,
        COALESCE(SUM(pruefungen_gesamt),0)::int AS pruefungen FROM users`);
    const s = rows[0];
    s.launch_plaetze_frei = Math.max(0, LAUNCH_KONTINGENT - s.zahlend);
    s.mrr = s.zahlend * PREIS_LAUNCH;
    return json(res, 200, s);
  }

  if (p === '/api/admin/users' && req.method === 'GET') {
    const suche = (q.get('q') || '').trim();
    const filter = (q.get('filter') || 'alle').trim();
    const w = []; const v = [];
    if (suche) { v.push(`%${suche}%`); w.push(`(email ILIKE $${v.length} OR COALESCE(firma,'') ILIKE $${v.length} OR COALESCE(name,'') ILIKE $${v.length})`); }
    if (filter === 'trial') w.push(`plan='trial'`);
    if (filter === 'zahlend') w.push(`plan='aktiv'`);
    if (filter === 'gesperrt') w.push(`plan_status='gesperrt'`);
    if (filter === 'unbestaetigt') w.push(`email_verified=0`);
    const { rows } = await pool.query(
      `SELECT id,email,name,firma,plan,plan_status,email_verified,launch_preis,trial_ends_at,
              pruefungen_gesamt,notiz,created_at,last_login_at FROM users
       ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 500`, v);
    return json(res, 200, { users: rows });
  }

  if (p === '/api/admin/feedback' && req.method === 'GET') {
    const { rows } = await pool.query(
      `SELECT f.id, f.text, f.created_at, u.email FROM feedback f
       LEFT JOIN users u ON u.id = f.user_id ORDER BY f.created_at DESC LIMIT 100`);
    return json(res, 200, { feedback: rows });
  }

  const mU = p.match(/^\/api\/admin\/users\/(\d+)$/);
  if (mU && (req.method === 'PATCH' || req.method === 'PUT')) {
    const b = await readBody(req);
    const erlaubt = ['plan', 'plan_status', 'email_verified', 'launch_preis', 'trial_ends_at', 'firma', 'name', 'notiz'];
    const f = []; const v = []; let i = 1;
    for (const k of erlaubt) if (b[k] !== undefined) { f.push(`${k} = $${i++}`); v.push(b[k] === '' ? null : b[k]); }
    if (!f.length) return json(res, 400, { error: 'Keine Änderungen übergeben' });
    v.push(mU[1]);
    const { rows } = await pool.query(`UPDATE users SET ${f.join(', ')} WHERE id = $${i} RETURNING *`, v);
    if (!rows.length) return json(res, 404, { error: 'Nutzer nicht gefunden' });
    return json(res, 200, { user: rows[0] });
  }

  if (mU && req.method === 'DELETE') {
    await pool.query('DELETE FROM users WHERE id = $1', [mU[1]]);
    return json(res, 200, { ok: true });
  }

  const mT = p.match(/^\/api\/admin\/users\/(\d+)\/trial$/);
  if (mT && req.method === 'POST') {
    const { tage } = await readBody(req);
    const t = parseInt(tage, 10);
    if (!Number.isFinite(t) || t < 1 || t > 365) return json(res, 400, { error: 'Tage muss zwischen 1 und 365 liegen' });
    const { rows } = await pool.query(
      `UPDATE users SET trial_ends_at = GREATEST(COALESCE(trial_ends_at,NOW()),NOW()) + ($1 || ' days')::interval,
       plan_status='aktiv' WHERE id = $2 RETURNING *`, [t, mT[1]]);
    if (!rows.length) return json(res, 404, { error: 'Nutzer nicht gefunden' });
    return json(res, 200, { user: rows[0] });
  }

  return json(res, 404, { error: 'Unbekannter Admin-Endpunkt' });
}

// ------------------------------------------------------------- Tagesjob
// Warnung 2 Tage vor Testende, Sperrung danach. Laeuft stuendlich.
async function tagesJob() {
  if (!pool) return;
  try {
    const { rows: warnen } = await pool.query(
      `SELECT email FROM users WHERE plan='trial' AND plan_status='aktiv' AND email_verified=1
       AND trial_ends_at BETWEEN NOW() + INTERVAL '47 hours' AND NOW() + INTERVAL '48 hours'`);
    for (const w of warnen) {
      await mailSenden(w.email, 'Dein Test bei KfzGut-AI endet in 2 Tagen',
        mailRahmen('Noch 2 Tage',
          `<p>Dein kostenloser Test läuft in zwei Tagen aus. Wenn du weitermachen möchtest, schalte den Zugang für ${PREIS_LAUNCH} € im Monat frei — als einer der ersten ${LAUNCH_KONTINGENT} Kunden dauerhaft zu diesem Preis.</p>`,
          'Zugang freischalten', `${BASIS_URL}/konto.html`));
    }
    const { rowCount } = await pool.query(
      `UPDATE users SET plan='beendet' WHERE plan='trial' AND trial_ends_at < NOW()`);
    if (rowCount) console.log(`${rowCount} abgelaufene Tests beendet.`);
  } catch (e) { console.error('Tagesjob:', e.message); }
}

// ------------------------------------------------------------- Statisch
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function serveStatic(req, res, p) {
  if (p === '/' || p === '') p = '/index.html';
  const datei = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!datei.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(datei, (err, data) => {
    if (err) {
      return fs.readFile(path.join(ROOT, 'index.html'), (e2, fb) => {
        if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nicht gefunden'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fb);
      });
    }
    const ext = path.extname(datei).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    res.end(data);
  });
}

// ------------------------------------------------------------- Server
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = decodeURIComponent(u.pathname);
  try {
    if (p === '/health') return json(res, 200, { status: 'ok', db: !!pool });
    if (p === '/api/stripe-webhook' && req.method === 'POST') return await handleWebhook(req, res);
    if (p.startsWith('/api/admin/')) return await handleAdmin(req, res, p, u.searchParams);

    if (['/api/register', '/api/verify', '/api/login', '/api/logout',
         '/api/resend-verify', '/api/passwort-vergessen', '/api/passwort-neu'].includes(p)) {
      const r = await handleAuth(req, res, p);
      if (r !== null) return r;
      return json(res, 405, { error: 'Methode nicht erlaubt' });
    }
    if (p.startsWith('/api/')) {
      const r = await handleKonto(req, res, p);
      if (r !== null) return r;
      return json(res, 404, { error: 'Unbekannter Endpunkt' });
    }
    return serveStatic(req, res, p);
  } catch (err) {
    console.error('Fehler:', err.message);
    return json(res, 500, { error: 'Serverfehler' });
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`KfzGut-AI laeuft auf Port ${PORT}`);
  const fehlt = [];
  if (!ADMIN_SECRET) fehlt.push('ADMIN_SECRET');
  if (!process.env.DATABASE_URL) fehlt.push('DATABASE_URL');
  if (!RESEND_API_KEY) fehlt.push('RESEND_API_KEY');
  if (!ANTHROPIC_API_KEY) fehlt.push('ANTHROPIC_API_KEY');
  if (!STRIPE_SECRET) fehlt.push('STRIPE_SECRET_KEY');
  if (fehlt.length) console.warn('Fehlende Variablen (Funktionen eingeschraenkt):', fehlt.join(', '));
  try { await initDb(); } catch (e) { console.error('DB-Init fehlgeschlagen:', e.message); }
  setInterval(tagesJob, 60 * 60 * 1000);
  setTimeout(tagesJob, 30000);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

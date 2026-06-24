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

const app    = express();
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
  <div style="background:#2a2a2a;border-radius:12px 12px 0 0;padding:22px 32px;display:flex;align-items:center">
    <span style="font-size:22px;color:white;font-family:Georgia,serif;letter-spacing:-0.01em">Immo<span style="color:rgba(255,255,255,0.6)">Gut</span>-<span style="color:#d95f1a">AI</span></span>
  </div>
  <div style="background:white;padding:32px;border-left:1px solid #e4e6ed;border-right:1px solid #e4e6ed">${content}</div>
  <div style="background:#f0f2f6;border:1px solid #e4e6ed;border-top:none;border-radius:0 0 12px 12px;padding:16px 32px;font-size:12px;color:#9a9a9a;text-align:center;line-height:1.7">
    ${footerExtra}
    <a href="${process.env.FRONTEND_URL}/impressum.html" style="color:#9a9a9a;text-decoration:none">Impressum</a> · 
    <a href="${process.env.FRONTEND_URL}/datenschutz.html" style="color:#9a9a9a;text-decoration:none">Datenschutz</a><br>
    KfzGut-AI · KI-Assistent für Kfz-Sachverständige
  </div>
</div></body></html>`;

const mails = {
  welcome: (name, verifyUrl) => ({
    subject: 'Willkommen bei KfzGut-AI – bestätige deine E-Mail',
    html: mailBase(`
      <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#2a2a2a;margin:0 0 8px">Willkommen bei KfzGut-AI!</h2>
      <p style="color:#6b6b6b;font-size:15px;line-height:1.75;margin:0 0 20px">Hallo ${name},<br><br>
      schön, dass Sie dabei sind. Bitte bestätigen Sie zunächst Ihre E-Mail-Adresse um Ihren 7-tägigen Testzugang zu aktivieren – keine Kreditkarte erforderlich.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${verifyUrl}" style="display:inline-block;background:#e8650a;color:white;padding:14px 32px;border-radius:9px;text-decoration:none;font-size:15px;font-weight:500;letter-spacing:0.01em">E-Mail bestätigen →</a>
      </div>
      <div style="background:#f0f2f6;border-radius:10px;padding:18px 20px;margin:20px 0">
        <p style="font-size:13px;font-weight:600;color:#2a2a2a;margin:0 0 12px">Was Sie in den nächsten 7 Tagen erwartet:</p>
        <div style="font-size:13px;color:#6b6b6b;line-height:1.8">
          <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:8px"><span style="color:#d95f1a;font-size:15px;flex-shrink:0">🔍</span> <div><strong style="color:#2a2a2a">Automatische Prüfung Ihrer Gutachten</strong><br>Formale Fehler, Plausibilität der Wertermittlung (Liegenschaftszins, Sachwertfaktor, § 194 BauGB) und Markteinschätzung – mit exakten Seitenzahlen und Korrekturvorschlägen.</div></div>
          <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:8px"><span style="color:#e8650a;font-size:15px;flex-shrink:0">✓</span> 55 ImmoWertV-konforme Textbausteine in 8 Kategorien</div>
          <div style="display:flex;align-items:flex-start;gap:8px"><span style="color:#e8650a;font-size:15px;flex-shrink:0">✓</span> Word-Export des Prüfberichts als formatierte Checkliste</div>
        </div>
      </div>
      <div style="background:#e8f5ed;border-radius:8px;padding:12px 16px;margin:16px 0;font-size:13px;color:#1a6e3a">
        🛡️ <strong>Datenschutz:</strong> Ihre Gutachten bleiben lokal in Ihrem Browser. Es werden keine personenbezogenen Daten gespeichert.
      </div>
      <p style="color:#9a9a9a;font-size:12px;line-height:1.65;margin:16px 0 0">Falls Sie sich nicht registriert haben, können Sie diese E-Mail ignorieren.<br><br>Mit freundlichen Grüßen<br><strong style="color:#2a2a2a">KfzGut-AI</strong></p>`,
      'Falls der Button nicht funktioniert, kopieren Sie diesen Link: ' + verifyUrl + '<br><br>'
    )
  }),
  trialWarning: (name, days) => ({
    subject: `Ihr KfzGut-AI Testzugang endet in ${days} ${days === 1 ? 'Tag' : 'Tagen'}`,
    html: mailBase(`
      <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#2a2a2a;margin:0 0 8px">Noch ${days} ${days === 1 ? 'Tag' : 'Tage'} Testzugang</h2>
      <p style="color:#6b6b6b;font-size:15px;line-height:1.75;margin:0 0 20px">Hallo ${name},<br><br>
      Ihr kostenloser Testzeitraum endet in ${days} ${days === 1 ? 'Tag' : 'Tagen'}. Um weiterhin alle Funktionen zu nutzen, abonnieren Sie jetzt für 149 €/Monat (kein USt-Ausweis gem. § 19 UStG).</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${process.env.FRONTEND_URL}/konto.html" style="display:inline-block;background:#d95f1a;color:white;padding:14px 32px;border-radius:9px;text-decoration:none;font-size:15px;font-weight:500">Jetzt abonnieren →</a>
      </div>
      <p style="color:#9a9a9a;font-size:12px;margin:16px 0 0">Mit freundlichen Grüßen<br><strong style="color:#2a2a2a">KfzGut-AI</strong></p>`)
  }),
  trialExpired: (name) => ({
    subject: 'Ihr KfzGut-AI Testzeitraum ist abgelaufen',
    html: mailBase(`
      <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#2a2a2a;margin:0 0 8px">Testzeitraum abgelaufen</h2>
      <p style="color:#6b6b6b;font-size:15px;line-height:1.75;margin:0 0 20px">Hallo ${name},<br><br>
      Ihr kostenloser Testzeitraum ist abgelaufen. Abonnieren Sie jetzt um wieder vollen Zugriff auf alle Prüf- und Generierungsfunktionen zu erhalten.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${process.env.FRONTEND_URL}/konto.html" style="display:inline-block;background:#e8650a;color:white;padding:14px 32px;border-radius:9px;text-decoration:none;font-size:15px;font-weight:500">Jetzt abonnieren – 149 €/Monat →</a>
      </div>
      <p style="color:#9a9a9a;font-size:12px;margin:16px 0 0">Mit freundlichen Grüßen<br><strong style="color:#2a2a2a">KfzGut-AI</strong></p>`)
  }),
  paymentFailed: (name) => ({
    subject: 'Zahlungsproblem bei KfzGut-AI – Bitte aktualisieren',
    html: mailBase(`
      <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#2a2a2a;margin:0 0 8px">Zahlung fehlgeschlagen</h2>
      <p style="color:#6b6b6b;font-size:15px;line-height:1.75;margin:0 0 20px">Hallo ${name},<br><br>
      bei deiner letzten Zahlung gab es leider ein Problem. Bitte aktualisiere deine Zahlungsdaten um deinen Zugang zu sichern.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${process.env.FRONTEND_URL}/konto.html" style="display:inline-block;background:#d95f1a;color:white;padding:14px 32px;border-radius:9px;text-decoration:none;font-size:15px;font-weight:500">Zahlungsdaten aktualisieren →</a>
      </div>
      <p style="color:#9a9a9a;font-size:12px;margin:16px 0 0">Viele Grüße<br><strong style="color:#2a2a2a">Dein KfzGut-AI Team</strong></p>`)
  }),
  subscriptionActive: (name) => ({
    subject: 'KfzGut-AI – Abonnement aktiv ✓',
    html: mailBase(`
      <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#2a2a2a;margin:0 0 8px">Abonnement aktiv ✓</h2>
      <p style="color:#6b6b6b;font-size:15px;line-height:1.75;margin:0 0 20px">Hallo ${name},<br><br>
      dein Abonnement ist aktiv. Du hast vollen Zugriff auf alle Funktionen von KfzGut-AI.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${process.env.FRONTEND_URL}/app.html" style="display:inline-block;background:#e8650a;color:white;padding:14px 32px;border-radius:9px;text-decoration:none;font-size:15px;font-weight:500">Zum Tool →</a>
      </div>
      <p style="color:#9a9a9a;font-size:12px;margin:16px 0 0">Viele Grüße<br><strong style="color:#2a2a2a">Dein KfzGut-AI Team</strong></p>`)
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
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'Kein Zugriff' });
  next();
}

function hasAccess(user) {
  if (!user) return false;
  if (!user.email_verified) return false;
  // 7-day free trial without payment method
  if (user.plan === 'trial' && user.plan_status === 'active') {
    return Math.floor(Date.now() / 1000) < user.trial_ends_at;
  }
  // Paid subscription
  if (user.plan === 'active_sub' && user.plan_status === 'active') return true;
  return false;
}

function trialDaysRemaining(user) {
  if (!user || user.plan !== 'trial') return 0;
  const secs = (user.trial_ends_at || 0) - Math.floor(Date.now() / 1000);
  return Math.max(0, Math.ceil(secs / 86400));
}

function freeChecksRemaining(user) {
  return Math.max(0, 3 - (user.free_checks_used || 0));
}
function freePromptsRemaining(user) {
  return Math.max(0, 3 - (user.free_prompts_used || 0));
}
function hasAnyFreeRemaining(user) {
  return freeChecksRemaining(user) > 0 || freePromptsRemaining(user) > 0;
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
app.post('/api/register', async (req, res) => {
  const { email, password, name, company } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'E-Mail und Passwort erforderlich' });
  if (password.length < 8) return res.status(400).json({ error: 'Passwort mindestens 8 Zeichen' });
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
  const result = await query('SELECT * FROM users WHERE email=$1', [email?.toLowerCase()]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'E-Mail oder Passwort falsch' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'E-Mail oder Passwort falsch' });
  await query('UPDATE users SET last_login_at=$1 WHERE id=$2', [Math.floor(Date.now()/1000), user.id]);
  res.json({
    token: signToken(user.id),
    user: { email: user.email, name: user.name, company: user.company,
      plan: user.plan, planStatus: user.plan_status, trialEndsAt: user.trial_ends_at,
      hasAccess: hasAccess(user), callsThisMonth: user.api_calls_month,
      trialDaysRemaining: trialDaysRemaining(user),
      freePromptsRemaining: freePromptsRemaining(user), freePromptsUsed: user.free_prompts_used || 0 }
  });
});

// ─── ME ───────────────────────────────────────────────────────────────────────
app.get('/api/me', authMiddleware, async (req, res) => {
  // Fast path: JWT is valid, return minimal response immediately if DB is slow
  res.setTimeout(8000, () => {
    if (!res.headersSent) res.json({ email: '', name: '', plan: 'trial', hasAccess: true, emailVerified: true, _cached: true });
  });
  const result = await query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json({ email: user.email, name: user.name, company: user.company,
    plan: user.plan, planStatus: user.plan_status, trialEndsAt: user.trial_ends_at,
    hasAccess: hasAccess(user), callsThisMonth: user.api_calls_month, createdAt: user.created_at,
    freeChecksRemaining: freeChecksRemaining(user), freeChecksUsed: user.free_checks_used || 0,
    emailVerified: !!user.email_verified });
});

// ─── UPDATE PROFILE ───────────────────────────────────────────────────────────
app.put('/api/me', authMiddleware, async (req, res) => {
  const { name, company, password, currentPassword } = req.body;
  const result = await query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
  const user = result.rows[0];
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

// ─── VERIFY EMAIL ────────────────────────────────────────────────────────────
app.get('/api/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Kein Token' });
  try {
    const result = await query('SELECT * FROM users WHERE verify_token=$1', [token]);
    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: 'Ungültiger oder abgelaufener Link' });
    if (user.email_verified) return res.json({ ok: true, alreadyVerified: true, freeChecksRemaining: freeChecksRemaining(user) });
    await query('UPDATE users SET email_verified=1, verify_token=NULL WHERE id=$1', [user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// ─── CHECKOUT ─────────────────────────────────────────────────────────────────
app.post('/api/checkout', authMiddleware, async (req, res) => {
  const result = await query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
  const user = result.rows[0];
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

    // Kleinunternehmer: keine USt ausweisen
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/app.html?checkout=success`,
      payment_method_types: ['card', 'sepa_debit'],
      billing_address_collection: 'required',
      cancel_url: `${process.env.FRONTEND_URL}/konto.html`,
      metadata: { userId: String(user.id) },
      subscription_data: {
        metadata: { userId: String(user.id) },
      },
    });
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
  const result = await query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
  const user = result.rows[0];
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
  } catch (err) { return res.status(400).send('Webhook error: ' + err.message); }

  const obj = event.data.object;
  const userId = obj.metadata?.userId;

  if (event.type === 'checkout.session.completed' && userId) {
    await query(`UPDATE users SET stripe_subscription_id=$1, plan='active_sub', plan_status='active' WHERE id=$2`,
      [obj.subscription, userId]);
    const u = (await query('SELECT * FROM users WHERE id=$1', [userId])).rows[0];
    if (u) { const m = mails.subscriptionActive(u.name||u.email.split('@')[0]); await sendMail(u.email, m.subject, m.html); }
  }
  if (event.type === 'customer.subscription.updated' && userId) {
    await query('UPDATE users SET plan_status=$1 WHERE id=$2', [obj.status === 'active' ? 'active' : obj.status, userId]);
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
  const result = await query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
  if (!hasAccess(user)) {
    const expired = user.plan === 'trial' && Math.floor(Date.now()/1000) >= user.trial_ends_at;
    return res.status(403).json({ error: expired ? 'Testzeitraum abgelaufen' : 'Kein Zugriff', code: 'UPGRADE_REQUIRED' });
  }

  const now = Math.floor(Date.now()/1000);
  if (now > user.api_calls_reset_at) {
    await query('UPDATE users SET api_calls_month=0, api_calls_reset_at=$1 WHERE id=$2', [now+30*24*3600, user.id]);
  }

  const { system, prompt, promptType } = req.body;
  if (!system || !prompt) return res.status(400).json({ error: 'system und prompt erforderlich' });

  try {
    await query('UPDATE users SET api_calls_month=api_calls_month+1 WHERE id=$1', [user.id]);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
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
  const result = await query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
  if (!hasAccess(user)) return res.status(403).json({ error: 'Testzeitraum abgelaufen', code: 'UPGRADE_REQUIRED', trialDaysRemaining: 0 });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt erforderlich' });

  const systemPrompt = `Du bist öffentlich bestellter und vereidigter Kfz-Sachverständiger (BVSK, GTÜ, DEKRA) mit 20 Jahren Erfahrung in der Erstellung und Prüfung von Kraftfahrzeugschadensgutachten. Du prüfst Gutachten wie ein erfahrener Kollege der gegenliest.

Der Text stammt aus einem PDF mit Seitenmarkierungen [Seite X]. PDF-Layoutartefakte und Zahlenkolonnen ignorieren.

GRUNDPRINZIP – SEHR WICHTIG:
Nenne NUR echte Fehler und klare Lücken. Nenne KEINE plausiblen, üblichen oder fachlich vertretbaren Aussagen.
Wenn ein Wert oder eine Formulierung im Rahmen des Üblichen liegt → NICHT nennen, auch wenn du es anders machen würdest.
Lieber 3 echte Fehler als 10 Pseudo-Hinweise. Kurze, konkrete Liste – kein Vollständigkeitsanspruch.

AMPEL:
- "rot" = echter schwerer Fehler, der das Gutachten angreifbar macht
- "gelb" = echte Lücke oder Unklarheit die behoben werden sollte
- "gruen" = alles in Ordnung
- Kategorie ohne Beanstandungen → ampel IMMER "gruen"
- Kategorien Rechtschreibung, Platzhalter, Formales → maximal "gelb", nie "rot"

Antworte NUR als reines JSON, kein Text, keine Backticks:

{
  "kategorien": [
    { "name": "Kritische Fehler", "ampel": "gruen", "punkte": ["Keine Beanstandungen"] },
    { "name": "Plausiblitaet und Kompatibilitaet", "ampel": "gruen", "punkte": ["Keine Beanstandungen"] },
    { "name": "Wertermittlung und Schadenkalkulation", "ampel": "gruen", "punkte": ["Keine Beanstandungen"] },
    { "name": "Offene Platzhalter", "ampel": "gruen", "punkte": ["Keine Beanstandungen"] },
    { "name": "Rechtschreibung und Sprache", "ampel": "gruen", "punkte": ["Keine Beanstandungen"] },
    { "name": "Formales und Gliederung", "ampel": "gruen", "punkte": ["Keine Beanstandungen"] }
  ]
}

KATEGORIE 1 – Kritische Fehler (ampel "rot" wenn vorhanden):
Nur eintragen wenn EINDEUTIG nachweisbar:
- Gleicher Wert (Reparaturkosten, WBW, Restwert) an zwei Stellen unterschiedlich
- Fahrzeugidentifikation widersprüchlich (FIN, Kennzeichen, Erstzulassung)
- Totalschadenberechnung rechnerisch falsch (Reparaturkosten > WBW aber kein Totalschaden ausgewiesen)
- Satz bricht mitten im Text ab oder Text fehlt erkennbar
- 130%-Grenze falsch angewendet oder nicht geprüft

KATEGORIE 2 – Plausibilitaet und Kompatibilitaet (ampel "rot" oder "gelb"):
ZWEI Prüfebenen – beide sind Pflicht:
Ebene 1 – KOMPATIBILITÄT: Passen die Schadenbilder beider Fahrzeuge zusammen?
- Beschädigungsmuster, Eindringstiefe und Steifigkeit der Fahrzeugzonen müssen zueinanderpassen
- Materialübertragungen (Lackreste, Kunststoffspuren) müssen konsistent sein
- Fehlende Stellungnahme zur Kompatibilität = Lücke (gelb)
Ebene 2 – PHYSIKALISCHE PLAUSIBILITÄT: Ist der geschilderte Unfallhergang physikalisch schlüssig?
- Masse, Geschwindigkeit und Wegstrecke müssen zum Schadenbild passen
- EES-Werte oder Kollisionsgeschwindigkeit ohne technische Berechnung nur behauptet → gelb
- Vorschäden/Altschäden nicht von Unfallschäden abgegrenzt → rot
NUR dann nennen wenn die Lücke für einen Richter oder eine Versicherung ein echtes Problem wäre.

KATEGORIE 3 – Wertermittlung und Schadenkalkulation (ampel "rot" oder "gelb"):
- Wiederbeschaffungswert (WBW) ohne DAT/Schwacke-Quellenangabe → gelb
- Restwert ohne Marktrecherche (mind. 3 Angebote bei WBW > 3.000 €) → gelb
- Stundenverrechnungssätze ohne Quellenangabe (BVSK-Korridor für Region fehlt) → gelb
- Merkantiler Minderwert: Berechnungsmethode nicht genannt (BVSK-Modell oder MFM) → gelb
- Merkantiler Minderwert unter Bagatellgrenze (ca. 750 €) trotzdem angesetzt ohne Begründung → gelb
- Reparaturkosten netto/brutto-Unterscheidung fehlt → rot
- Lohnkosten-Berechnung (AW × Stundensatz) nicht nachvollziehbar → gelb
Wenn Werte plausibel oder mit Quelle belegt → NICHT nennen.

KATEGORIE 4 – Offene Platzhalter (maximal "gelb"):
Nur ungefüllte [Platzhalter in eckigen Klammern] die noch konkrete Werte benötigen.

KATEGORIE 5 – Rechtschreibung und Sprache (maximal "gelb"):
Nur klare Tippfehler oder abgebrochene Sätze. Stilistische Unterschiede → NICHT nennen.

KATEGORIE 6 – Formales und Gliederung (maximal "gelb"):
Nur wenn Anlagennummern, Lichtbildverweise oder Seitenverweise nachweislich falsch sind.
Fehlende Unterschrift oder Stempel des Sachverständigen → rot.

REGELN:
- Jeden Punkt mit "Seite X:" beginnen
- Fehler konkret benennen + Korrekturvorschlag
- Max. 5 Punkte pro Kategorie
- Keine Beanstandungen → punkte: ["Keine Beanstandungen"], ampel: "gruen"`;

  try {
    await query('UPDATE users SET api_calls_month=api_calls_month+1 WHERE id=$1', [user.id]);

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
      { key: 'kritischefehler',             display: 'Kritische Fehler',                  maxAmpel: 'rot'    },
      { key: 'plausibilitaetderwertermittlung', display: 'Plausibilität der Wertermittlung', maxAmpel: 'rot'    },
      { key: 'markteinschaetzung',            display: 'Markteinschätzung',                  maxAmpel: 'gelb' },
      { key: 'offeneplatzhalter',            display: 'Offene Platzhalter',                maxAmpel: 'gelb' },
      { key: 'rechtschreibungundsprache',    display: 'Rechtschreibung & Sprache',         maxAmpel: 'gelb' },
      { key: 'formalesundgliederung',        display: 'Formales & Gliederung',             maxAmpel: 'gelb' },
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
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
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
                  return `Prüfe Abschnitt ${ci+1} von ${maxChunks} des Gutachtens.\nSeiten in diesem Abschnitt: ${firstPage}–${lastPage} (von insgesamt ${totalPages} Seiten).\nNur Fehler aus DIESEM Abschnitt benennen – keine Vermutungen über andere Abschnitte.\n\n${c}`;
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
    const zusammenfassung = totalProblems === 0
      ? `Gutachten ohne Beanstandungen – bereit zur Fertigstellung. (${seiten} Seiten analysiert)`
      : `${totalProblems} Hinweis${totalProblems !== 1 ? 'e' : ''} auf ${seiten} Seiten gefunden – bitte vor Fertigstellung prüfen.`;

    const cost = (totalTokens / 1000) * 0.003;
    await query('INSERT INTO api_logs (user_id, prompt_type, tokens, cost_eur) VALUES ($1,$2,$3,$4)',
      [user.id, 'review', totalTokens, cost]);

    res.json({ result: { gesamtbewertung, zusammenfassung, kategorien: finalKategorien } });

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
  const result = await query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
  const user = result.rows[0];
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
    // 3. Delete DB records
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
  const result = await query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: 'Nicht gefunden' });
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
  const result = await query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
  const user = result.rows[0];
  const { rating, categories, message } = req.body;
  await query('INSERT INTO feedback (user_id, email, rating, categories, message) VALUES ($1,$2,$3,$4,$5)',
    [user?.id||null, user?.email||'', rating||0, JSON.stringify(categories||[]), message||'']);
  res.json({ ok: true });
});

// ─── ADMIN STATS ──────────────────────────────────────────────────────────────
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  const users = (await query(`SELECT id, email, name, company, plan, plan_status,
    trial_ends_at, api_calls_month, created_at, last_login_at FROM users ORDER BY created_at DESC`)).rows;
  const costs = (await query('SELECT SUM(tokens) as tokens, SUM(cost_eur) as cost FROM api_logs')).rows[0];
  const paying = (await query(`SELECT COUNT(*) as n FROM users WHERE plan='active_sub' AND plan_status='active'`)).rows[0];
  const trials = (await query(`SELECT COUNT(*) as n FROM users WHERE plan='trial' AND plan_status='active'`)).rows[0];
  const feedback = (await query('SELECT * FROM feedback ORDER BY created_at DESC LIMIT 50')).rows;
  const now = Math.floor(Date.now()/1000);

  res.json({
    users: users.map(u => ({ ...u,
      hasAccess: u.plan==='active_sub' ? u.plan_status==='active' : (u.plan==='trial' && now<u.trial_ends_at),
      trialDaysLeft: u.plan==='trial' ? Math.max(0, Math.ceil((u.trial_ends_at-now)/86400)) : null,
    })),
    summary: { totalUsers: users.length, paying: parseInt(paying.n), trials: parseInt(trials.n),
      revenue: parseInt(paying.n)*99, apiCost: Math.round((costs.cost||0)*100)/100 },
    feedback,
  });
});

app.put('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  const { plan, plan_status, email_verified } = req.body;
  await query(
    'UPDATE users SET plan=$1, plan_status=$2, email_verified=COALESCE($3, email_verified) WHERE id=$4',
    [plan, plan_status, email_verified !== undefined ? email_verified : null, req.params.id]
  );
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  await query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ─── CRON: Trial Management ───────────────────────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  const now = Math.floor(Date.now()/1000);
  const warnAt = now + 2*24*3600;

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
  console.log(`[CRON] Warned: ${toWarn.length}, Expired: ${expired.length}`);
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 KfzGut-AI Server läuft auf Port ${PORT}`);
    console.log(`   Frontend: ${process.env.FRONTEND_URL || 'nicht gesetzt'}`);
  });
}).catch(err => { console.error('DB Fehler:', err); process.exit(1); });

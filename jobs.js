/**
 * KfzGut-AI — Tagesjob
 *
 * Laeuft als eigener Railway-Cron-Service einmal taeglich und beendet sich danach.
 * Start-Command in Railway:  node jobs.js
 * Cron-Schedule:             0 7 * * *     (taeglich 07:00 UTC = 09:00 MESZ)
 *
 * Aufgaben:
 *  1. Warnung zwei Tage vor Ablauf des Testzeitraums
 *  2. Abgelaufene Tests auf "beendet" setzen
 *  3. Alte Sitzungen aufraeumen
 */
const { Pool } = require('pg');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ABSENDER = process.env.MAIL_FROM || 'KfzGut-AI <noreply@kfzgut-ai.de>';
const BASIS_URL = (process.env.BASIS_URL || 'https://kfzgut-ai.de').replace(/\/$/, '');
const PREIS_LAUNCH = 79;
const LAUNCH_KONTINGENT = 50;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL fehlt — Job wird abgebrochen.');
  process.exit(1);
}

const lokal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: lokal ? false : { rejectUnauthorized: false }
});

async function mailSenden(an, betreff, html) {
  if (!RESEND_API_KEY) { console.warn('RESEND_API_KEY fehlt — keine Mail an', an); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: ABSENDER, to: [an], subject: betreff, html })
    });
    if (!r.ok) { console.error('Resend:', r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.error('Mailversand:', e.message); return false; }
}

function rahmen(titel, inhalt, knopfText, knopfLink) {
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#1B2530">
    <div style="border-bottom:3px solid #E8590C;padding-bottom:12px;margin-bottom:22px">
      <span style="font-size:19px;font-weight:800">KfzGut<span style="color:#E8590C">-AI</span></span></div>
    <h1 style="font-size:21px;margin:0 0 14px">${titel}</h1>
    <div style="font-size:15px;line-height:1.6;color:#46525F">${inhalt}</div>
    ${knopfLink ? `<p style="margin:26px 0"><a href="${knopfLink}" style="background:#E8590C;color:#fff;text-decoration:none;padding:13px 26px;border-radius:6px;font-weight:700;display:inline-block">${knopfText}</a></p>` : ''}
    <p style="font-size:12px;color:#8A97A3;border-top:1px solid #DDE1E4;padding-top:16px;margin-top:26px">
      KfzGut-AI · Prüfassistent für Kfz-Schadengutachten</p></div>`;
}

async function lauf() {
  let gewarnt = 0;

  // 1. Warnung zwei Tage vor Ablauf.
  // warn_gesendet verhindert doppelte Mails, falls der Job zweimal laeuft.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS warn_gesendet SMALLINT NOT NULL DEFAULT 0`);

  const { rows: warnen } = await pool.query(`
    SELECT id, email FROM users
    WHERE plan = 'trial' AND plan_status = 'aktiv' AND email_verified = 1
      AND warn_gesendet = 0
      AND trial_ends_at BETWEEN NOW() AND NOW() + INTERVAL '2 days'`);

  for (const u of warnen) {
    const ok = await mailSenden(u.email, 'Dein Test bei KfzGut-AI endet in 2 Tagen',
      rahmen('Noch 2 Tage',
        `<p>Dein kostenloser Test läuft in zwei Tagen aus.</p>
         <p>Wenn du weitermachen möchtest, schalte den Zugang für ${PREIS_LAUNCH} € netto im Monat frei —
         als einer der ersten ${LAUNCH_KONTINGENT} Kunden bleibt dieser Preis dauerhaft für dich bestehen.</p>`,
        'Zugang freischalten', `${BASIS_URL}/konto.html`));
    if (ok) {
      await pool.query('UPDATE users SET warn_gesendet = 1 WHERE id = $1', [u.id]);
      gewarnt++;
    }
  }

  // 2. Abgelaufene Tests beenden
  const { rowCount: beendet } = await pool.query(
    `UPDATE users SET plan = 'beendet' WHERE plan = 'trial' AND trial_ends_at < NOW()`);

  // 3. Sitzungen aelter als 30 Tage entfernen
  const { rowCount: sitzungen } = await pool.query(
    `DELETE FROM sessions WHERE created_at < NOW() - INTERVAL '30 days'`);

  console.log(`Tagesjob fertig — ${gewarnt} Warnungen, ${beendet} Tests beendet, ${sitzungen} Sitzungen entfernt.`);
}

lauf()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((e) => { console.error('Tagesjob fehlgeschlagen:', e.message); process.exit(1); });

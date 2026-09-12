const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const LAUNCH_KONTINGENT = 50;
const PREIS_LAUNCH = 79;

// ---------------------------------------------------------------- Datenbank
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

async function initDb() {
  if (!pool) {
    console.warn('DATABASE_URL fehlt — Server laeuft nur als Static-Host, Admin ist deaktiviert.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      name TEXT,
      firma TEXT,
      plan TEXT NOT NULL DEFAULT 'trial',
      plan_status TEXT NOT NULL DEFAULT 'aktiv',
      email_verified SMALLINT NOT NULL DEFAULT 0,
      verify_token TEXT,
      trial_ends_at TIMESTAMPTZ,
      stripe_customer_id TEXT,
      launch_preis SMALLINT NOT NULL DEFAULT 0,
      pruefungen_gesamt INTEGER NOT NULL DEFAULT 0,
      notiz TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS users_created_idx ON users (created_at DESC);
  `);
  console.log('Datenbank bereit.');
}

// ---------------------------------------------------------------- Helfer
function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Ungueltiges JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Zeitkonstanter Vergleich — verhindert Erraten des Passworts per Timing
function adminOk(req) {
  if (!ADMIN_SECRET) return false;
  const a = Buffer.from(String(req.headers['x-admin-secret'] || ''));
  const b = Buffer.from(ADMIN_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- Admin-API
async function handleAdmin(req, res, urlPath, query) {
  // Auth zuerst — sonst verraet der Server Unbefugten den Datenbank-Status
  if (!adminOk(req)) return json(res, 401, { error: 'Nicht autorisiert' });
  if (!pool) return json(res, 503, { error: 'Keine Datenbank verbunden' });

  if (urlPath === '/api/admin/stats' && req.method === 'GET') {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int AS gesamt,
        COUNT(*) FILTER (WHERE plan = 'trial' AND plan_status = 'aktiv')::int AS im_test,
        COUNT(*) FILTER (WHERE plan = 'aktiv')::int AS zahlend,
        COUNT(*) FILTER (WHERE plan_status = 'gesperrt')::int AS gesperrt,
        COUNT(*) FILTER (WHERE email_verified = 0)::int AS unbestaetigt,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS neu_7t,
        COUNT(*) FILTER (WHERE plan = 'trial' AND trial_ends_at BETWEEN NOW() AND NOW() + INTERVAL '2 days')::int AS test_endet_bald,
        COALESCE(SUM(pruefungen_gesamt), 0)::int AS pruefungen
      FROM users
    `);
    const s = rows[0];
    s.launch_plaetze_frei = Math.max(0, LAUNCH_KONTINGENT - s.zahlend);
    s.mrr = s.zahlend * PREIS_LAUNCH;
    return json(res, 200, s);
  }

  if (urlPath === '/api/admin/users' && req.method === 'GET') {
    const suche = (query.get('q') || '').trim();
    const filter = (query.get('filter') || 'alle').trim();
    const where = [];
    const werte = [];
    if (suche) {
      werte.push(`%${suche}%`);
      where.push(`(email ILIKE $${werte.length} OR COALESCE(firma,'') ILIKE $${werte.length} OR COALESCE(name,'') ILIKE $${werte.length})`);
    }
    if (filter === 'trial') where.push(`plan = 'trial'`);
    if (filter === 'zahlend') where.push(`plan = 'aktiv'`);
    if (filter === 'gesperrt') where.push(`plan_status = 'gesperrt'`);
    if (filter === 'unbestaetigt') where.push(`email_verified = 0`);

    const { rows } = await pool.query(
      `SELECT id, email, name, firma, plan, plan_status, email_verified, launch_preis,
              trial_ends_at, pruefungen_gesamt, notiz, created_at, last_login_at
       FROM users
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at DESC LIMIT 500`,
      werte
    );
    return json(res, 200, { users: rows });
  }

  const mUser = urlPath.match(/^\/api\/admin\/users\/(\d+)$/);
  if (mUser && (req.method === 'PATCH' || req.method === 'PUT')) {
    const body = await readBody(req);
    const erlaubt = ['plan', 'plan_status', 'email_verified', 'launch_preis', 'trial_ends_at', 'firma', 'name', 'notiz'];
    const felder = [];
    const werte = [];
    let i = 1;
    for (const key of erlaubt) {
      if (body[key] !== undefined) {
        felder.push(`${key} = $${i++}`);
        werte.push(body[key] === '' ? null : body[key]);
      }
    }
    if (!felder.length) return json(res, 400, { error: 'Keine Aenderungen uebergeben' });
    werte.push(mUser[1]);
    const { rows } = await pool.query(
      `UPDATE users SET ${felder.join(', ')} WHERE id = $${i} RETURNING *`,
      werte
    );
    if (!rows.length) return json(res, 404, { error: 'Nutzer nicht gefunden' });
    return json(res, 200, { user: rows[0] });
  }

  if (mUser && req.method === 'DELETE') {
    await pool.query('DELETE FROM users WHERE id = $1', [mUser[1]]);
    return json(res, 200, { ok: true });
  }

  const mTrial = urlPath.match(/^\/api\/admin\/users\/(\d+)\/trial$/);
  if (mTrial && req.method === 'POST') {
    const { tage } = await readBody(req);
    const t = parseInt(tage, 10);
    if (!Number.isFinite(t) || t < 1 || t > 365) {
      return json(res, 400, { error: 'Tage muss zwischen 1 und 365 liegen' });
    }
    const { rows } = await pool.query(
      `UPDATE users
       SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) + ($1 || ' days')::interval,
           plan_status = 'aktiv'
       WHERE id = $2 RETURNING *`,
      [t, mTrial[1]]
    );
    if (!rows.length) return json(res, 404, { error: 'Nutzer nicht gefunden' });
    return json(res, 200, { user: rows[0] });
  }

  return json(res, 404, { error: 'Unbekannter Admin-Endpunkt' });
}

// ---------------------------------------------------------------- Statisch
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res, urlPath) {
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      return fs.readFile(path.join(ROOT, 'index.html'), (e2, fb) => {
        if (e2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Nicht gefunden');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fb);
      });
    }
    const ext = path.extname(filePath).toLowerCase();
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

// ---------------------------------------------------------------- Server
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const urlPath = decodeURIComponent(u.pathname);
  try {
    if (urlPath === '/health') return json(res, 200, { status: 'ok', db: !!pool });
    if (urlPath.startsWith('/api/admin/')) return await handleAdmin(req, res, urlPath, u.searchParams);
    return serveStatic(req, res, urlPath);
  } catch (err) {
    console.error('Fehler:', err.message);
    return json(res, 500, { error: 'Serverfehler' });
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`KfzGut-AI laeuft auf Port ${PORT}`);
  if (!ADMIN_SECRET) console.warn('ADMIN_SECRET fehlt — Admin-Dashboard ist gesperrt.');
  try {
    await initDb();
  } catch (e) {
    console.error('DB-Init fehlgeschlagen:', e.message);
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

// Implementation moved here to avoid static import duplication when deployments concatenate files.
// This file was generated from the previous server.js content.

import express from 'express';
import path from 'path';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
// Postgres optional (installed only if using managed DB)
let pool = null; // will hold pg Pool when DATABASE_URL provided
let usePg = !!process.env.DATABASE_URL;
if(usePg){
  try {
    const pg = await import('pg');
    const { Pool } = pg;
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Most free providers require SSL; allow disabling via PGSSL=0
      ssl: process.env.PGSSL === '0' ? false : { rejectUnauthorized: false }
    });
    await pool.query('SELECT 1');
    console.log('[Postgres] Connected.');
  } catch(e){
    console.error('[Postgres] Failed to initialize, falling back to SQLite:', e.message);
    usePg = false;
  }
}

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let dbFile = null; let db = null;
if(!usePg){
  sqlite3.verbose();
  dbFile = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, 'data.db');
  try { fs.mkdirSync(path.dirname(dbFile), { recursive: true }); } catch(e) {}
  db = new sqlite3.Database(dbFile, (err)=> {
    if(err) console.error('Failed to open SQLite DB:', err.message);
    else console.log('[SQLite] Using database file:', dbFile);
  });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;", (e)=>{ if(e) console.warn('PRAGMA set failed', e.message); });
}

// Unified helpers (Postgres vs SQLite)
async function runAsync(sql, params=[]) {
  if(usePg){
    // pg: use pool.query
    return pool.query(sql, params);
  }
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err){ if(err) reject(err); else resolve(this); });
  });
}
async function allAsync(sql, params=[]) {
  if(usePg){
    const r = await pool.query(sql, params);
    return r.rows;
  }
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows)=> { if(err) reject(err); else resolve(rows); });
  });
}
async function execAsync(sql){
  if(usePg){
    // For multi-statement exec, split by ; (simple cases). Prefer transactions explicitly.
    const statements = sql.split(';').map(s=> s.trim()).filter(Boolean);
    for(const st of statements){ await pool.query(st); }
    return;
  }
  return new Promise((resolve, reject)=> db.exec(sql, err=> err? reject(err): resolve()));
}

async function initDb() {
  if(usePg){
    await runAsync(`CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('income','expenditure')),
      name TEXT NOT NULL,
      date DATE NOT NULL,
      amount NUMERIC NOT NULL
    )`);
    // Ensure uniqueness to avoid accidental duplicate inserts from client races
    try {
      await runAsync(`CREATE UNIQUE INDEX IF NOT EXISTS transactions_unique_idx ON transactions(type,name,date,amount)`);
    } catch(ixErr){
      console.warn('[Postgres] Unique index creation failed, attempting to deduplicate existing rows:', ixErr.message);
      try {
        await runAsync(`DELETE FROM transactions WHERE id NOT IN (SELECT MIN(id) FROM transactions GROUP BY type,name,date,amount)`);
        console.log('[Postgres] Deduplication complete, retrying index creation');
        await runAsync(`CREATE UNIQUE INDEX IF NOT EXISTS transactions_unique_idx ON transactions(type,name,date,amount)`);
      } catch(dedupeErr){
        console.error('[Postgres] Deduplication or index recreation failed:', dedupeErr.message);
      }
    }
    // Ensure author columns exist in Postgres
    try { await runAsync(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_by TEXT`); } catch(e){}
    try { await runAsync(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS updated_by TEXT`); } catch(e){}
    // Optional one-time migration from existing SQLite data file
    if(process.env.PG_MIGRATE_FROM_SQLITE === '1'){
      const possibleSqlite = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, 'data.db');
      try {
        if(fs.existsSync(possibleSqlite)){
          const tmpDb = new sqlite3.Database(possibleSqlite);
          const getAll = (sql, params=[]) => new Promise((res,rej)=> tmpDb.all(sql, params,(e,r)=> e?rej(e):res(r)));
          const rows = await getAll('SELECT * FROM transactions');
          const pgCount = await pool.query('SELECT COUNT(*) FROM transactions');
            if(parseInt(pgCount.rows[0].count,10) === 0 && rows.length){
              console.log(`[Migration] Importing ${rows.length} rows from SQLite -> Postgres`);
              await pool.query('BEGIN');
              try {
                for(const r of rows){
                  await pool.query('INSERT INTO transactions (type,name,date,amount) VALUES ($1,$2,$3,$4)', [r.type, r.name, r.date, r.amount]);
                }
                await pool.query('COMMIT');
                console.log('[Migration] Completed successfully.');
              } catch(mErr){
                await pool.query('ROLLBACK');
                console.error('[Migration] Failed, rolled back:', mErr.message);
              }
            } else {
              console.log('[Migration] Skipped (Postgres not empty or no rows in SQLite).');
            }
          tmpDb.close();
        } else {
          console.log('[Migration] No SQLite file found to migrate.');
        }
      } catch(e){ console.warn('[Migration] Error during migration attempt:', e.message); }
    }
  } else {
    await execAsync(`CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('income','expenditure')),
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL
    );`);
    // Add unique index for dedupe
    await execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS transactions_unique_idx ON transactions(type,name,date,amount);`);
  }
              // Add author columns for SQLite (ALTER TABLE ADD COLUMN is safe; ignore errors)
              try { await execAsync(`ALTER TABLE transactions ADD COLUMN created_by TEXT;`); } catch(e){}
              try { await execAsync(`ALTER TABLE transactions ADD COLUMN updated_by TEXT;`); } catch(e){}
}

// Regenerate combined dual-column CSV after data changes
async function regenerateDualCsv(){
  try {
    const rows = await allAsync('SELECT * FROM transactions ORDER BY id ASC');
    const expenditures = rows.filter(r=> r.type==='expenditure');
    const incomes = rows.filter(r=> r.type==='income');
    const max = Math.max(expenditures.length, incomes.length);
    let csv = 'Expenditure,,,,,,,Income,,,,,,,' + '\n';
    csv += 'Name,Date,Amount,Quantity,,Name,Date,Amount,,,,,,,' + '\n';
    for(let i=0;i<max;i++){
      const exp = expenditures[i] || {};
      const inc = incomes[i] || {};
      const expRow = `${exp.name||''},${exp.date||''},${exp.amount!=null?exp.amount:''},,,`;
      const incRow = `${inc.name||''},${inc.date||''},${inc.amount!=null?inc.amount:''},,,,,`;
      csv += expRow + incRow + '\n';
    }
    fs.writeFileSync(path.join(__dirname,'updated-financial-data.csv'), csv, 'utf8');
  } catch(e){
    console.warn('CSV regeneration failed:', e.message);
  }
}

// (Legacy CSV import functionality removed)
// Simple session auth: single admin + guest
const ADMIN_PASSWORD = '8763951777';
const sessions = new Map(); // sid -> { username, role, created }
function parseCookies(header){
  const out = {}; if(!header) return out; header.split(/; */).forEach(p=> { const i=p.indexOf('='); if(i>0){ const k=decodeURIComponent(p.slice(0,i).trim()); const v=decodeURIComponent(p.slice(i+1).trim()); out[k]=v; } }); return out;
}
function sessionMiddleware(req,res,next){
  const cookies = parseCookies(req.headers.cookie||'');
  const sid = cookies.sid;
  if(sid && sessions.has(sid)){
    req.session = sessions.get(sid);
  }
  next();
}
function requireEditor(req,res,next){
  if(req.session && req.session.role === 'editor') return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// Removed /api/import-csv-once endpoint

app.use(cors({ credentials:true, origin:true }));
app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(__dirname));

app.post('/api/login', (req,res)=> {
  const { mode, password, username } = req.body || {};
  const effective = mode || username; // allow legacy payloads {username:'guest'} or new {mode:'guest'}
  if(effective === 'guest'){
    const sid = crypto.randomUUID();
    sessions.set(sid, { username:'guest', role:'guest', created: Date.now() });
    res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
    return res.json({ username:'guest', role:'guest' });
  }
  if(effective === 'admin'){
    if(password !== ADMIN_PASSWORD){ return res.status(401).json({ error:'Invalid password' }); }
    const sid = crypto.randomUUID();
    sessions.set(sid, { username:'admin', role:'editor', created: Date.now() });
    res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
    return res.json({ username:'admin', role:'editor' });
  }
  return res.status(400).json({ error:'Invalid mode' });
});
app.post('/api/logout', (req,res)=> {
  const cookies = parseCookies(req.headers.cookie||'');
  if(cookies.sid){ sessions.delete(cookies.sid); }
  res.setHeader('Set-Cookie','sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok:true });
});
app.get('/api/me', (req,res)=> {
  if(!req.session) return res.json({ username:null, role:'guest' });
  res.json({ username:req.session.username, role:req.session.role });
});

// List transactions (JSON)
app.get('/api/transactions', async (req, res) => {
  try {
    const rows = await allAsync('SELECT id,type,name,date,amount,created_by,updated_by FROM transactions ORDER BY date DESC, id DESC');
    // Map to camelCase for client
    const mapped = rows.map(r=> ({ id: r.id, type: r.type, name: r.name, date: r.date, amount: r.amount, createdBy: r.created_by || null, updatedBy: r.updated_by || null }));
    res.json({ transactions: mapped });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// Bulk replace (idempotent save from client state)
app.post('/api/transactions', requireEditor, async (req, res) => {
  const { transactions } = req.body;
  if (!Array.isArray(transactions)) return res.status(400).json({ error: 'Invalid payload' });
  try {
    const allowEmpty = process.env.ALLOW_EMPTY_SAVE === '1';
    const existing = await allAsync('SELECT COUNT(*) as c FROM transactions');
    if(!allowEmpty && transactions.length === 0 && existing[0].c > 0){
      return res.status(400).json({ error: 'Refusing empty save that would delete existing data (set ALLOW_EMPTY_SAVE=1 to override).' });
    }
    if(usePg){
      await pool.query('BEGIN');
      await pool.query('DELETE FROM transactions');
      for(const t of transactions){
        const amt = typeof t.amount === 'string' ? parseFloat(t.amount.replace(/[^0-9.+-]/g,'')) : t.amount;
        if (!t.type || !t.name || !t.date || typeof amt !== 'number' || isNaN(amt)) continue;
        // Use upsert-ignore to avoid inserting duplicates; include author metadata when provided
  await pool.query('INSERT INTO transactions (type,name,date,amount,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (type,name,date,amount) DO NOTHING', [t.type, t.name, t.date, amt, t.createdBy||t.created_by||null, t.updatedBy||t.updated_by||null]);
      }
      await pool.query('COMMIT');
    } else {
      await execAsync('BEGIN');
      await execAsync('DELETE FROM transactions');
      for (const t of transactions) {
        const amt = typeof t.amount === 'string' ? parseFloat(t.amount.replace(/[^0-9.+-]/g,'')) : t.amount;
        if (!t.type || !t.name || !t.date || typeof amt !== 'number' || isNaN(amt)) continue;
        // Insert-or-ignore to avoid duplicates; include author metadata where supported
        await runAsync('INSERT OR IGNORE INTO transactions (type, name, date, amount, created_by, updated_by) VALUES (?,?,?,?,?,?)', [t.type, t.name, t.date, amt, t.createdBy||t.created_by||null, t.updatedBy||t.updated_by||null]);
      }
      await execAsync('COMMIT');
    }
    regenerateDualCsv();
    res.json({ status: 'ok' });
  } catch (e) {
    // Enhanced error logging for debugging: include request/session/transactions summary
    try {
      const txCount = Array.isArray(transactions) ? transactions.length : 0;
      const sample = (Array.isArray(transactions) && transactions.length) ? transactions.slice(0,5).map(t=> ({ type: t.type, name: t.name, date: t.date, amount: t.amount })) : [];
      console.error('[POST /api/transactions] Save failed:', e && e.stack ? e.stack : e);
      console.error('[POST /api/transactions] Context:', {
        session: req.session || null,
        txCount,
        sample
      });
    } catch(logErr){ console.error('Failed to log save context', logErr); }
    if(usePg){ try { await pool.query('ROLLBACK'); } catch(_){} } else { await execAsync('ROLLBACK').catch(()=>{}); }
    // Persist failing payload for offline debugging (avoid leaking secrets)
    try {
      const dumpDir = path.join(__dirname, 'save-failures');
      try { fs.mkdirSync(dumpDir, { recursive: true }); } catch(_){}
      const stamp = new Date().toISOString().replace(/[:.]/g,'-');
      const out = {
        timestamp: new Date().toISOString(),
        session: req.session || null,
        txCount: Array.isArray(transactions) ? transactions.length : 0,
        sample: (Array.isArray(transactions) && transactions.length) ? transactions.slice(0,20) : []
      };
      try { fs.writeFileSync(path.join(dumpDir, `failed-save-${stamp}.json`), JSON.stringify(out, null, 2), 'utf8'); } catch(writeErr){ console.error('Failed to write save-failure dump', writeErr); }
    } catch(_){}
    const details = (e && e.stack) ? String(e.stack).slice(0,2000) : ((e && e.message) ? e.message : String(e));
    res.status(500).json({ error: 'Failed to save transactions', details });
  }
});

// Optional export as CSV for download/backups
app.get('/api/transactions.csv', async (req, res) => {
  try {
    const rows = await allAsync('SELECT id,type,name,date,amount,created_by,updated_by FROM transactions ORDER BY date ASC, id ASC');
    let csv = 'type,name,date,amount,created_by,updated_by\n';
    for (const r of rows) csv += `${r.type},${(r.name||'').replace(/,/g,' ')},${r.date},${r.amount},${r.created_by||''},${r.updated_by||''}\n`;
    res.type('text/csv').send(csv);
  } catch (e) {
    res.status(500).json({ error: 'Failed to export CSV' });
  }
});

const port = process.env.PORT || 3000;
// Simple debug endpoint (optional) to inspect DB status (no auth to simplify diagnostics; add password if needed)
app.get('/api/debug/db-info', async (req,res)=> {
  try {
    const rows = await allAsync('SELECT COUNT(*) as count FROM transactions');
    let stats = null;
    if(!usePg){ try { stats = fs.statSync(dbFile); } catch(e){ } }
    res.json({
      driver: usePg ? 'postgres' : 'sqlite',
      dbFile: usePg ? null : dbFile,
      rowCount: rows[0].count,
      fileSizeBytes: stats? stats.size : null,
      mtime: stats? stats.mtime : null
    });
  } catch(e){
    res.status(500).json({ error:'Failed to read db info' });
  }
});

async function logDbStatus(){
  try {
    const rows = await allAsync('SELECT COUNT(*) as count FROM transactions');
    if(usePg){
      console.log(`[Postgres] Rows: ${rows[0].count}`);
    } else {
      let stats = null; try { stats = fs.statSync(dbFile); } catch(e){}
      console.log(`[SQLite] Rows: ${rows[0].count} | File: ${dbFile} ${stats? '('+stats.size+' bytes)':''}`);
    }
  } catch(e){
    console.warn('Could not log DB status:', e.message);
  }
}

initDb()
  .then(() => logDbStatus())
  .then(async () => {
    if(!usePg && process.env.DB_BACKUPS === '1'){
      const backupDir = path.join(path.dirname(dbFile), 'backups');
      try { fs.mkdirSync(backupDir, { recursive: true }); } catch(e) {}

      const doBackup = async () => {
        try {
          // Ensure uniqueness to avoid accidental duplicate inserts from client races
          try {
            await runAsync(`CREATE UNIQUE INDEX IF NOT EXISTS transactions_unique_idx ON transactions(type,name,date,amount)`);
          } catch (ixErr) {
            console.warn('[DB] Unique index creation failed, attempting to deduplicate existing rows:', ixErr.message);
            // Remove duplicate rows, keeping the smallest id for each group
            try {
              await runAsync(`DELETE FROM transactions WHERE id NOT IN (SELECT MIN(id) FROM transactions GROUP BY type,name,date,amount)`);
              console.log('[DB] Deduplication complete, retrying index creation');
              await runAsync(`CREATE UNIQUE INDEX IF NOT EXISTS transactions_unique_idx ON transactions(type,name,date,amount)`);
            } catch (dedupeErr) {
              console.error('[DB] Deduplication or index recreation failed:', dedupeErr.message);
            }
          }
          const stamp = new Date().toISOString().replace(/[:.]/g,'-');
          const target = path.join(backupDir, `data-${stamp}.db`);
          fs.copyFileSync(dbFile, target);
          const files = fs.readdirSync(backupDir).filter(f=>f.endsWith('.db')).sort();
          if(files.length > 20){
            for(const f of files.slice(0, files.length-20)){
              try { fs.unlinkSync(path.join(backupDir,f)); } catch(e){}
            }
          }
        } catch(e){ console.warn('Backup failed:', e.message); }
      };

      await doBackup();
      setInterval(() => { doBackup().catch(e=>console.warn('Scheduled backup failed:', e.message)); }, 6 * 60 * 60 * 1000);
      // Add unique index for dedupe; if it fails due to duplicates, remove duplicates and retry
      try {
        await execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS transactions_unique_idx ON transactions(type,name,date,amount);`);
      } catch(ixErr){
        console.warn('[SQLite] Unique index creation failed, attempting dedupe:', ixErr.message);
        try { await execAsync(`DELETE FROM transactions WHERE rowid NOT IN (SELECT MIN(rowid) FROM transactions GROUP BY type,name,date,amount);`); } catch(e){}
        try { await execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS transactions_unique_idx ON transactions(type,name,date,amount);`); } catch(e) { console.error('[SQLite] Failed to create unique index after dedupe', e.message); }
      }
      // Add author columns for SQLite (ALTER TABLE ADD COLUMN is safe; ignore errors)
      try { await execAsync(`ALTER TABLE transactions ADD COLUMN created_by TEXT;`); } catch(e){}
      try { await execAsync(`ALTER TABLE transactions ADD COLUMN updated_by TEXT;`); } catch(e){}
    }
    if(!usePg && process.env.NODE_ENV === 'production'){
      console.warn('[WARNING] Running with SQLite in production; on ephemeral hosts data WILL reset. Set DATABASE_URL for Postgres.');
    }
  })
  .then(() => {
    app.listen(port, () => console.log(`Server running on http://localhost:${port} (driver: ${usePg ? 'postgres':'sqlite'})`));
  })
  .catch(err => { console.error('Startup failed', err); process.exit(1); });

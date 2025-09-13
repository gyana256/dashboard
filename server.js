import express from 'express';
import path from 'path';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import fs from 'fs';
import { fileURLToPath } from 'url';
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
  } else {
    await execAsync(`CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('income','expenditure')),
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL
    );`);
  }
}

// Regenerate combined dual-column CSV after data changes
async function regenerateDualCsv(){
  try {
    const rows = await allAsync('SELECT * FROM transactions ORDER BY id ASC');
    const expenditures = rows.filter(r=> r.type==='expenditure');
    const incomes = rows.filter(r=> r.type==='income');
    const max = Math.max(expenditures.length, incomes.length);
    let csv = 'Expenditure,,,,,,,Income,,,,,,,\n';
    csv += 'Name,Date,Amount,Quantity,,Name,Date,Amount,,,,,,,\n';
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
// Simple password middleware (shared secret) for mutating operations
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '8763951777';
function requirePassword(req,res,next){
  const provided = req.headers['x-admin-password'];
  if(provided && provided === ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// Removed /api/import-csv-once endpoint

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// List transactions (JSON)
app.get('/api/transactions', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM transactions ORDER BY date DESC, id DESC');
    res.json({ transactions: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// Bulk replace (idempotent save from client state)
app.post('/api/transactions', requirePassword, async (req, res) => {
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
        if (!t.type || !t.name || !t.date || typeof t.amount !== 'number') continue;
        await pool.query('INSERT INTO transactions (type,name,date,amount) VALUES ($1,$2,$3,$4)', [t.type, t.name, t.date, t.amount]);
      }
      await pool.query('COMMIT');
    } else {
      await execAsync('BEGIN');
      await execAsync('DELETE FROM transactions');
      for (const t of transactions) {
        if (!t.type || !t.name || !t.date || typeof t.amount !== 'number') continue;
        await runAsync('INSERT INTO transactions (type, name, date, amount) VALUES (?,?,?,?)', [t.type, t.name, t.date, t.amount]);
      }
      await execAsync('COMMIT');
    }
    regenerateDualCsv();
    res.json({ status: 'ok' });
  } catch (e) {
    if(usePg){ try { await pool.query('ROLLBACK'); } catch(_){} } else { await execAsync('ROLLBACK').catch(()=>{}); }
    res.status(500).json({ error: 'Failed to save transactions' });
  }
});

// Optional export as CSV for download/backups
app.get('/api/transactions.csv', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM transactions ORDER BY date ASC, id ASC');
    let csv = 'type,name,date,amount\n';
    for (const r of rows) csv += `${r.type},${(r.name||'').replace(/,/g,' ')},${r.date},${r.amount}\n`;
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
  .then(() => {
    if(!usePg && process.env.DB_BACKUPS === '1'){
      const backupDir = path.join(path.dirname(dbFile), 'backups');
      try { fs.mkdirSync(backupDir, { recursive: true }); } catch(e) {}
      const doBackup = () => {
        try {
          if(fs.existsSync(dbFile)){
            const stamp = new Date().toISOString().replace(/[:.]/g,'-');
            const target = path.join(backupDir, `data-${stamp}.db`);
            fs.copyFileSync(dbFile, target);
            const files = fs.readdirSync(backupDir).filter(f=>f.endsWith('.db')).sort();
            if(files.length > 20){
              for(const f of files.slice(0, files.length-20)){
                try { fs.unlinkSync(path.join(backupDir,f)); } catch(e){}
              }
            }
          }
        } catch(e){ console.warn('Backup failed:', e.message); }
      };
      doBackup();
      setInterval(doBackup, 6 * 60 * 60 * 1000);
      console.log('[SQLite] Periodic backups enabled.');
    }
  })
  .then(() => {
    app.listen(port, () => console.log(`Server running on http://localhost:${port} (driver: ${usePg ? 'postgres':'sqlite'})`));
  })
  .catch(err => { console.error('Startup failed', err); process.exit(1); });

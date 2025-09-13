import express from 'express';
import path from 'path';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import fs from 'fs';
import { fileURLToPath } from 'url';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
sqlite3.verbose();
// Allow configurable persistent DB path (use env DB_PATH or default inside project root)
const dbFile = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, 'data.db');
// Ensure directory exists if a nested custom path is provided
try { fs.mkdirSync(path.dirname(dbFile), { recursive: true }); } catch(e) {}
const db = new sqlite3.Database(dbFile, (err)=> {
  if(err) console.error('Failed to open SQLite DB:', err.message);
  else console.log('[SQLite] Using database file:', dbFile);
});
// Set WAL mode for better durability & crash resilience
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;", (e)=>{ if(e) console.warn('PRAGMA set failed', e.message); });

// Promisified helpers
const runAsync = (sql, params=[]) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err){ if(err) reject(err); else resolve(this); });
});
const allAsync = (sql, params=[]) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows)=> { if(err) reject(err); else resolve(rows); });
});
const execAsync = (sql) => new Promise((resolve, reject) => db.exec(sql, err => err? reject(err): resolve()));

async function initDb() {
  await execAsync(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('income','expenditure')),
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    amount REAL NOT NULL
  );`);
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
    await execAsync('BEGIN');
    await execAsync('DELETE FROM transactions');
    for (const t of transactions) {
      if (!t.type || !t.name || !t.date || typeof t.amount !== 'number') continue;
      await runAsync('INSERT INTO transactions (type, name, date, amount) VALUES (?,?,?,?)', [t.type, t.name, t.date, t.amount]);
    }
    await execAsync('COMMIT');
  // Fire and forget CSV regeneration (don't block response on potential fs latency)
  regenerateDualCsv();
  res.json({ status: 'ok' });
  } catch (e) {
    await execAsync('ROLLBACK').catch(()=>{});
    res.status(500).json({ error: 'Failed to save transactions' });
  }
});

// Optional export as CSV for download/backups
app.get('/api/transactions.csv', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM transactions ORDER BY date ASC, id ASC');
    let csv = 'type,name,date,amount\n';
    for (const r of rows) csv += `${r.type},${r.name.replace(/,/g,' ')},${r.date},${r.amount}\n`;
    res.type('text/csv').send(csv);
  } catch (e) {
    res.status(500).json({ error: 'Failed to export CSV' });
  }
});

const port = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(port, () => console.log(`Server with SQLite running on http://localhost:${port}`));
  })
  .catch(err => {
    console.error('Startup failed', err);
    process.exit(1);
  });

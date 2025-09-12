import express from 'express';
import path from 'path';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import fs from 'fs';
import { fileURLToPath } from 'url';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
sqlite3.verbose();
const dbFile = path.join(__dirname, 'data.db');
const db = new sqlite3.Database(dbFile);

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
  await execAsync(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );`);
}

async function importCsvIfEmpty() {
  // Check if table already has data
  const existing = await allAsync('SELECT COUNT(*) as count FROM transactions');
  if (existing[0].count > 0) {
    console.log('Transactions already present, skipping CSV import.');
    return;
  }
  const csvPath = path.join(__dirname, 'updated-financial-data.csv');
  if (!fs.existsSync(csvPath)) {
    console.log('CSV file not found, skipping import.');
    return;
  }
  const raw = fs.readFileSync(csvPath, 'utf8').trim();
  const lines = raw.split(/\r?\n/);
  if (lines.length <= 2) {
    console.log('CSV has no data rows.');
    return;
  }
  // Skip first two header lines
  const dataLines = lines.slice(2);
  let inserted = 0;
  await execAsync('BEGIN');
  try {
    for (const line of dataLines) {
      if (!line.trim()) continue;
      const cols = line.split(',');
      // Expenditure side
      const expName = (cols[0] || '').trim();
      const expDate = (cols[1] || '').trim();
      const expAmountRaw = (cols[2] || '').trim();
      const expAmount = parseFloat(expAmountRaw);
      if (expName && expDate && !isNaN(expAmount)) {
        await runAsync('INSERT INTO transactions (type, name, date, amount) VALUES (?,?,?,?)', ['expenditure', expName, expDate, expAmount]);
        inserted++;
      }
      // Income side (starts after a blank column per provided structure)
      const incName = (cols[5] || '').trim();
      const incDate = (cols[6] || '').trim();
      const incAmountRaw = (cols[7] || '').trim();
      const incAmount = parseFloat(incAmountRaw);
      if (incName && incDate && !isNaN(incAmount)) {
        await runAsync('INSERT INTO transactions (type, name, date, amount) VALUES (?,?,?,?)', ['income', incName, incDate, incAmount]);
        inserted++;
      }
    }
    await execAsync('COMMIT');
    console.log(`Imported ${inserted} transactions from CSV.`);
  } catch (e) {
    await execAsync('ROLLBACK').catch(()=>{});
    console.error('CSV import failed:', e.message);
  }
}

async function hasCsvImportRun(){
  const rows = await allAsync('SELECT value FROM settings WHERE key = ?',[ 'csv_import_done' ]);
  return rows.length > 0;
}

async function markCsvImportRun(){
  await runAsync('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)',[ 'csv_import_done', new Date().toISOString() ]);
}

async function oneTimeCsvImport(force = false){
  if(!force && await hasCsvImportRun()) {
    return { skipped: true, reason: 'CSV import already completed previously.' };
  }
  const csvPath = path.join(__dirname, 'updated-financial-data.csv');
  if (!fs.existsSync(csvPath)) return { skipped: true, reason: 'CSV file not found.' };
  const raw = fs.readFileSync(csvPath,'utf8').trim();
  const lines = raw.split(/\r?\n/);
  if(lines.length <= 2) return { skipped: true, reason: 'CSV has no data rows.' };
  const dataLines = lines.slice(2);
  let inserted = 0;
  await execAsync('BEGIN');
  try {
    // delete all data first as per request
    await execAsync('DELETE FROM transactions');
    for(const line of dataLines){
      if(!line.trim()) continue;
      const cols = line.split(',');
      const expName = (cols[0]||'').trim();
      const expDate = (cols[1]||'').trim();
      const expAmountRaw = (cols[2]||'').trim();
      const expAmount = parseFloat(expAmountRaw);
      if(expName && expDate && !isNaN(expAmount)) {
        await runAsync('INSERT INTO transactions (type,name,date,amount) VALUES (?,?,?,?)',[ 'expenditure', expName, expDate, expAmount ]);
        inserted++;
      }
      const incName = (cols[5]||'').trim();
      const incDate = (cols[6]||'').trim();
      const incAmountRaw = (cols[7]||'').trim();
      const incAmount = parseFloat(incAmountRaw);
      if(incName && incDate && !isNaN(incAmount)) {
        await runAsync('INSERT INTO transactions (type,name,date,amount) VALUES (?,?,?,?)',[ 'income', incName, incDate, incAmount ]);
        inserted++;
      }
    }
    await markCsvImportRun();
    await execAsync('COMMIT');
    return { inserted, skipped:false };
  } catch(e){
    await execAsync('ROLLBACK').catch(()=>{});
    return { skipped:true, reason: 'Import failed: '+e.message };
  }
}

// One-time import endpoint
app.post('/api/import-csv-once', async (req,res) => {
  try {
    const result = await oneTimeCsvImport(false);
    if(result.skipped && result.reason && result.reason.includes('already')) {
      return res.status(409).json(result);
    }
    res.json(result);
  } catch(e){
    res.status(500).json({ error: 'Unexpected error during import' });
  }
});

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
app.post('/api/transactions', async (req, res) => {
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
  .then(importCsvIfEmpty)
  .then(() => {
    app.listen(port, () => console.log(`Server with SQLite running on http://localhost:${port}`));
  })
  .catch(err => {
    console.error('Startup failed', err);
    process.exit(1);
  });

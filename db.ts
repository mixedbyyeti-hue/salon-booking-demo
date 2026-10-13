import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
mkdirSync(import.meta.dir + "/data", { recursive: true });
export const db = new Database(process.env.DB_PATH || import.meta.dir + "/data/salon.db");
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
db.exec(`
CREATE TABLE IF NOT EXISTS clients(id INTEGER PRIMARY KEY, name TEXT, phone TEXT UNIQUE, email TEXT, notes TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS appointments(id INTEGER PRIMARY KEY, client_id INTEGER REFERENCES clients(id), service_id TEXT, service_name TEXT, price REAL,
  start TEXT NOT NULL, end TEXT NOT NULL, status TEXT DEFAULT 'booked', client_notes TEXT DEFAULT '', stylist_notes TEXT DEFAULT '',
  confirmation_sent INTEGER DEFAULT 0, reminder_sent INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_appt_start ON appointments(start);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, client_id INTEGER, direction TEXT, phone TEXT, body TEXT, status TEXT, provider_sid TEXT,
  kind TEXT DEFAULT 'manual', draft_reply TEXT, draft_rule TEXT, handled INTEGER DEFAULT 0, error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS visits(id INTEGER PRIMARY KEY, client_id INTEGER, appointment_id INTEGER UNIQUE, date TEXT, service_name TEXT, price REAL, notes TEXT DEFAULT '');
`);

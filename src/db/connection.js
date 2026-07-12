import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'karmaquest.sqlite');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

export const DB_FILE_EXISTS_ON_BOOT = fs.existsSync(DB_PATH);

export function tableIsEmpty(table) {
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
  return row.count === 0;
}

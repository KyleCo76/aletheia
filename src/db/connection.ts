import Database from 'better-sqlite3';
import { DB_PATH } from '../lib/constants.js';

export function createConnection(dbPath: string = DB_PATH): Database.Database {
  const db = new Database(dbPath, { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -20000');
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('foreign_keys = ON');
  return db;
}

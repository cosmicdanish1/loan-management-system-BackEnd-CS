import * as fs from 'fs';
import * as path from 'path';

/**
 * Backend database targeting config.
 *
 * The connection can be pointed at any PostgreSQL database WITHOUT touching
 * code or the .env secrets — just edit `db-config.json` next to the running
 * backend (on the server that's `C:\FibeServer\backend\db-config.json`).
 *
 * This mirrors the frontend's `server-config.json`: one obvious file the
 * technician edits to say "which database". Secrets that aren't about
 * targeting (JWT etc.) stay in `.env`.
 *
 * Resolution order for each field:
 *   1. db-config.json  (authoritative — this is the "which DB" switch)
 *   2. environment variable (DB_HOST, DB_PORT, ...) — dev / fallback
 *   3. built-in default
 */
export interface DbConnectionConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  logging: boolean;
  /**
   * TLS to PostgreSQL. Defaults to FALSE because this product ships to LAN
   * servers where Postgres runs without SSL — the default Windows installer
   * has ssl=off in postgresql.conf, and forcing SSL there fails the whole boot
   * with "The server does not support SSL connections".
   * Set `"ssl": true` in db-config.json only for a managed/cloud database.
   */
  ssl: boolean;
}

/** Shape of db-config.json (all fields optional; missing ones fall back to env). */
interface DbConfigFile {
  host?: string;
  port?: number | string;
  username?: string;
  password?: string;
  database?: string;
  logging?: boolean;
  ssl?: boolean;
}

/**
 * Locate db-config.json. Priority:
 *   1. DB_CONFIG_PATH env var (explicit override — handy for tests / custom layouts)
 *   2. <cwd>/db-config.json          — service AppDirectory / backend root
 *   3. <compiled>/../../db-config.json — packaged app (dist/config → backend root)
 */
function resolveConfigPath(): string | null {
  const candidates = [
    process.env.DB_CONFIG_PATH,
    path.resolve(process.cwd(), 'db-config.json'),
    path.resolve(__dirname, '..', '..', 'db-config.json'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore unreadable candidate */
    }
  }
  return null;
}

// Read once and cache — the file is small and only changes on a service restart.
let cached: DbConfigFile | null | undefined;

function readFileConfig(): DbConfigFile {
  if (cached !== undefined) return cached ?? {};

  const filePath = resolveConfigPath();
  if (!filePath) {
    cached = null;
    return {};
  }

  try {
    // Strip a UTF-8 BOM before parsing. Notepad, PowerShell's Set-Content and
    // several Windows editors add one when a technician edits this file, and
    // JSON.parse rejects it with an opaque "Unexpected token" error. Without
    // this we silently fall back to env vars — and the installer's .env has no
    // DB_* fields, so the connection quietly reverts to the default password
    // and fails with "password authentication failed", pointing at the wrong
    // problem entirely.
    const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text) as DbConfigFile;
    cached = raw;
    console.log(
      `[DB] Target loaded from db-config.json (${filePath}) → database="${raw.database ?? '(from .env)'}", host="${raw.host ?? '(from .env)'}"`,
    );
    return cached;
  } catch (err) {
    // Bad JSON must not crash boot — fall back to env vars and warn loudly.
    console.error(
      `[DB] Could not parse db-config.json at ${filePath}: ${(err as Error).message}. Falling back to environment variables.`,
    );
    cached = null;
    return {};
  }
}

/** Merge file → env → default and return the effective DB connection settings. */
export function loadDbConfig(): DbConnectionConfig {
  const file = readFileConfig();
  const env = process.env;

  const filePort =
    file.port !== undefined && file.port !== null && `${file.port}`.trim() !== ''
      ? parseInt(`${file.port}`, 10)
      : undefined;

  return {
    host: file.host ?? env.DB_HOST ?? 'localhost',
    port: filePort ?? (env.DB_PORT ? parseInt(env.DB_PORT, 10) : 5432),
    username: file.username ?? env.DB_USERNAME ?? 'postgres',
    password: file.password ?? env.DB_PASSWORD ?? 'postgres',
    database: file.database ?? env.DB_DATABASE ?? 'loan_management_db',
    logging: file.logging ?? env.DB_LOGGING === 'true',
    // Off unless explicitly opted in. Previously this was derived from
    // NODE_ENV === 'production', which broke every LAN install: the service
    // runs with NODE_ENV=production, so SSL was forced on against a Postgres
    // that has it disabled, and the backend never finished booting.
    ssl: file.ssl ?? env.DB_SSL === 'true',
  };
}

/** Test hook — forget the cached file so the next load re-reads from disk. */
export function resetDbConfigCache(): void {
  cached = undefined;
}

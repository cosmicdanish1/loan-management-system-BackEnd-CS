import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';

interface LogFileInfo {
  path: string;
  size: number;
  mtimeMs: number;
  /** Only .gz (already-rotated, closed) files are ever eligible for deletion —
   *  today's active .log file is still being appended to by winston, so
   *  touching it here would corrupt an in-progress write. */
  deletable: boolean;
}

const DATE_IN_FILENAME = /(\d{4})-(\d{2})-(\d{2})/;

/**
 * Runs hourly, two jobs in one sweep:
 *
 * 1. Organize — every rotated .gz file (top-level: combined/error/audit/etc,
 *    and per-domain: services/auth-*.log.gz, services/loan-*.log.gz, ...)
 *    gets moved into logs/DD-MM-YYYY/ based on the date already in its
 *    filename, so one day's worth of every log type lives in one folder.
 *    Not event-driven off winston's rotate hook (that would mean wiring ~19
 *    separate transport instances) — a file just sits flat for at most an
 *    hour after rotating before this sweep files it away. Today's still-open
 *    .log file is never touched, only already-closed .gz files.
 *
 * 2. Retention — once a .gz file's age exceeds LOG_MAX_AGE_DAYS, delete it.
 *    That's the only deletion rule; a file always gets its full lifetime
 *    regardless of how large logs/ has grown overall. Empty day-folders left
 *    behind after their last file ages out get cleaned up too.
 */
@Injectable()
export class LogRetentionService {
  private readonly logger = new Logger('LogRetention');
  private readonly logDir: string;
  private readonly maxAgeMs: number;

  constructor(private readonly configService: ConfigService) {
    this.logDir = this.configService.get('LOG_FILE_PATH', './logs');
    const maxAgeDays = parseInt(this.configService.get('LOG_MAX_AGE_DAYS', '60'), 10);
    this.maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  }

  @Cron('7 * * * *') // hourly
  async enforceRetention(): Promise<void> {
    const movedCount = this.organizeIntoDailyFolders();
    if (movedCount > 0) {
      this.logger.log(`Organized ${movedCount} rotated log file(s) into their DD-MM-YYYY folder.`);
    }

    const files = this.listLogFiles(this.logDir);
    if (files.length === 0) return;

    const now = Date.now();
    let deletedCount = 0;
    let freedBytes = 0;
    const touchedDirs = new Set<string>();

    for (const f of files) {
      if (f.deletable && now - f.mtimeMs > this.maxAgeMs) {
        if (this.deleteFile(f)) {
          freedBytes += f.size;
          deletedCount++;
          touchedDirs.add(path.dirname(f.path));
        }
      }
    }

    for (const dir of touchedDirs) {
      this.removeIfEmpty(dir);
    }

    if (deletedCount > 0) {
      this.logger.log(
        `Retention sweep: deleted ${deletedCount} rotated log file(s) older than ${this.maxAgeMs / 86400000} days, ` +
          `freed ${(freedBytes / 1024 ** 2).toFixed(1)}MB.`,
      );
    }
  }

  /** Moves any loose .gz sitting directly in logs/ or logs/services/ into
   *  logs/DD-MM-YYYY/, based on the YYYY-MM-DD winston already put in the
   *  filename. Returns how many files it moved. */
  private organizeIntoDailyFolders(): number {
    const sourceDirs = [this.logDir, path.join(this.logDir, 'services')];
    let moved = 0;

    for (const dir of sourceDirs) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.gz')) continue;

        const match = e.name.match(DATE_IN_FILENAME);
        if (!match) continue;
        const [, year, month, day] = match;

        const destDir = path.join(this.logDir, `${day}-${month}-${year}`);
        const src = path.join(dir, e.name);
        const dest = path.join(destDir, e.name);
        if (fs.existsSync(dest)) continue;

        try {
          fs.mkdirSync(destDir, { recursive: true });
          fs.renameSync(src, dest);
          moved++;
        } catch (err) {
          this.logger.error(`Failed to move ${src} -> ${dest}: ${(err as Error).message}`);
        }
      }
    }

    return moved;
  }

  private listLogFiles(dir: string): LogFileInfo[] {
    const results: LogFileInfo[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        results.push(...this.listLogFiles(full));
        continue;
      }
      try {
        const stat = fs.statSync(full);
        results.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs, deletable: e.name.endsWith('.gz') });
      } catch {
        /* file disappeared between readdir and stat (e.g. mid-rotation), skip */
      }
    }
    return results;
  }

  private deleteFile(f: LogFileInfo): boolean {
    try {
      fs.unlinkSync(f.path);
      return true;
    } catch (err) {
      this.logger.error(`Failed to delete ${f.path}: ${(err as Error).message}`);
      return false;
    }
  }

  private removeIfEmpty(dir: string): void {
    if (path.resolve(dir) === path.resolve(this.logDir)) return; // never remove logs/ itself
    try {
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {
      /* not empty, in use, or already gone — fine either way */
    }
  }
}

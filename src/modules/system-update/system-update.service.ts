import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BACKEND_VERSION, isDayEndInProgress } from '../../app.service';
import { RemoteConfig, RemoteRelease, RemoteReleaseClient } from './remote-release.client';

const TASK_NAME = 'FibeUpdateRun';
const STALE_RUNNING_MS = 30 * 60 * 1000;

// Where the backend is installed (the service's working directory) and where uploads wait.
export const INSTALL_DIR = process.env.FIBE_INSTALL_DIR || process.cwd();
export const INCOMING_DIR = join(INSTALL_DIR, '_update', 'incoming');
const PENDING_FILE = join(INSTALL_DIR, '_update', 'pending.json');
const STATUS_FILE = join(INSTALL_DIR, 'update-status.json');

export interface PendingRelease {
  file: string;
  size: number;
  sha256: string;
  manifest: { version: string; nodeMajor?: number; migrations?: string[] };
  uploadedBy: string | null;
  uploadedAt: string;
}

export interface DownloadJob {
  state: 'idle' | 'downloading' | 'done' | 'failed';
  version?: string;
  received: number;
  total: number;
  error?: string;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// The tar that ships with Windows reads .zip files; a GNU tar earlier on PATH (e.g. from Git) does not.
function tarExe(): string {
  const win = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return existsSync(win) ? win : 'tar';
}

@Injectable()
export class SystemUpdateService {
  private readonly logger = new Logger(SystemUpdateService.name);

  readonly serviceName = process.env.FIBE_SERVICE_NAME || 'FibeBackend';

  private job: DownloadJob = { state: 'idle', received: 0, total: 0 };

  constructor(private readonly dataSource: DataSource) {}

  ensureIncomingDir() {
    mkdirSync(INCOMING_DIR, { recursive: true });
  }

  // ---- "Check for updates" (server pulls the release itself) ----
  // UPDATE_REPO_TOKEN is a read-only token limited to the private releases repo. It lives in the
  // server .env next to the database password and is never returned by any endpoint.
  private remoteConfig(): RemoteConfig | null {
    const token = process.env.UPDATE_REPO_TOKEN;
    if (!token) return null;
    return {
      token,
      repo: process.env.UPDATE_REPO || 'cosmicdanish1/fibe-backend-releases',
      apiBase: process.env.UPDATE_API_BASE,
    };
  }

  remoteConfigured(): boolean {
    return this.remoteConfig() !== null;
  }

  private remoteClient(): RemoteReleaseClient {
    const cfg = this.remoteConfig();
    if (!cfg) {
      throw new BadRequestException('No update token is set on this server. Add UPDATE_REPO_TOKEN to the server settings, or upload a release zip instead.');
    }
    return new RemoteReleaseClient(cfg);
  }

  async checkRemote() {
    let latest: RemoteRelease | null;
    try {
      latest = await this.remoteClient().latest();
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(e?.message ?? 'Could not reach GitHub. Check the internet connection of this server.');
    }
    return {
      installed: BACKEND_VERSION,
      latest,
      updateAvailable: !!latest && compareVersions(latest.version, BACKEND_VERSION) > 0,
    };
  }

  getDownloadProgress(): DownloadJob {
    return this.job;
  }

  // Starts the download in the background (the zip is large) and returns at once; the screen polls
  // getDownloadProgress(). On success the file goes through the same stage() checks as an upload.
  async startRemoteDownload(requestedBy: string): Promise<DownloadJob> {
    if (this.job.state === 'downloading') throw new ConflictException('A download is already running.');
    const { latest, updateAvailable } = await this.checkRemote();
    if (!latest || !updateAvailable) throw new BadRequestException('This server is already up to date.');

    const client = this.remoteClient();
    this.ensureIncomingDir();
    const dest = join(INCOMING_DIR, `release-${Date.now()}.zip`);
    this.job = { state: 'downloading', version: latest.version, received: 0, total: latest.zipSize };

    void (async () => {
      try {
        await client.download(latest, dest, (received, total) => {
          this.job = { ...this.job, received, total: total || this.job.total };
        });
        await this.stage(dest, `${requestedBy} (downloaded from GitHub)`);
        this.job = { ...this.job, state: 'done' };
      } catch (e: any) {
        this.logger.error(`Release download failed: ${e?.message ?? e}`);
        this.job = { ...this.job, state: 'failed', error: e?.message ?? String(e) };
      }
    })();

    return this.job;
  }

  // Self-update only makes sense on an installed Windows server (service + bundled files).
  // On a developer machine this stays off so nobody swaps their working copy by accident.
  canSelfUpdate(): { ok: boolean; reason?: string } {
    if (process.platform !== 'win32') return { ok: false, reason: 'Self-update is only supported on Windows servers.' };
    if (process.env.NODE_ENV !== 'production') return { ok: false, reason: 'Server is not running in production mode (development machine).' };
    if (!existsSync(join(INSTALL_DIR, 'dist', 'main.js'))) return { ok: false, reason: `No installed backend found in ${INSTALL_DIR}.` };
    const svc = spawnSync('sc', ['query', this.serviceName], { windowsHide: true });
    if (svc.status !== 0) return { ok: false, reason: `Windows service "${this.serviceName}" was not found.` };
    return { ok: true };
  }

  private readJson<T>(file: string): T | null {
    try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; }
  }

  getStatus() {
    const can = this.canSelfUpdate();
    const pgDump = spawnSync(process.env.PG_DUMP_PATH || 'pg_dump', ['--version'], { windowsHide: true });
    return {
      currentVersion: BACKEND_VERSION,
      nodeVersion: process.version,
      installDir: INSTALL_DIR,
      serviceName: this.serviceName,
      canSelfUpdate: can.ok,
      reason: can.reason ?? null,
      pgDumpFound: pgDump.status === 0,
      remoteConfigured: this.remoteConfigured(),
      pending: this.readJson<PendingRelease>(PENDING_FILE),
      lastUpdate: this.readJson<Record<string, unknown>>(STATUS_FILE),
    };
  }

  private sha256(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
  }

  private readManifest(zip: string): PendingRelease['manifest'] {
    // bsdtar may store the entry with or without a leading "./"
    for (const name of ['release-manifest.json', './release-manifest.json']) {
      const r = spawnSync(tarExe(), ['-xOf', zip, name], { windowsHide: true, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
      if (r.status === 0 && r.stdout) {
        try { return JSON.parse(r.stdout); } catch { /* try next */ }
      }
    }
    throw new BadRequestException('This file is not a Fibe backend release (release-manifest.json not found).');
  }

  // Called after the zip has been saved to disk. Nothing on the server changes here.
  async stage(zipPath: string, uploadedBy: string | null): Promise<PendingRelease> {
    try {
      const manifest = this.readManifest(zipPath);
      if (!manifest.version) throw new BadRequestException('Release manifest has no version.');
      if (compareVersions(manifest.version, BACKEND_VERSION) <= 0) {
        throw new BadRequestException(`Release ${manifest.version} is not newer than the installed ${BACKEND_VERSION}.`);
      }
      const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
      if (manifest.nodeMajor && manifest.nodeMajor !== nodeMajor) {
        throw new BadRequestException(`This release was built for Node ${manifest.nodeMajor}; this server runs Node ${nodeMajor}.`);
      }
      const pending: PendingRelease = {
        file: zipPath,
        size: statSync(zipPath).size,
        sha256: await this.sha256(zipPath),
        manifest,
        uploadedBy,
        uploadedAt: new Date().toISOString(),
      };
      mkdirSync(join(INSTALL_DIR, '_update'), { recursive: true });
      writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));
      this.removeOtherIncoming(zipPath);
      this.logger.log(`Release ${manifest.version} staged by ${uploadedBy ?? 'unknown'} (sha256 ${pending.sha256})`);
      return pending;
    } catch (e) {
      rmSync(zipPath, { force: true });
      throw e;
    }
  }

  private removeOtherIncoming(keep: string) {
    if (!existsSync(INCOMING_DIR)) return;
    for (const f of readdirSync(INCOMING_DIR)) {
      const full = join(INCOMING_DIR, f);
      if (full !== keep) rmSync(full, { force: true });
    }
  }

  discardPending() {
    const p = this.readJson<PendingRelease>(PENDING_FILE);
    if (p) rmSync(p.file, { force: true });
    rmSync(PENDING_FILE, { force: true });
    return { discarded: !!p };
  }

  // Starts the updater as a one-off scheduled task. A child process would die when the service
  // is stopped (nssm kills the process tree); a scheduled task is not part of that tree.
  async apply(requestedBy: string) {
    const can = this.canSelfUpdate();
    if (!can.ok) throw new BadRequestException(can.reason);

    const pending = this.readJson<PendingRelease>(PENDING_FILE);
    if (!pending || !existsSync(pending.file)) throw new BadRequestException('No release is waiting. Upload a release zip first.');

    const last = this.readJson<{ state?: string; startedAt?: string }>(STATUS_FILE);
    if (last?.state === 'running' && last.startedAt && Date.now() - Date.parse(last.startedAt) < STALE_RUNNING_MS) {
      throw new ConflictException('An update is already running.');
    }
    if (await isDayEndInProgress(this.dataSource)) {
      throw new BadRequestException('Day-end is running. Apply the update once it has finished.');
    }

    // Run a COPY of the updater from outside the folders it is about to replace.
    const runnerDir = join(INSTALL_DIR, '_update', 'runner');
    mkdirSync(runnerDir, { recursive: true });
    for (const f of ['apply-update.js', 'env-file.js']) {
      copyFileSync(join(INSTALL_DIR, 'scripts', 'update', f), join(runnerDir, f));
    }
    const jobFile = join(INSTALL_DIR, '_update', 'job.json');
    writeFileSync(jobFile, JSON.stringify({
      zip: pending.file,
      install: INSTALL_DIR,
      service: this.serviceName,
      port: parseInt(process.env.PORT || '3001', 10),
      requestedBy,
    }));
    writeFileSync(STATUS_FILE, JSON.stringify({
      state: 'running', step: 'queued', startedAt: new Date().toISOString(), requestedBy, from: BACKEND_VERSION, to: pending.manifest.version,
    }, null, 2));

    const command = `"${process.execPath}" "${join(runnerDir, 'apply-update.js')}" "${jobFile}"`;
    const create = spawnSync('schtasks', ['/Create', '/TN', TASK_NAME, '/SC', 'ONCE', '/ST', '23:59', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F', '/TR', command], { windowsHide: true, encoding: 'utf8' });
    if (create.status !== 0) throw new BadRequestException(`Could not schedule the updater: ${(create.stdout + create.stderr).trim()}`);
    const start = spawnSync('schtasks', ['/Run', '/TN', TASK_NAME], { windowsHide: true, encoding: 'utf8' });
    if (start.status !== 0) throw new BadRequestException(`Could not start the updater: ${(start.stdout + start.stderr).trim()}`);

    this.logger.warn(`Server update to ${pending.manifest.version} started by ${requestedBy}. The service will restart.`);
    return { started: true, from: BACKEND_VERSION, to: pending.manifest.version };
  }
}

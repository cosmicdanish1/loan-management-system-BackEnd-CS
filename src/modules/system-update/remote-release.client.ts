import { createHash } from 'crypto';
import { createWriteStream, rmSync } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export interface RemoteRelease {
  version: string;
  tag: string;
  notes: string;
  publishedAt: string | null;
  zipName: string;
  zipSize: number;
  zipAssetId: number;
  sha256AssetId: number | null;
}

export interface RemoteConfig {
  repo: string; // "owner/name" of the private releases repo
  token: string; // fine-grained, read-only, limited to that repo
  apiBase?: string; // overridden in tests
  stallTimeoutMs?: number; // abort a download that receives no data for this long
}

const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_STALL_TIMEOUT_MS = 60_000;

// Talks to the private backend-releases repo on GitHub. Only PUBLISHED releases are visible to a
// read-only token (drafts are not), so a build reaches servers only after someone clicks Publish.
export class RemoteReleaseClient {
  private readonly apiBase: string;

  constructor(private readonly cfg: RemoteConfig) {
    this.apiBase = (cfg.apiBase || 'https://api.github.com').replace(/\/$/, '');
  }

  private headers(accept: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'fibe-backend-updater',
    };
  }

  async latest(): Promise<RemoteRelease | null> {
    const res = await fetch(`${this.apiBase}/repos/${this.cfg.repo}/releases/latest`, {
      headers: this.headers('application/vnd.github+json'),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return null; // no published release yet (or the token cannot see the repo)
    if (res.status === 401 || res.status === 403) {
      throw new Error('GitHub refused the update token. It may be wrong, expired or not allowed to read the releases repo.');
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status} while looking for updates.`);

    const body: any = await res.json();
    const assets: any[] = body.assets ?? [];
    const zip = assets.find((a) => /^fibe-backend-.+\.zip$/.test(a.name));
    if (!zip) return null;
    const sha = assets.find((a) => a.name === `${zip.name}.sha256`);
    const version = String(body.tag_name ?? '').replace(/^v/, '');
    if (!version) return null;

    return {
      version,
      tag: body.tag_name,
      notes: body.body ?? '',
      publishedAt: body.published_at ?? null,
      zipName: zip.name,
      zipSize: zip.size ?? 0,
      zipAssetId: zip.id,
      sha256AssetId: sha ? sha.id : null,
    };
  }

  // Streams the zip to disk while hashing it, then checks the hash against the published .sha256.
  // The file is deleted if anything is wrong, so a bad download can never be applied.
  async download(
    release: RemoteRelease,
    destFile: string,
    onProgress: (received: number, total: number) => void,
  ): Promise<string> {
    const stallMs = this.cfg.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    const abort = new AbortController();
    let stallTimer: NodeJS.Timeout | undefined;
    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => abort.abort(), stallMs);
    };
    try {
      armStallTimer();
      const res = await fetch(`${this.apiBase}/repos/${this.cfg.repo}/releases/assets/${release.zipAssetId}`, {
        headers: this.headers('application/octet-stream'),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Download failed (GitHub answered ${res.status}).`);

      const total = Number(res.headers.get('content-length')) || release.zipSize || 0;
      const hash = createHash('sha256');
      let received = 0;

      const source = Readable.fromWeb(res.body as any);
      source.on('data', (chunk: Buffer) => {
        armStallTimer();
        hash.update(chunk);
        received += chunk.length;
        onProgress(received, total);
      });
      await pipeline(source, createWriteStream(destFile));

      const sha256 = hash.digest('hex');
      if (total && received !== total) throw new Error('Download was cut short. Try again.');

      const expected = await this.expectedChecksum(release);
      if (expected && expected !== sha256) {
        throw new Error('The downloaded file does not match its published checksum. It was discarded.');
      }
      if (!expected) throw new Error('This release has no .sha256 file, so the download cannot be verified.');
      return sha256;
    } catch (e: any) {
      rmSync(destFile, { force: true });
      if (abort.signal.aborted) throw new Error('The download stalled (no data received). Check the internet connection and try again.');
      throw e;
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
  }

  private async expectedChecksum(release: RemoteRelease): Promise<string | null> {
    if (release.sha256AssetId == null) return null;
    const res = await fetch(`${this.apiBase}/repos/${this.cfg.repo}/releases/assets/${release.sha256AssetId}`, {
      headers: this.headers('application/octet-stream'),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    // "<hash>  <filename>"
    const first = (await res.text()).trim().split(/\s+/)[0]?.toLowerCase();
    return first && /^[0-9a-f]{64}$/.test(first) ? first : null;
  }
}

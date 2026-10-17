import { createServer, Server } from 'http';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AddressInfo } from 'net';
import { RemoteReleaseClient } from '../../src/modules/system-update/remote-release.client';

// A tiny stand-in for the GitHub releases API, so the real client code runs end to end.
const TOKEN = 'test-token';
const ZIP = Buffer.from('pretend this is a big zip file '.repeat(2000));
const ZIP_SHA = createHash('sha256').update(ZIP).digest('hex');

let server: Server;
let base: string;
let tmp: string;
let mode: 'ok' | 'bad-sha' | 'no-sha' | 'none' | 'denied' | 'short';

beforeAll(async () => {
  server = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (mode === 'denied' || auth !== `Bearer ${TOKEN}`) { res.writeHead(403); return res.end(); }
    const url = req.url ?? '';
    if (url.endsWith('/releases/latest')) {
      if (mode === 'none') { res.writeHead(404); return res.end(); }
      const assets: any[] = [{ id: 11, name: 'fibe-backend-1.9.0.zip', size: ZIP.length }];
      if (mode !== 'no-sha') assets.push({ id: 12, name: 'fibe-backend-1.9.0.zip.sha256', size: 90 });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ tag_name: 'v1.9.0', body: 'Notes here', published_at: '2026-10-17T00:00:00Z', assets }));
    }
    if (url.endsWith('/assets/11')) {
      if (req.headers.accept !== 'application/octet-stream') { res.writeHead(415); return res.end(); }
      res.writeHead(200, { 'content-length': String(ZIP.length) });
      // 'short': send a little, then go silent without finishing (a stalled connection)
      if (mode === 'short') return void res.write(ZIP.subarray(0, 100));
      return res.end(ZIP);
    }
    if (url.endsWith('/assets/12')) {
      const sha = mode === 'bad-sha' ? 'a'.repeat(64) : ZIP_SHA;
      res.writeHead(200);
      return res.end(`${sha}  fibe-backend-1.9.0.zip\n`);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tmp = mkdtempSync(join(tmpdir(), 'fibe-remote-'));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

const client = (token = TOKEN) => new RemoteReleaseClient({ repo: 'o/r', token, apiBase: base, stallTimeoutMs: 600 });

describe('RemoteReleaseClient', () => {
  it('finds the latest published release and its zip + checksum assets', async () => {
    mode = 'ok';
    const r = await client().latest();
    expect(r).toMatchObject({ version: '1.9.0', tag: 'v1.9.0', notes: 'Notes here', zipAssetId: 11, sha256AssetId: 12 });
  });

  it('returns null when there is no published release', async () => {
    mode = 'none';
    expect(await client().latest()).toBeNull();
  });

  it('gives a clear error when GitHub refuses the token', async () => {
    mode = 'ok';
    await expect(client('wrong').latest()).rejects.toThrow(/refused the update token/);
  });

  it('downloads, reports progress and verifies the checksum', async () => {
    mode = 'ok';
    const release = (await client().latest())!;
    const dest = join(tmp, 'ok.zip');
    let last = 0;
    const sha = await client().download(release, dest, (received) => { last = received; });
    expect(sha).toBe(ZIP_SHA);
    expect(last).toBe(ZIP.length);
    expect(readFileSync(dest).equals(ZIP)).toBe(true);
  });

  it('deletes the file and refuses when the checksum does not match', async () => {
    mode = 'ok';
    const release = (await client().latest())!;
    mode = 'bad-sha';
    const dest = join(tmp, 'bad.zip');
    await expect(client().download(release, dest, () => undefined)).rejects.toThrow(/does not match/);
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a release that has no .sha256 file', async () => {
    mode = 'no-sha';
    const release = (await client().latest())!;
    const dest = join(tmp, 'nosha.zip');
    await expect(client().download(release, dest, () => undefined)).rejects.toThrow(/no \.sha256/);
    expect(existsSync(dest)).toBe(false);
  });

  it('gives up on a stalled download and discards the partial file', async () => {
    mode = 'ok';
    const release = (await client().latest())!;
    mode = 'short';
    const dest = join(tmp, 'short.zip');
    await expect(client().download(release, dest, () => undefined)).rejects.toThrow(/stalled/);
    expect(existsSync(dest)).toBe(false);
  });
});

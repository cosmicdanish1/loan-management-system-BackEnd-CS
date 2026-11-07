import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CertificateService } from '../../../src/modules/deposit/services/certificate.service';

describe('certificate numbers never repeat (ES-411)', () => {
  let dir: string;
  const mk = (): any => new CertificateService({} as any, {} as any, {} as any, { get: (k: string, d?: any) => (k === 'CERTIFICATES_PATH' ? dir : d) } as any, {} as any);
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'certs-')); });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('1000 numbers in a row are all different and keep the type + year + month prefix', async () => {
    const svc = mk(); const seen = new Set<string>(); const now = new Date(); const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    for (let i = 0; i < 1000; i++) { const n: string = await svc.generateCertificateNumber(['FD', 'RD', 'SH'][i % 3]); expect(n).toMatch(new RegExp(`^(FD|RD|SH)CERT${ym}[0-9]{6}$`)); seen.add(n); }
    expect(seen.size).toBe(1000);
  });
  it('a number already used in a saved certificate file is not issued again, even by a new service instance (restart)', async () => {
    const first: string = await mk().generateCertificateNumber('FD');
    fs.writeFileSync(path.join(dir, `FD_${first}_123.pdf`), 'x');
    for (let i = 0; i < 300; i++) expect(await mk().generateCertificateNumber('FD')).not.toBe(first);
  });
});

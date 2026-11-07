import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import { CertificateService } from '../../../src/modules/deposit/services/certificate.service';

describe('deposit/CertificateService file name guard and numbering', () => {
  let dir: string; let svc: any;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'certs-'));
    svc = new CertificateService({} as any, {} as any, {} as any, { get: (k: string, d?: any) => (k === 'CERTIFICATES_PATH' ? dir : d) } as any, {} as any);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates the certificates folder', () => expect(fs.existsSync(dir)).toBe(true));
  it('a plain file name resolves inside the folder', () => expect(svc.getCertificateFilePath('FDCERT1.pdf')).toBe(path.join(path.resolve(dir), 'FDCERT1.pdf')));
  it('rejects traversal, absolute paths, drive letters, NUL bytes, separators, empty and missing names', () => {
    for (const n of ['..\\x.pdf', '../x.pdf', '..', '/etc/passwd', 'C:\\x.pdf', 'a\0.pdf', 'a/b.pdf', 'a\\b.pdf', '', undefined]) {
      expect(() => svc.getCertificateFilePath(n as any)).toThrow(BadRequestException);
    }
  });
  it('a double-dot inside a name is refused', () => expect(() => svc.getCertificateFilePath('a..b.pdf')).toThrow(BadRequestException));
  it('deleteCertificate removes an existing file and ignores a missing one', async () => {
    fs.writeFileSync(path.join(dir, 'x.pdf'), 'x'); await svc.deleteCertificate('x.pdf'); expect(fs.existsSync(path.join(dir, 'x.pdf'))).toBe(false); await expect(svc.deleteCertificate('none.pdf')).resolves.toBeUndefined();
  });
  it('deleteCertificate never touches a file outside the folder', async () => {
    const outside = path.join(path.dirname(dir), 'outside-cert-test.txt'); fs.writeFileSync(outside, 'x');
    await expect(svc.deleteCertificate('..\\outside-cert-test.txt')).rejects.toThrow(BadRequestException); expect(fs.existsSync(outside)).toBe(true); fs.unlinkSync(outside);
  });
  it('certificate numbers are unique (two numbers made in the same month never repeat)', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const a = await svc.generateCertificateNumber('FD'); const b = await svc.generateCertificateNumber('FD'); jest.restoreAllMocks();
    expect(a).not.toBe(b);
  });
  it('certificate numbers carry the type, year and month', async () => {
    const n: string = await svc.generateCertificateNumber('RD'); const now = new Date(); expect(n.startsWith(`RDCERT${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`)).toBe(true);
  });
});

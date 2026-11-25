// Signature Scanning: the legacy keeps member signatures in Bank_Signature (account number = member number). The migrated
// copy is shown when the member has no file saved by the new screen, and Purge removes both.
import * as fs from 'fs';
import { NotFoundException } from '@nestjs/common';
import { SignatureService } from '../../../src/modules/member/services-v2/signature.service';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BMP = Buffer.from([0x42, 0x4d, 0xbe, 0x59, 0x0a, 0, 0, 0]);

function mk(o: { member?: any; bank?: Buffer | null } = {}) {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const ds: any = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (/SELECT signature_image_path FROM member_master/.test(sql)) return o.member === undefined ? [] : [o.member];
      if (/FROM bank_signature/.test(sql) && /^\s*SELECT/.test(sql)) return o.bank ? [{ signature: o.bank }] : [];
      return [];
    }),
  };
  return { svc: new SignatureService({} as any, ds), calls };
}

describe('detectImageType', () => {
  it.each([[JPEG, 'image/jpeg'], [PNG, 'image/png'], [BMP, 'image/bmp']])('%#', (b, want) => expect(SignatureService.detectImageType(b)).toBe(want));
  it.each([[Buffer.from('<html>')], [Buffer.from([1, 2])], [null], [undefined], [Buffer.alloc(0)]])('not an image %#', (b) => expect(SignatureService.detectImageType(b as any)).toBeNull());
});

describe('getSignatureForMaster', () => {
  afterEach(() => jest.restoreAllMocks());

  it('the file saved by the new screen comes first', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const { svc, calls } = mk({ member: { signature_image_path: 'uploads/signatures/a.png' }, bank: JPEG });
    const r: any = await svc.getSignatureForMaster('300');
    expect(r.kind).toBe('file');
    expect(r.path).toContain('a.png');
    expect(calls.some((c) => /FROM bank_signature/.test(c.sql))).toBe(false);
  });

  it('no file: the migrated legacy signature is shown, with its real image type (legacy bitmaps too)', async () => {
    const { svc, calls } = mk({ member: { signature_image_path: null }, bank: BMP });
    const r: any = await svc.getSignatureForMaster('30017688');
    expect(r.kind).toBe('bytes');
    expect(r.mime).toBe('image/bmp');
    expect(r.data).toBe(BMP);
    expect(calls.find((c) => /FROM bank_signature/.test(c.sql))!.params).toEqual(['30017688']);
  });

  it('the file is named in the member row but missing on disk: the legacy copy is used', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const { svc } = mk({ member: { signature_image_path: 'uploads/signatures/gone.png' }, bank: JPEG });
    expect((await svc.getSignatureForMaster('300') as any).mime).toBe('image/jpeg');
  });

  it('nothing anywhere: null (the screen shows no signature)', async () => {
    const { svc } = mk({ member: { signature_image_path: null }, bank: null });
    expect(await svc.getSignatureForMaster('300')).toBeNull();
  });

  it('bytes that are not an image are never sent to the screen', async () => {
    const { svc } = mk({ member: { signature_image_path: null }, bank: Buffer.from('not an image at all') });
    expect(await svc.getSignatureForMaster('300')).toBeNull();
  });

  it('an unknown member is 404 as before', async () => {
    const { svc } = mk({ member: undefined });
    await expect(svc.getSignatureForMaster('999')).rejects.toThrow(NotFoundException);
  });

  it('spaces around the member number are ignored when looking in the legacy table', async () => {
    const { svc, calls } = mk({ member: { signature_image_path: null }, bank: PNG });
    await svc.getSignatureForMaster(' 300 ');
    expect(calls.find((c) => /FROM bank_signature/.test(c.sql))!.params).toEqual(['300']);
  });
});

describe('deleteSignatureMaster (Purge)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('removes the saved file, clears the path AND deletes the migrated legacy copy', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const unlink = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
    const { svc, calls } = mk({ member: { signature_image_path: 'uploads/signatures/a.png' } });
    await svc.deleteSignatureMaster('300');
    expect(unlink).toHaveBeenCalled();
    expect(calls.some((c) => /UPDATE member_master SET signature_image_path = NULL/.test(c.sql))).toBe(true);
    expect(calls.find((c) => /DELETE FROM bank_signature/.test(c.sql))!.params).toEqual(['300']);
  });

  it('a member with only a legacy signature: Purge deletes it, so it does not come back', async () => {
    const { svc, calls } = mk({ member: { signature_image_path: null } });
    await svc.deleteSignatureMaster('30017688');
    expect(calls.find((c) => /DELETE FROM bank_signature/.test(c.sql))!.params).toEqual(['30017688']);
  });

  it('an unknown member is 404 and nothing is deleted', async () => {
    const { svc, calls } = mk({ member: undefined });
    await expect(svc.deleteSignatureMaster('999')).rejects.toThrow(NotFoundException);
    expect(calls.some((c) => /DELETE FROM bank_signature/.test(c.sql))).toBe(false);
  });
});

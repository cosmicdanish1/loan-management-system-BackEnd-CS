import * as fs from 'fs';
import * as path from 'path';
import { MemberValidationUtil } from '../../../src/modules/member/utils/member-validation.util';
import { MemberLookupService } from '../../../src/modules/member/services-v2/member-lookup.service';
import { SignatureService } from '../../../src/modules/member/services-v2/signature.service';

describe('member/MemberValidationUtil.validateMemberUpdate (ES-307)', () => {
  const v = (o: any) => MemberValidationUtil.validateMemberUpdate(o);
  it('sending nothing, or only one valid field, is fine', () => {
    expect(v({}).isValid).toBe(true);
    expect(v({ phoneNumber: '9876543210' }).isValid).toBe(true);
    expect(v({ email: 'a@b.com' }).isValid).toBe(true);
  });
  it('a field that is sent must still be valid', () => {
    expect(v({ phoneNumber: '123' }).errors).toContain('Invalid phone number format');
    expect(v({ email: 'nope' }).errors).toContain('Invalid email format');
    expect(v({ dateOfBirth: '2020-01-01' }).errors[0]).toMatch(/18 and 100/);
  });
  it('a required field cannot be blanked out', () => {
    expect(v({ firstName: '  ' }).errors).toContain('First name cannot be empty');
    expect(v({ lastName: '' }).errors).toContain('Last name cannot be empty');
    expect(v({ address: '' }).errors).toContain('Address cannot be empty');
    expect(v({ phoneNumber: '' }).errors).toContain('Phone number cannot be empty');
    expect(v({ dateOfBirth: null }).errors).toContain('Date of birth cannot be empty');
  });
  it('the full create validation still demands every required field', () => {
    expect(MemberValidationUtil.validateMemberData({ phoneNumber: '9876543210' }).isValid).toBe(false);
  });
});

describe('member/MemberLookupService limits and errors (ES-402)', () => {
  const mkQ = () => { const ds: any = { query: jest.fn().mockResolvedValue([]) }; return { svc: new MemberLookupService(ds), ds }; };
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('zero, negative, text, NaN and missing limits fall back to 500; a decimal is rounded down; Infinity is not a real number so it also gets 500', async () => {
    const { svc, ds } = mkQ();
    for (const l of [0, -5, 'abc', NaN, undefined]) await svc.lookupMembers('', l as any);
    expect(ds.query.mock.calls.map((c: any) => c[1][0])).toEqual([500, 500, 500, 500, 500]);
    await svc.lookupMembers('', 20.9);
    expect(ds.query.mock.calls[5][1][0]).toBe(20);
    await svc.lookupMembers('', Infinity);
    expect(ds.query.mock.calls[6][1][0]).toBe(500);
  });
  it('a negative or text offset becomes 0', async () => {
    const { svc, ds } = mkQ();
    await svc.lookupMembers('', 10, -3);
    await svc.lookupMembers('', 10, 'x' as any);
    await svc.lookupMembers('', 10, 40);
    expect(ds.query.mock.calls.map((c: any) => c[1][1])).toEqual([0, 0, 40]);
  });
  it('the search text is passed as a bound parameter', async () => {
    const { svc, ds } = mkQ();
    await svc.lookupMembers("x'; DROP TABLE member_master;--");
    expect(ds.query.mock.calls[0][0]).not.toContain('DROP TABLE');
    expect(ds.query.mock.calls[0][1][2]).toContain('DROP TABLE');
  });
  it('the original database error reaches the caller', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { svc, ds } = mkQ();
    const e = new Error('connection terminated');
    ds.query.mockRejectedValue(e);
    await expect(svc.lookupMembers('x')).rejects.toBe(e);
  });
});

describe('member/SignatureService upload order (ES-403)', () => {
  const cwd = process.cwd();
  function mk(rows: any[] | ((sql: string) => any[])) {
    const ds: any = { query: jest.fn(async (sql: string) => (typeof rows === 'function' ? rows(sql) : rows)) };
    const repo: any = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn(async (x) => x) };
    return { svc: new SignatureService(repo, ds), ds };
  }
  let unlink: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    unlink = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('signature: the row is updated first, the old file is deleted after, and the new file is kept', async () => {
    const { svc, ds } = mk([{ signature_image_path: 'uploads/old.png' }]);
    await svc.uploadSignatureMaster('9', path.join(cwd, 'uploads', 'n.png'));
    expect(unlink).toHaveBeenCalledWith(path.join(cwd, 'uploads/old.png'));
    expect(unlink).not.toHaveBeenCalledWith(path.join(cwd, 'uploads', 'n.png'));
    const updateAt = ds.query.mock.calls.findIndex((c: any[]) => /UPDATE member_master/.test(c[0]));
    expect(ds.query.mock.invocationCallOrder[updateAt]).toBeLessThan(unlink.mock.invocationCallOrder[0]);
  });
  it('signature: when the update fails the new upload is removed and the old file stays', async () => {
    const { svc } = mk((sql) => { if (/UPDATE/.test(sql)) throw new Error('db'); return [{ signature_image_path: 'uploads/old.png' }]; });
    await expect(svc.uploadSignatureMaster('9', path.join(cwd, 'uploads', 'n.png'))).rejects.toThrow('db');
    expect(unlink).toHaveBeenCalledWith(path.join(cwd, 'uploads', 'n.png'));
    expect(unlink).not.toHaveBeenCalledWith(path.join(cwd, 'uploads/old.png'));
  });
  it('signature: uploading to the same stored path again never deletes the file it just stored', async () => {
    const { svc } = mk([{ signature_image_path: 'uploads/n.png' }]);
    await svc.uploadSignatureMaster('9', path.join(cwd, 'uploads', 'n.png'));
    expect(unlink).not.toHaveBeenCalled();
  });
  it('signature: a member with no earlier file just gets the new one', async () => {
    const { svc, ds } = mk([{ signature_image_path: null }]);
    await svc.uploadSignatureMaster('9', path.join(cwd, 'uploads', 'n.png'));
    expect(unlink).not.toHaveBeenCalled();
    expect(ds.query.mock.calls.some((c: any[]) => /UPDATE member_master/.test(c[0]))).toBe(true);
  });
  it('photo: update first, then the old file; a failed update keeps the old photo', async () => {
    const ok = mk([{ profile_photo_path: 'uploads/oldp.png' }]);
    await ok.svc.uploadPhotoMaster('9', path.join(cwd, 'uploads', 'p.png'), 'profile');
    expect(unlink).toHaveBeenCalledWith(path.join(cwd, 'uploads/oldp.png'));
    unlink.mockClear();
    const bad = mk((sql) => { if (/UPDATE/.test(sql)) throw new Error('db'); return [{ profile_photo_path: 'uploads/oldp.png' }]; });
    await expect(bad.svc.uploadPhotoMaster('9', path.join(cwd, 'uploads', 'p.png'), 'profile')).rejects.toThrow('db');
    expect(unlink).not.toHaveBeenCalledWith(path.join(cwd, 'uploads/oldp.png'));
    expect(unlink).toHaveBeenCalledWith(path.join(cwd, 'uploads', 'p.png'));
  });
});

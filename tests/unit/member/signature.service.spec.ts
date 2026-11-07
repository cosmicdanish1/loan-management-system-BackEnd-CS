import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SignatureService } from '../../../src/modules/member/services-v2/signature.service';

function mk(rows: any[] | ((sql: string, p?: any[]) => any[]) = []) {
  const ds: any = { query: jest.fn(async (sql: string, p?: any[]) => (typeof rows === 'function' ? rows(sql, p) : rows)) };
  const repo: any = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn(async (x) => x) };
  return { svc: new SignatureService(repo, ds), ds, repo };
}
const cwd = process.cwd();

describe('member/SignatureService', () => {
  let exists: jest.SpyInstance; let unlink: jest.SpyInstance;
  beforeEach(() => { exists = jest.spyOn(fs, 'existsSync').mockReturnValue(true); unlink = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  it('uploadSignature: unknown member removes the uploaded file and 404s', async () => {
    const { svc } = mk();
    await expect(svc.uploadSignature(1, path.join(cwd, 'uploads', 's.png'))).rejects.toThrow(NotFoundException);
    expect(unlink).toHaveBeenCalledWith(path.join(cwd, 'uploads', 's.png'));
  });
  it('uploadSignature: replaces the old file and stores a relative forward-slash path', async () => {
    const { svc, repo } = mk(); repo.findOne.mockResolvedValue({ id: 1, signatureImagePath: 'uploads/old.png' });
    const m = await svc.uploadSignature(1, path.join(cwd, 'uploads', 'signatures', 'new.png'));
    expect(unlink).toHaveBeenCalledWith(path.join(cwd, 'uploads/old.png')); expect(m.signatureImagePath).toBe('uploads/signatures/new.png');
  });
  it('deleteSignature: 404, and clears the path', async () => {
    const { svc, repo } = mk();
    await expect(svc.deleteSignature(1)).rejects.toThrow(NotFoundException);
    const m: any = { id: 1, signatureImagePath: 'uploads/a.png' }; repo.findOne.mockResolvedValue(m);
    await svc.deleteSignature(1); expect(m.signatureImagePath).toBeNull();
  });
  it('a failing file delete does not stop the database update', async () => {
    unlink.mockImplementation(() => { throw new Error('locked'); });
    const { svc, repo } = mk(); const m: any = { id: 1, signatureImagePath: 'uploads/a.png' }; repo.findOne.mockResolvedValue(m);
    await expect(svc.deleteSignature(1)).resolves.toBeUndefined(); expect(m.signatureImagePath).toBeNull();
  });
  it('master signature: unknown member removes the upload and 404s', async () => {
    const { svc } = mk([]);
    await expect(svc.uploadSignatureMaster('9', path.join(cwd, 'u.png'))).rejects.toThrow(NotFoundException);
    expect(unlink).toHaveBeenCalled();
  });
  it('master signature: an invalid member number (SQL error) removes the upload and answers 400', async () => {
    const { svc, ds } = mk(); ds.query.mockRejectedValue(new Error('invalid input syntax for type numeric'));
    await expect(svc.uploadSignatureMaster('abc', path.join(cwd, 'u.png'))).rejects.toThrow(BadRequestException); expect(unlink).toHaveBeenCalled();
  });
  it('master signature: stores the new path and deletes the previous file', async () => {
    const { svc, ds } = mk([{ signature_image_path: 'uploads/old.png' }]);
    await svc.uploadSignatureMaster('9', path.join(cwd, 'uploads', 'signatures', 'n.png'));
    expect(unlink).toHaveBeenCalledWith(path.join(cwd, 'uploads/old.png'));
    expect(ds.query.mock.calls.at(-1)[1]).toEqual(['uploads/signatures/n.png', '9']);
  });
  it('master signature: the old file is kept when the database update fails (no lost signature)', async () => {
    const { svc, ds } = mk(); ds.query.mockResolvedValueOnce([{ signature_image_path: 'uploads/old.png' }]).mockRejectedValueOnce(new Error('db'));
    await svc.uploadSignatureMaster('9', path.join(cwd, 'n.png')).catch(() => undefined);
    expect(unlink).not.toHaveBeenCalledWith(path.join(cwd, 'uploads/old.png'));
  });
  it('getSignaturePathMaster: 404 and null when none', async () => {
    await expect(mk([]).svc.getSignaturePathMaster('1')).rejects.toThrow(NotFoundException);
    expect(await mk([{ signature_image_path: null }]).svc.getSignaturePathMaster('1')).toBeNull();
  });
  it('photo type is whitelisted (profile, doc_front, doc_back): no column name from the request reaches SQL', async () => {
    const { svc, ds } = mk([{ mbno: 1 }]);
    await expect(svc.uploadPhotoMaster('1', 'x.png', 'profile_photo_path; DROP TABLE member_master')).rejects.toThrow(BadRequestException);
    await expect(svc.getPhotoPathMaster('1', 'bogus')).rejects.toThrow(/Unknown photo type/);
    expect(ds.query).not.toHaveBeenCalled();
  });
  it('photo upload writes the mapped column', async () => {
    const { svc, ds } = mk([{ mbno: 1 }]); await svc.uploadPhotoMaster('1', path.join(cwd, 'a.png'), 'doc_front');
    expect(ds.query.mock.calls.at(-1)[0]).toContain('doc_front_path');
  });
  it('photo delete clears the column and the file', async () => {
    const { svc, ds } = mk([{ profile_photo_path: 'uploads/p.png' }]); await svc.deletePhotoMaster('1', 'profile');
    expect(unlink).toHaveBeenCalled(); expect(ds.query.mock.calls.at(-1)[0]).toContain('= NULL');
  });
  it('documents: type cut to 50 and name to 255 characters, stored relative', async () => {
    const { svc, ds } = mk((sql) => (/INSERT INTO member_documents/.test(sql) ? [{ id: 3 }] : [{ mbno: 1 }]));
    await svc.addDocument('1', 'T'.repeat(80), path.join(cwd, 'uploads', 'documents', '1', 'k.pdf'), 'N'.repeat(300));
    const p = ds.query.mock.calls.find((c: any[]) => /INSERT INTO member_documents/.test(c[0]))[1];
    expect(p[1]).toHaveLength(50); expect(p[2]).toHaveLength(255); expect(p[3]).toBe('uploads/documents/1/k.pdf');
  });
  it('documents: a document of another member cannot be read or deleted by id', async () => {
    const { svc, ds } = mk([]);
    expect(await svc.getDocumentPath(5, '2')).toBeNull();
    await expect(svc.deleteDocument(5, '2')).rejects.toThrow(NotFoundException);
    expect(ds.query.mock.calls.filter((c: any[]) => /id = \$1 AND mbno = \$2/.test(c[0])).length).toBeGreaterThan(0);
  });
  it('documents: delete removes the file and the row', async () => {
    const { svc, ds } = mk((sql) => (/SELECT file_path/.test(sql) ? [{ file_path: 'uploads/documents/1/k.pdf' }] : []));
    await svc.deleteDocument(5, '1'); expect(unlink).toHaveBeenCalled(); expect(ds.query.mock.calls.at(-1)[0]).toContain('DELETE FROM member_documents');
  });
});

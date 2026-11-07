import * as path from 'path';
import { MemberValidationUtil as V } from '../../../src/modules/member/utils/member-validation.util';
import { MemberNumberUtil as N } from '../../../src/modules/member/utils/member-number.util';
import { photoUploadConfig, documentUploadConfig, signatureUploadConfig } from '../../../src/modules/member/config/multer.config';
import { IsValidAadharConstraint, IsValidPANConstraint, IsValidPhoneNumberConstraint, IsValidAgeConstraint } from '../../../src/modules/member/decorators/member-validation.decorator';

const yearsAgo = (y: number, extraDays = 0) => { const d = new Date(); d.setFullYear(d.getFullYear() - y); d.setDate(d.getDate() - extraDays); return d; };

describe('member/MemberValidationUtil', () => {
  it('Aadhar: 12 digits valid, empty allowed', () => {
    expect(V.isValidAadhar('123456789012')).toBe(true);
    expect(V.isValidAadhar('')).toBe(true);
  });
  it('Aadhar: 11 digits, 13 digits, letters, spaces invalid', () => {
    for (const a of ['12345678901', '1234567890123', '12345678901A', '1234 5678 9012']) expect(V.isValidAadhar(a)).toBe(false);
  });
  it('PAN: ABCDE1234F valid; lowercase / short invalid', () => {
    expect(V.isValidPAN('ABCDE1234F')).toBe(true);
    expect(V.isValidPAN('abcde1234f')).toBe(false);
    expect(V.isValidPAN('ABCDE1234')).toBe(false);
    expect(V.isValidPAN('')).toBe(true);
  });
  it('phone: accepts 10 digits, 91 prefix, +91 prefix', () => {
    for (const p of ['9876543210', '919876543210', '+919876543210']) expect(V.isValidPhoneNumber(p)).toBe(true);
  });
  it('phone: rejects numbers starting 0-5, short, long, letters, empty', () => {
    for (const p of ['5876543210', '0123456789', '987654321', '98765432101', 'abcdefghij', '']) expect(V.isValidPhoneNumber(p)).toBe(false);
  });
  it('phone: rejects 9876543210 with trailing junk', () => {
    expect(V.isValidPhoneNumber('9876543210abc')).toBe(false);
  });
  it('email basic validation', () => {
    expect(V.isValidEmail('a@b.co')).toBe(true);
    expect(V.isValidEmail('')).toBe(true);
    for (const e of ['a@b', 'a b@c.com', '@c.com', 'abc']) expect(V.isValidEmail(e)).toBe(false);
  });
  it('age: exactly 18 today is valid, one day short is invalid', () => {
    expect(V.isValidAge(yearsAgo(18))).toBe(true);
    expect(V.isValidAge(yearsAgo(18, -1))).toBe(false);
  });
  it('age: 100 valid, 101 invalid; custom range honoured', () => {
    expect(V.isValidAge(yearsAgo(100))).toBe(true);
    expect(V.isValidAge(yearsAgo(101))).toBe(false);
    expect(V.isValidAge(yearsAgo(20), 21, 60)).toBe(false);
  });
  it('age: a future birth date is invalid', () => {
    expect(V.isValidAge(new Date(Date.now() + 365 * 86400000))).toBe(false);
  });
  it('age: an invalid date (NaN) is not valid', () => {
    expect(V.isValidAge(new Date('garbage'))).toBe(false);
  });
  it('ageAtDate counts birthdays correctly', () => {
    expect(V.ageAtDate(new Date('1970-06-15'), new Date('2020-06-14'))).toBe(49);
    expect(V.ageAtDate(new Date('1970-06-15'), new Date('2020-06-15'))).toBe(50);
  });
  it('formatPhoneNumber normalises 10 digit, +91 and spaced numbers', () => {
    expect(V.formatPhoneNumber('9876543210')).toBe('919876543210');
    expect(V.formatPhoneNumber('+91 98765-43210')).toBe('919876543210');
    expect(V.formatPhoneNumber('919876543210')).toBe('919876543210');
  });
  const ok = { firstName: 'A', lastName: 'B', dateOfBirth: yearsAgo(30).toISOString(), address: 'x', phoneNumber: '9876543210' };
  it('validateMemberData: complete record is valid', () => expect(V.validateMemberData(ok)).toEqual({ isValid: true, errors: [] }));
  it('validateMemberData: reports every missing field', () => {
    expect(V.validateMemberData({}).errors).toEqual(['First name is required', 'Last name is required', 'Date of birth is required', 'Address is required', 'Phone number is required']);
  });
  it('validateMemberData: whitespace-only names are rejected', () => {
    expect(V.validateMemberData({ ...ok, firstName: '   ' }).isValid).toBe(false);
  });
  it('validateMemberData: bad optional fields are reported', () => {
    const r = V.validateMemberData({ ...ok, email: 'x', aadharNumber: '1', panNumber: 'z' });
    expect(r.errors).toEqual(['Invalid email format', 'Invalid Aadhar number format', 'Invalid PAN number format']);
  });
  it('validateMemberData: minor member is rejected', () => {
    expect(V.validateMemberData({ ...ok, dateOfBirth: yearsAgo(10).toISOString() }).errors[0]).toMatch(/18 and 100/);
  });
});

describe('member/MemberNumberUtil', () => {
  it('generates MEM + 6 digits', () => expect(N.generateMemberNumber(42)).toBe('MEM000042'));
  it('does not truncate a 7 digit sequence', () => expect(N.generateMemberNumber(1234567)).toBe('MEM1234567'));
  it('extracts the sequence number', () => expect(N.extractSequenceNumber('MEM000042')).toBe(42));
  it('extract returns 0 for non matching text', () => expect(N.extractSequenceNumber('XYZ1')).toBe(0));
  it('validates the format', () => {
    expect(N.isValidMemberNumber('MEM000042')).toBe(true);
    for (const x of ['MEM42', 'mem000042', 'MEM0000042', '']) expect(N.isValidMemberNumber(x)).toBe(false);
  });
});

describe('member/validation decorators', () => {
  const a: any = {};
  it('constraints delegate to the util and have messages', () => {
    expect(new IsValidAadharConstraint().validate('123456789012', a)).toBe(true);
    expect(new IsValidPANConstraint().validate('bad', a)).toBe(false);
    expect(new IsValidPhoneNumberConstraint().validate('9876543210', a)).toBe(true);
    expect(new IsValidAgeConstraint().validate(yearsAgo(30).toISOString(), a)).toBe(true);
    expect(new IsValidAadharConstraint().defaultMessage(a)).toMatch(/12 digits/);
  });
});

describe('member/multer upload config', () => {
  const run = (cfg: any, key: 'destination' | 'filename', req: any, file: any = { originalname: 'a.png' }) =>
    new Promise<string>((res, rej) => cfg.storage.getFilename && key === 'filename'
      ? cfg.storage.getFilename(req, file, (e: any, v: string) => (e ? rej(e) : res(v)))
      : cfg.storage.getDestination(req, file, (e: any, v: string) => (e ? rej(e) : res(v))));
  const filter = (cfg: any, mimetype: string) => new Promise<any>((res) => cfg.fileFilter({}, { mimetype }, (e: any, ok: boolean) => res({ e, ok })));

  it('photo size limit is 5 MB, document 10 MB, signature 2 MB', () => {
    expect(photoUploadConfig.limits!.fileSize).toBe(5 * 1024 * 1024);
    expect(documentUploadConfig.limits!.fileSize).toBe(10 * 1024 * 1024);
    expect(signatureUploadConfig.limits!.fileSize).toBe(2 * 1024 * 1024);
  });
  it('photo filter accepts jpeg/png and rejects pdf, gif, svg, html', async () => {
    expect((await filter(photoUploadConfig, 'image/png')).ok).toBe(true);
    for (const m of ['application/pdf', 'image/gif', 'image/svg+xml', 'text/html']) expect((await filter(photoUploadConfig, m)).ok).toBe(false);
  });
  it('document filter accepts pdf and rejects executables', async () => {
    expect((await filter(documentUploadConfig, 'application/pdf')).ok).toBe(true);
    expect((await filter(documentUploadConfig, 'application/x-msdownload')).ok).toBe(false);
  });
  it('document destination strips path traversal from mbno', async () => {
    const dest = await run(documentUploadConfig, 'destination', { params: { mbno: '../../etc' } });
    expect(dest.replace(/\\/g, '/')).toBe('./uploads/documents/etc');
  });
  it('photo file name contains no separators when type/mbno are hostile', async () => {
    const name = await run(photoUploadConfig, 'filename', { params: { mbno: '..\\..\\x', type: '../y' } });
    expect(name).not.toMatch(/[\\/]/);
  });
  it('signature file name is sanitised', async () => {
    const name = await run(signatureUploadConfig, 'filename', { params: { id: '../../boot' } });
    expect(path.basename(name)).toBe(name);
  });
  it('an upload whose name has a dangerous extension (.html/.exe) with an image content type is not stored with that extension', async () => {
    const name = await run(photoUploadConfig, 'filename', { params: { mbno: '1', type: 'photo' } }, { originalname: 'evil.html' });
    expect(name).not.toMatch(/\.html$/);
  });
  it('a document with a double extension .php is not stored as .php', async () => {
    const name = await run(documentUploadConfig, 'filename', { params: { mbno: '1' }, body: { docType: 'kyc' } }, { originalname: 'shell.php' });
    expect(name).not.toMatch(/\.php$/);
  });
});

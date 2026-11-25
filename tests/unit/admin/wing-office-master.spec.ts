// Wing / Office Master: WINGMAST and DIVISION_MASTER (the tables the rest of the application reads), the wing choice,
// the legacy trigger that moves members with their office, the 1 / 0 state, and the server-given branch number.
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { OfficeService } from '../../../src/modules/admin/services/office.service';
import { WingService } from '../../../src/modules/admin/services/wing.service';
import { Office } from '../../../src/modules/admin/entities/office.entity';
import { Wing } from '../../../src/modules/admin/entities/wing.entity';
import { CreateWingDto, UpdateWingDto } from '../../../src/modules/admin/dto/wing.dto';
import { CreateOfficeDto, UpdateOfficeDto } from '../../../src/modules/admin/dto/office.dto';

describe('the window edits the tables the application reads', () => {
  it('Wing is WINGMAST (wingno, wname, winstate); Office is DIVISION_MASTER (officeno, wingno, divno, name, address, city)', () => {
    const w = (require('typeorm') as any).getMetadataArgsStorage();
    const tables = w.tables.map((t: any) => [t.target.name, t.name]);
    expect(tables).toEqual(expect.arrayContaining([['Wing', 'wingmast'], ['Office', 'division_master']]));
    const cols = (cls: any) => w.columns.filter((c: any) => c.target === cls).map((c: any) => [c.propertyName, c.options.name]);
    expect(cols(Wing)).toEqual([['wingId', 'wingno'], ['wingName', 'wname'], ['state', 'winstate']]);
    expect(cols(Office)).toEqual([['officeId', 'officeno'], ['wingId', 'wingno'], ['division', 'divno'], ['officeName', 'name'], ['address', 'address'], ['city', 'city']]);
  });
});

describe('Wing state: 1 = In State, 0 = Out State, anything else is "Invalid State"', () => {
  it.each([['1', 1], ['0', 0], [1, 1], [0, 0], [' 1 ', 1], [undefined, 1], [null, 1], ['', 1]])('%j -> %s', (v, want) => expect(WingService.parseState(v)).toBe(want));
  it.each([['4'], ['2'], ['-1'], ['XX'], ['12345'], ['01'], [4], ['true']])('%j is refused with the legacy message', (v) => {
    expect(() => WingService.parseState(v)).toThrow(BadRequestException);
    expect(() => WingService.parseState(v)).toThrow(/Invalid State/);
  });

  const check = async (cls: any, body: any) => (await validate(plainToInstance(cls, body))).flatMap((e) => Object.values(e.constraints ?? {}));
  it('the DTO lets a state through as text (the service refuses a bad one with the legacy message); a number or text 0 / 1 is accepted', async () => {
    expect(await check(CreateWingDto, { wingId: '2', wingName: 'X', state: 1 })).toEqual([]);
    expect(await check(CreateWingDto, { wingId: '2', wingName: 'X', state: '0' })).toEqual([]);
    expect(await check(CreateWingDto, { wingId: '2', wingName: 'X' })).toEqual([]);
  });
  it('code at most 6 characters, name at most 45, no < or >', async () => {
    expect((await check(CreateWingDto, { wingId: '1234567', wingName: 'X' })).length).toBeGreaterThan(0);
    expect((await check(CreateWingDto, { wingId: '1', wingName: 'N'.repeat(46) })).length).toBeGreaterThan(0);
    expect((await check(CreateWingDto, { wingId: '<b>', wingName: 'X' })).length).toBeGreaterThan(0);
    expect(await check(CreateWingDto, { wingId: '123456', wingName: 'N'.repeat(45) })).toEqual([]);
  });
});

describe('WingService', () => {
  const mk = (o: { found?: any; members?: number; offices?: number; affected?: number } = {}) => {
    const repo: any = {
      findOne: jest.fn().mockResolvedValue(o.found ?? null),
      create: jest.fn((x) => x), save: jest.fn(async (x) => x), find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: o.affected ?? 1 }),
    };
    const ds: any = { query: jest.fn(async (sql: string) => [{ n: /member_master/.test(sql) ? (o.members ?? 0) : (o.offices ?? 0) }]) };
    return { svc: new WingService(repo, ds), repo, ds };
  };

  it('create stores the code, the trimmed name and the state number', async () => {
    const { svc, repo } = mk();
    await svc.create({ wingId: ' 2 ', wingName: ' NEW WING ', state: '0' } as any);
    expect(repo.save).toHaveBeenCalledWith({ wingId: '2', wingName: 'NEW WING', state: 0 });
  });
  it('create without a state is In State (1)', async () => {
    const { svc, repo } = mk();
    await svc.create({ wingId: '2', wingName: 'X' } as any);
    expect(repo.save.mock.calls[0][0].state).toBe(1);
  });
  it('create with a bad state is refused and nothing is saved', async () => {
    const { svc, repo } = mk();
    await expect(svc.create({ wingId: '2', wingName: 'X', state: '4' } as any)).rejects.toThrow(/Invalid State/);
    expect(repo.save).not.toHaveBeenCalled();
  });
  it('create with an existing code is refused (never overwrites)', async () => {
    const { svc, repo } = mk({ found: { wingId: '1' } });
    await expect(svc.create({ wingId: '1', wingName: 'X' } as any)).rejects.toThrow(ConflictException);
    expect(repo.save).not.toHaveBeenCalled();
  });
  it('a blank code is refused', async () => {
    await expect(mk().svc.create({ wingId: '  ', wingName: 'X' } as any)).rejects.toThrow(BadRequestException);
  });
  it('update changes the name and state of the wing named by the URL; a code in the body is ignored', async () => {
    const { svc, repo } = mk({ found: { wingId: '1', wingName: 'OLD', state: 1 } });
    const r = await svc.update('1', { wingId: '99', wingName: ' NEW ', state: '0' } as any);
    expect(r).toEqual({ wingId: '1', wingName: 'NEW', state: 0 });
    expect(repo.save).toHaveBeenCalled();
  });
  it('update with a bad state is refused', async () => {
    const { svc } = mk({ found: { wingId: '1', wingName: 'OLD', state: 1 } });
    await expect(svc.update('1', { state: '4' } as any)).rejects.toThrow(/Invalid State/);
  });
  it('update of an unknown wing is 404', async () => {
    await expect(mk().svc.update('9', { wingName: 'x' } as any)).rejects.toThrow(NotFoundException);
  });
  it('delete is refused while members or offices belong to the wing', async () => {
    await expect(mk({ members: 3 }).svc.remove('1')).rejects.toThrow(/3 member/);
    await expect(mk({ offices: 2 }).svc.remove('1')).rejects.toThrow(/2 office/);
  });
  it('delete works for an unused wing; unknown wing is 404', async () => {
    await expect(mk().svc.remove('7')).resolves.toBeUndefined();
    await expect(mk({ affected: 0 }).svc.remove('7')).rejects.toThrow(NotFoundException);
  });
});

describe('OfficeService', () => {
  type Rows = Record<string, any>;
  /** A fake database: offices, wings and members as arrays; the queries the service runs are answered from them. */
  const mk = (o: { wings?: string[]; offices?: Rows[]; members?: Rows[]; failOn?: RegExp } = {}) => {
    const wings = o.wings ?? ['1', '2'];
    const offices = o.offices ?? [{ officeno: 5, wingno: '1', divno: 3, name: 'DALLI RAJHRA', address: 'A', city: 'C' }];
    const members = o.members ?? [];
    const log: string[] = [];
    const events: string[] = [];
    const handle = async (sql: string, p: any[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      log.push(s);
      if (o.failOn && o.failOn.test(s)) throw new Error('db failure');
      if (/pg_advisory_xact_lock/.test(s)) return [];
      if (/FROM wingmast WHERE wingno/.test(s)) return wings.includes(p[0]) ? [{ x: 1 }] : [];
      if (/COALESCE\(MAX\(officeno\)/.test(s)) return [{ next: Math.max(0, ...offices.map((x) => x.officeno)) + 1 }];
      if (/SELECT 1 FROM division_master WHERE officeno/.test(s)) return offices.some((x) => x.officeno === p[0]) ? [{ x: 1 }] : [];
      if (/FROM division_master WHERE officeno = \$1 FOR UPDATE/.test(s)) return offices.filter((x) => x.officeno === p[0]);
      if (/^INSERT INTO division_master/.test(s)) { offices.push({ wingno: p[0], officeno: p[1], divno: p[2], name: p[3], address: p[4], city: p[5] }); return []; }
      if (/^UPDATE division_master/.test(s)) { const x = offices.find((r) => r.officeno === p[0])!; Object.assign(x, { wingno: p[1], divno: p[2], name: p[3], address: p[4], city: p[5] }); return [[], 1]; }
      if (/^UPDATE member_master SET wingno/.test(s)) {
        const moved = members.filter((m) => m.officeno === p[0] && (m.flg_retire ?? 'N') !== 'Y');
        moved.forEach((m) => { m.wingno = p[1]; });
        return [moved.map((m) => ({ mbno: m.mbno })), moved.length];
      }
      if (/SELECT COUNT\(\*\)::int AS n FROM member_master WHERE officeno/.test(s)) return [{ n: members.filter((m) => m.officeno === p[0]).length }];
      return [];
    };
    const runner: any = {
      connect: jest.fn(), release: jest.fn(),
      startTransaction: jest.fn(async () => { events.push('begin'); }),
      commitTransaction: jest.fn(async () => { events.push('commit'); }),
      rollbackTransaction: jest.fn(async () => { events.push('rollback'); }),
      query: jest.fn(handle),
    };
    const ds: any = { createQueryRunner: jest.fn(() => runner), query: jest.fn(handle) };
    const repo: any = { findOne: jest.fn(async ({ where }: any) => offices.find((x) => x.officeno === where.officeId) ?? null), find: jest.fn().mockResolvedValue([]), delete: jest.fn().mockResolvedValue({ affected: 1 }) };
    return { svc: new OfficeService(repo, ds), offices, members, log, events, runner, repo };
  };

  describe('create', () => {
    it('a blank Branch No gets the next number (highest + 1) from the server; division number defaults to it', async () => {
      const { svc, offices } = mk();
      const r: any = await svc.create({ officeName: ' NEW BRANCH ', wingId: '1', city: 'BHILAI' } as any);
      expect(r.officeId).toBe(6);
      expect(r.division).toBe(6);
      expect(r.officeName).toBe('NEW BRANCH');
      expect(offices.find((x) => x.officeno === 6)).toMatchObject({ wingno: '1', divno: 6, name: 'NEW BRANCH', city: 'BHILAI' });
    });
    it('the next number is taken under a lock inside one transaction, committed at the end', async () => {
      const { svc, log, events } = mk();
      await svc.create({ officeName: 'X', wingId: '1' } as any);
      expect(log.findIndex((l) => /pg_advisory_xact_lock/.test(l))).toBeLessThan(log.findIndex((l) => /COALESCE\(MAX\(officeno\)/.test(l)));
      expect(events).toEqual(['begin', 'commit']);
    });
    it('10 new branches in a row get 10 different numbers', async () => {
      const { svc } = mk();
      const nos: number[] = [];
      for (let i = 0; i < 10; i++) nos.push(((await svc.create({ officeName: 'B' + i, wingId: '1' } as any)) as any).officeId);
      expect(new Set(nos).size).toBe(10);
    });
    it('a typed number is used; one that already exists is refused and nothing is written', async () => {
      const a = mk();
      expect(((await a.svc.create({ officeId: 9, officeName: 'X', wingId: '2', division: 77 } as any)) as any)).toMatchObject({ officeId: 9, division: 77 });
      const b = mk();
      await expect(b.svc.create({ officeId: 5, officeName: 'X', wingId: '1' } as any)).rejects.toThrow(ConflictException);
      expect(b.events).toEqual(['begin', 'rollback']);
      expect(b.offices).toHaveLength(1);
    });
    it('the wing must exist (Division / RO is a choice of wings)', async () => {
      const { svc, offices } = mk();
      await expect(svc.create({ officeName: 'X', wingId: '99' } as any)).rejects.toThrow(/does not exist/);
      expect(offices).toHaveLength(1);
    });
    it('name and wing are required', async () => {
      await expect(mk().svc.create({ officeName: '  ', wingId: '1' } as any)).rejects.toThrow(/name is required/);
      await expect(mk().svc.create({ officeName: 'X' } as any)).rejects.toThrow(/Division \/ RO/);
    });
    it('a database failure rolls back and is not swallowed', async () => {
      const { svc, events } = mk({ failOn: /^INSERT INTO division_master/ });
      await expect(svc.create({ officeName: 'X', wingId: '1' } as any)).rejects.toThrow('db failure');
      expect(events).toEqual(['begin', 'rollback']);
    });
  });

  describe('update and the legacy trigger (members follow their office)', () => {
    const members = () => [
      { mbno: 1, officeno: 5, wingno: '1', flg_retire: 'N' },
      { mbno: 2, officeno: 5, wingno: '1', flg_retire: 'N' },
      { mbno: 3, officeno: 5, wingno: '1', flg_retire: 'Y' },
      { mbno: 4, officeno: 2, wingno: '1', flg_retire: 'N' },
    ];
    it('moving the office to another wing moves the members of that office who are not retired, and says how many', async () => {
      const m = members();
      const { svc, offices, events } = mk({ members: m });
      const r = await svc.update(5, { wingId: '2' } as any);
      expect(r.membersMoved).toBe(2);
      expect(offices[0]!.wingno).toBe('2');
      expect(m.map((x) => x.wingno)).toEqual(['2', '2', '1', '1']); // retired member 3 and the other office's member 4 stay
      expect(events).toEqual(['begin', 'commit']);
    });
    it('a member with no retired flag counts as active and moves with the office', async () => {
      const m = [{ mbno: 1, officeno: 5, wingno: '1', flg_retire: null }, { mbno: 2, officeno: 5, wingno: '1', flg_retire: 'Y' }];
      const { svc } = mk({ members: m });
      expect((await svc.update(5, { wingId: '2' } as any)).membersMoved).toBe(1);
      expect(m.map((x) => x.wingno)).toEqual(['2', '1']);
    });
    it('a change that keeps the wing moves nobody', async () => {
      const m = members();
      const { svc, log } = mk({ members: m });
      const r = await svc.update(5, { officeName: 'RENAMED', city: 'NEW CITY' } as any);
      expect(r.membersMoved).toBe(0);
      expect(r.officeName).toBe('RENAMED');
      expect(log.some((l) => /^UPDATE member_master/.test(l))).toBe(false);
    });
    it('only the fields that are sent change', async () => {
      const { svc, offices } = mk();
      await svc.update(5, { address: 'NEW ADDRESS' } as any);
      expect(offices[0]).toMatchObject({ name: 'DALLI RAJHRA', city: 'C', divno: 3, address: 'NEW ADDRESS', wingno: '1' });
    });
    it('a wing that does not exist is refused and neither the office nor the members change', async () => {
      const m = members();
      const { svc, offices, events } = mk({ members: m });
      await expect(svc.update(5, { wingId: '99' } as any)).rejects.toThrow(/does not exist/);
      expect(offices[0]!.wingno).toBe('1');
      expect(m.every((x) => x.wingno === '1')).toBe(true);
      expect(events).toEqual(['begin', 'rollback']);
    });
    it('if the member update fails the office change is rolled back too (saved together)', async () => {
      const { svc, events } = mk({ members: members(), failOn: /^UPDATE member_master/ });
      await expect(svc.update(5, { wingId: '2' } as any)).rejects.toThrow('db failure');
      expect(events).toEqual(['begin', 'rollback']);
    });
    it('unknown office is 404; a blank name or wing is refused', async () => {
      await expect(mk().svc.update(99, { officeName: 'x' } as any)).rejects.toThrow(NotFoundException);
      await expect(mk().svc.update(5, { officeName: '  ' } as any)).rejects.toThrow(/name is required/);
      await expect(mk().svc.update(5, { wingId: ' ' } as any)).rejects.toThrow(/Division \/ RO/);
    });
    it('1,000 members of the office move in one statement (stress)', async () => {
      const m = Array.from({ length: 1000 }, (_, i) => ({ mbno: i + 1, officeno: 5, wingno: '1', flg_retire: 'N' }));
      const { svc, log } = mk({ members: m });
      const r = await svc.update(5, { wingId: '2' } as any);
      expect(r.membersMoved).toBe(1000);
      expect(log.filter((l) => /^UPDATE member_master/.test(l))).toHaveLength(1);
    });
  });

  describe('delete', () => {
    it('refused while members belong to the office', async () => {
      const { svc } = mk({ members: [{ mbno: 1, officeno: 5, wingno: '1', flg_retire: 'N' }] });
      await expect(svc.remove(5)).rejects.toThrow(/1 member/);
    });
    it('works for an unused office; 404 when nothing was deleted', async () => {
      await expect(mk().svc.remove(5)).resolves.toBeUndefined();
      const x = mk(); x.repo.delete.mockResolvedValue({ affected: 0 });
      await expect(x.svc.remove(5)).rejects.toThrow(NotFoundException);
    });
  });
});

describe('Office DTOs', () => {
  const check = async (cls: any, body: any) => (await validate(plainToInstance(cls, body))).flatMap((e) => Object.values(e.constraints ?? {}));
  it('a blank Branch No is allowed (new branch); a number must be a whole number of 1 or more', async () => {
    expect(await check(CreateOfficeDto, { officeName: 'X', wingId: '1' })).toEqual([]);
    expect(await check(CreateOfficeDto, { officeId: 7, officeName: 'X', wingId: '1' })).toEqual([]);
    expect((await check(CreateOfficeDto, { officeId: 0, officeName: 'X', wingId: '1' })).length).toBeGreaterThan(0);
    expect((await check(CreateOfficeDto, { officeId: 1.5, officeName: 'X', wingId: '1' })).length).toBeGreaterThan(0);
    expect((await check(CreateOfficeDto, { officeId: 'abc', officeName: 'X', wingId: '1' })).length).toBeGreaterThan(0);
  });
  it('limits: city 20, wing 6, name 200, address 200; no < or >', async () => {
    expect((await check(CreateOfficeDto, { city: 'C'.repeat(21) })).length).toBeGreaterThan(0);
    expect((await check(CreateOfficeDto, { wingId: '1234567' })).length).toBeGreaterThan(0);
    expect((await check(CreateOfficeDto, { officeName: 'N'.repeat(201) })).length).toBeGreaterThan(0);
    expect((await check(CreateOfficeDto, { officeName: '<img src=x onerror=alert(1)>' })).length).toBeGreaterThan(0);
    expect((await check(CreateOfficeDto, { address: '<b>' })).length).toBeGreaterThan(0);
  });
  it('an update may send only what changes', async () => {
    expect(await check(UpdateOfficeDto, { city: 'X' })).toEqual([]);
    expect(await check(UpdateOfficeDto, {})).toEqual([]);
  });
});

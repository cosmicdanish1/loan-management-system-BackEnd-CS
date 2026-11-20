// ES-306: three admin API inconsistencies.
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { NotFoundException } from '@nestjs/common';
import { UpdateWingDto } from '../../../src/modules/admin/dto/wing.dto';
import { WingService } from '../../../src/modules/admin/services/wing.service';
import { SystemConfigService } from '../../../src/modules/admin/services/system-config.service';
import { AdminController } from '../../../src/modules/admin/admin.controller';

describe('PATCH /admin/wings/:id is a partial update', () => {
  it('a body with only wingName passes validation (no wingId needed)', async () => {
    const dto = plainToInstance(UpdateWingDto, { wingName: 'New name' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('a field that is sent is still checked', async () => {
    const dto = plainToInstance(UpdateWingDto, { wingName: '<b>x</b>' });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });

  it('changes the wing named by the URL and never renames its key from the body', async () => {
    const wing: any = { wingId: 'W1', wingName: 'Old', state: '1' };
    const repo: any = { findOne: jest.fn().mockResolvedValue(wing), save: jest.fn(async (x: any) => x) };
    const svc = new WingService(repo, {} as any);
    const saved: any = await svc.update('W1', { wingName: 'New', wingId: 'OTHER' } as any);
    expect(saved).toMatchObject({ wingId: 'W1', wingName: 'New', state: '1' });
  });
});

describe('GET /admin/config/system/:id', () => {
  const make = (row: any) => new SystemConfigService({ findOne: jest.fn().mockResolvedValue(row) } as any, {} as any, {} as any);

  it('returns the configuration with that id', async () => {
    const svc: any = make({ id: 7, key: 'K', value: 'v' });
    svc.mapConfigToResponseDto = (c: any) => ({ id: c.id, key: c.key });
    await expect(svc.findSystemConfigById(7)).resolves.toEqual({ id: 7, key: 'K' });
  });

  it('is a 404 when there is none', async () => {
    await expect(make(null).findSystemConfigById(99999)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('GET /admin/deposit-loan-slabs filters like /admin/config/deposit-slabs', () => {
  const make = () => {
    const sys: any = { findAllDepositSlabs: jest.fn().mockResolvedValue([]) };
    return { ctrl: new AdminController({} as any, sys), sys };
  };

  it('passes the type and the active flag as separate filters, not the whole query object', async () => {
    const { ctrl, sys } = make();
    await ctrl.getDepositLoanSlabs({ type: 'DEPOSIT', isActive: 'true' });
    expect(sys.findAllDepositSlabs).toHaveBeenCalledWith('DEPOSIT', true);
  });

  it('with no filters passes none', async () => {
    const { ctrl, sys } = make();
    await ctrl.getDepositLoanSlabs({});
    expect(sys.findAllDepositSlabs).toHaveBeenCalledWith(undefined, undefined);
  });

  it('isActive=false is a filter for inactive slabs', async () => {
    const { ctrl, sys } = make();
    await ctrl.getDepositLoanSlabs({ isActive: 'false' });
    expect(sys.findAllDepositSlabs).toHaveBeenCalledWith(undefined, false);
  });
});

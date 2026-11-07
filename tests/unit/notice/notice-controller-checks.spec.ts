import { BadRequestException } from '@nestjs/common';
import { NoticeController } from '../../../src/modules/notice/controllers/notice.controller';

function build() {
  const created: any[] = [];
  const svc: any = { create: jest.fn(async (d: any) => { created.push(d); return { id: 1, ...d }; }), reorder: jest.fn(async () => undefined) };
  return { c: new NoticeController(svc), svc, created };
}
const body = (o: any = {}) => ({ title: 'Holiday', message: 'Office closed', type: 'info' as any, ...o });
const req = (username = 'clerk1') => ({ user: { username } });

describe('NoticeController create / reorder checks (ES-371, ES-434)', () => {
  it('a good notice is saved with the signed-in user as the poster', async () => {
    const { c, created } = build();
    await c.create(body({ postedBy: 'admin' }), req('clerk1'));
    expect(created[0]).toMatchObject({ title: 'Holiday', message: 'Office closed', type: 'info', postedBy: 'clerk1' });
  });
  it('without a signed-in user the poster is "unknown", never the name from the body', async () => {
    const { c, created } = build();
    await c.create(body({ postedBy: 'admin' }));
    expect(created[0].postedBy).toBe('unknown');
  });
  it('title and message are trimmed; empty, blank, missing or non-text values are refused', async () => {
    const { c, created } = build();
    await c.create(body({ title: '  Hi  ', message: '  there ' }), req());
    expect(created[0]).toMatchObject({ title: 'Hi', message: 'there' });
    for (const bad of [{ title: '' }, { title: '   ' }, { title: 5 }, { title: undefined }, { message: '' }, { message: null }, { message: {} }]) {
      await expect(c.create(body(bad), req())).rejects.toBeInstanceOf(BadRequestException);
    }
  });
  it('a title over 200 characters is refused (the column holds 200)', async () => {
    await expect(build().c.create(body({ title: 'x'.repeat(201) }), req())).rejects.toThrow(/200/);
    await expect(build().c.create(body({ title: 'x'.repeat(200) }), req())).resolves.toBeDefined();
  });
  it('the type must be info, warning or success', async () => {
    for (const t of ['info', 'warning', 'success']) await expect(build().c.create(body({ type: t }), req())).resolves.toBeDefined();
    for (const t of ['INFO', 'danger', '', undefined, 3]) await expect(build().c.create(body({ type: t }), req())).rejects.toThrow(/type must be one of/);
  });
  it('nothing is saved when a check fails', async () => {
    const { c, svc } = build();
    await c.create(body({ title: '' }), req()).catch(() => undefined);
    expect(svc.create).not.toHaveBeenCalled();
  });
  it('reorder takes whole numbers only', async () => {
    const { c, svc } = build();
    await expect(c.reorder({ orderedIds: [3, 1, 2] })).resolves.toEqual({ success: true });
    for (const bad of [['a'], [1.5], [null], [1, '2'], [NaN]]) {
      await expect(c.reorder({ orderedIds: bad as any })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(svc.reorder).toHaveBeenCalledTimes(1);
  });
});

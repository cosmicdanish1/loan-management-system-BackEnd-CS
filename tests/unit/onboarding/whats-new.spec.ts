import { BadRequestException } from '@nestjs/common';
import { OnboardingService } from '../../../src/modules/onboarding/onboarding.service';

const svc = () => { const ds: any = { query: jest.fn().mockResolvedValue([]) }; return { s: new OnboardingService(ds), ds }; };

describe("What's New version check (ES-431)", () => {
  it('real versions are accepted and stored as given', async () => {
    for (const v of ['1.8.0', '0.0.1', '10.20.30', '12.40.105']) {
      const { s, ds } = svc();
      await expect(s.markWhatsNewSeen(1, v)).resolves.toBeDefined();
      expect(ds.query.mock.calls[0][1]).toEqual([1, v]);
    }
  });
  it('anything else is a 400 and nothing is written', async () => {
    for (const v of ['1.8', '1.8.0.1', 'v1.8.0', ' 1.8.0', '1.8.0 ', '1.8.x', '1..0', '1-8-0', 'a.b.c', '', '1.8.0; DROP TABLE x', 'ddd', '1d8d0']) {
      const { s, ds } = svc();
      await expect(s.markWhatsNewSeen(1, v)).rejects.toBeInstanceOf(BadRequestException);
      expect(ds.query).not.toHaveBeenCalled();
    }
  });
});

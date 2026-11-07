import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MOBILE_DS } from './mobile.constants';

/**
 * At start-up makes sure the "Mobile Control Center" menu row exists, so Configure UserLevel Default Rights can list it
 * (menu-action-map.ts id 243). Administrator levels bypass rights anyway. Harmless if it already exists.
 */
@Injectable()
export class MobileBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(MobileBootstrapService.name);

  constructor(@InjectDataSource(MOBILE_DS) private readonly ds: DataSource) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.ds.query(
        `INSERT INTO menumaster (menuid, menuname, menudesc, visibleflag)
         SELECT 243, 'Mobile Control Center', 'Mobile Control Center', 'Y'
          WHERE NOT EXISTS (SELECT 1 FROM menumaster WHERE menuid = 243)`,
      );
    } catch (e) {
      this.logger.warn(`menumaster seed for the Mobile Control Center skipped: ${(e as Error).message}`);
    }
  }
}

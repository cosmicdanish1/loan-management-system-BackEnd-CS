import { Injectable } from '@nestjs/common';
import { DataSource, MoreThan } from 'typeorm';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { DayEndProcess, DayEndStatus } from './modules/admin/entities/day-end-process.entity';

// A day-end row stuck in IN_PROGRESS (crash mid-run) must not block updates forever.
const DAY_END_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

// package.json sits at a different depth depending on how nest build lays out dist/,
// so walk up from this file instead of hard-coding a relative path.
function readBackendVersion(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, 'utf-8')).version ?? 'unknown';
      } catch {
        return 'unknown';
      }
    }
    dir = dirname(dir);
  }
  return 'unknown';
}

export const BACKEND_VERSION = readBackendVersion();

// The desktop app and the server updater read this before acting, so an update never restarts
// the server in the middle of a day-end run. Fails open (false) if the lookup errors: /health must
// keep answering for the liveness probe.
export async function isDayEndInProgress(dataSource: DataSource): Promise<boolean> {
  try {
    const running = await dataSource.getRepository(DayEndProcess).count({
      where: {
        status: DayEndStatus.IN_PROGRESS,
        startedAt: MoreThan(new Date(Date.now() - DAY_END_STALE_AFTER_MS)),
      },
    });
    return running > 0;
  } catch {
    return false;
  }
}

@Injectable()
export class AppService {
  constructor(private readonly dataSource: DataSource) {}

  getAppInfo(): object {
    return {
      name: 'Paper White Technology - LMS API',
      version: BACKEND_VERSION,
      description: 'Comprehensive backend API for Paper White Technology LMS',
      author: 'Paper White Technology',
      documentation: '/api/docs',
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
      status: 'running',
    };
  }

  async getHealthCheck(): Promise<object> {
    return {
      status: 'ok',
      version: BACKEND_VERSION,
      dayEndInProgress: await this.isDayEndInProgress(),
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
    };
  }

  private isDayEndInProgress(): Promise<boolean> {
    return isDayEndInProgress(this.dataSource);
  }
}

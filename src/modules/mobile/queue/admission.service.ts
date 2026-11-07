import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface AdmissionSettings {
  /** master switch (MOBILE_QUEUE_ENABLED=false lets everything through) */
  enabled: boolean;
  /** mobile requests that may run at the same time */
  maxConcurrent: number;
  /** waiting mobile requests; more than this are refused at once */
  maxQueue: number;
  /** a mobile request waits at most this long, then gets SERVER_BUSY */
  maxWaitMs: number;
  /** staff are "quiet" only this long after their last request finished (stops the gate flickering) */
  staffGraceMs: number;
  /** a staff request older than this no longer blocks mobile (a stuck or very long job must not starve members) */
  staffCapMs: number;
  /** do not release mobile work while the Node event loop is this late */
  maxLagMs: number;
}

export class ServerBusyError extends Error {
  constructor(
    public readonly queuePosition: number,
    public readonly retryAfterSeconds: number,
  ) {
    super('The society server is busy with staff work');
  }
}

interface Waiter {
  resolve: (r: { waitedMs: number; release: () => void }) => void;
  reject: (e: ServerBusyError) => void;
  enqueuedAt: number;
  timer: NodeJS.Timeout;
}

export interface AdmissionStats {
  staffActive: number;
  mobileRunning: number;
  queueLength: number;
  loopLagMs: number;
  admitted: number;
  rejected: number;
  waitP95Ms: number;
}

/**
 * Staff first, members last (PRD 13.5, ES-386). Desktop requests never wait. A mobile request starts only when no recent
 * staff request is running, fewer than `maxConcurrent` mobile requests run and the server is not lagging; otherwise it waits
 * in a first-in-first-out queue for at most `maxWaitMs` and then receives SERVER_BUSY with its place in line.
 * (One process cannot truly pre-empt a running request, so this keeps mobile OUT of the way rather than slowing it down.)
 */
@Injectable()
export class AdmissionService implements OnModuleDestroy {
  private readonly logger = new Logger(AdmissionService.name);
  readonly settings: AdmissionSettings;

  private nextId = 1;
  private readonly staff = new Map<number, number>(); // id -> start time
  private lastStaffEnd = 0;
  private running = 0;
  private readonly queue: Waiter[] = [];
  private pumpTimer: NodeJS.Timeout | null = null;

  private lagMs = 0;
  private lagTimer: NodeJS.Timeout | null = null;
  private lagLast = Date.now();

  private admitted = 0;
  private rejected = 0;
  private readonly waits: number[] = [];

  /** Clock used for every decision (tests replace it). */
  now: () => number = Date.now;

  constructor(config: ConfigService) {
    const n = (k: string, d: number) => Number(config?.get?.(k, d) ?? d);
    this.settings = {
      enabled: String(config?.get?.('MOBILE_QUEUE_ENABLED', 'true')) !== 'false',
      maxConcurrent: n('MOBILE_QUEUE_MAX_CONCURRENT', 3),
      maxQueue: n('MOBILE_QUEUE_MAX_LENGTH', 300),
      maxWaitMs: n('MOBILE_QUEUE_MAX_WAIT_MS', 25000),
      staffGraceMs: n('MOBILE_QUEUE_STAFF_GRACE_MS', 300),
      staffCapMs: n('MOBILE_QUEUE_STAFF_CAP_MS', 10000),
      maxLagMs: n('MOBILE_QUEUE_LAG_MS', 100),
    };
    // Event-loop lag probe: how late does a 50 ms timer fire?
    this.lagLast = this.now();
    this.lagTimer = setInterval(() => {
      const t = this.now();
      this.lagMs = Math.max(0, t - this.lagLast - 50);
      this.lagLast = t;
    }, 50);
    this.lagTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.lagTimer) clearInterval(this.lagTimer);
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    for (const w of this.queue.splice(0)) clearTimeout(w.timer);
  }

  // ───────── staff side ─────────

  /** Call when a staff (desktop) request starts; call the returned function when it ends. */
  staffStart(): () => void {
    const id = this.nextId++;
    this.staff.set(id, this.now());
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.staff.delete(id);
      this.lastStaffEnd = this.now();
      this.pump();
    };
  }

  private activeStaff(t: number): number {
    let n = 0;
    for (const started of this.staff.values()) if (t - started < this.settings.staffCapMs) n++;
    return n;
  }

  // ───────── mobile side ─────────

  private canRun(t: number): boolean {
    const s = this.settings;
    return this.running < s.maxConcurrent && this.activeStaff(t) === 0 && t - this.lastStaffEnd >= s.staffGraceMs && this.lagMs <= s.maxLagMs;
  }

  /** Resolves when the request may run (call `release` when it is finished) or rejects with ServerBusyError. */
  admitMobile(): Promise<{ waitedMs: number; release: () => void }> {
    if (!this.settings.enabled) return Promise.resolve({ waitedMs: 0, release: () => undefined });
    const t = this.now();
    if (this.queue.length === 0 && this.canRun(t)) return Promise.resolve(this.start(0));

    if (this.queue.length >= this.settings.maxQueue) {
      this.rejected++;
      return Promise.reject(new ServerBusyError(this.queue.length + 1, 30));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        enqueuedAt: t,
        timer: setTimeout(() => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) {
            this.queue.splice(i, 1);
            this.rejected++;
            this.record(this.settings.maxWaitMs);
            reject(new ServerBusyError(i + 1, Math.min(30, 3 + Math.ceil(this.queue.length / 3))));
            if (this.queue.length === 0) this.stopPump();
          }
        }, this.settings.maxWaitMs),
      };
      waiter.timer.unref?.();
      this.queue.push(waiter);
      this.startPump();
    });
  }

  /** Where would a new request stand right now? (1 = next) */
  queuePosition(): number {
    return this.queue.length + 1;
  }

  private start(waitedMs: number): { waitedMs: number; release: () => void } {
    this.running++;
    this.admitted++;
    this.record(waitedMs);
    let released = false;
    return {
      waitedMs,
      release: () => {
        if (released) return;
        released = true;
        this.running = Math.max(0, this.running - 1);
        this.pump();
      },
    };
  }

  private pump(): void {
    while (this.queue.length > 0 && this.canRun(this.now())) {
      const w = this.queue.shift()!;
      clearTimeout(w.timer);
      w.resolve(this.start(this.now() - w.enqueuedAt));
    }
    if (this.queue.length === 0) this.stopPump();
  }

  private startPump(): void {
    if (this.pumpTimer) return;
    this.pumpTimer = setInterval(() => this.pump(), 25);
    this.pumpTimer.unref();
  }

  private stopPump(): void {
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
  }

  private record(waitMs: number): void {
    this.waits.push(waitMs);
    if (this.waits.length > 200) this.waits.shift();
  }

  stats(): AdmissionStats {
    const sorted = [...this.waits].sort((a, b) => a - b);
    return {
      staffActive: this.activeStaff(this.now()),
      mobileRunning: this.running,
      queueLength: this.queue.length,
      loopLagMs: Math.round(this.lagMs),
      admitted: this.admitted,
      rejected: this.rejected,
      waitP95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0,
    };
  }
}

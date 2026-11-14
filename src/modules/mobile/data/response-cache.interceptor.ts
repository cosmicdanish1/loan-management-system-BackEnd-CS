import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Observable, of } from 'rxjs';
import { map, tap } from 'rxjs/operators';

interface Entry {
  data: unknown;
  etag: string;
  expires: number;
}

/**
 * Small in-memory cache with a time limit and a size limit (ES-227). Redis is configured in .env but unused on the office PC;
 * a plain Map is enough for one process and adds nothing to install. Oldest entries go first when it is full.
 */
export class ResponseCache {
  private readonly items = new Map<string, Entry>();
  constructor(private readonly maxEntries = 2000, private readonly now: () => number = Date.now) {}

  get(key: string): Entry | undefined {
    const e = this.items.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) {
      this.items.delete(key);
      return undefined;
    }
    return e;
  }

  set(key: string, data: unknown, etag: string, ttlMs: number): void {
    if (this.items.size >= this.maxEntries && !this.items.has(key)) {
      const oldest = this.items.keys().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
    this.items.delete(key); // re-insert so the newest entry is last
    this.items.set(key, { data, etag, expires: this.now() + ttlMs });
  }

  size(): number {
    return this.items.size;
  }
}

/** Weak ETag of a JSON value (the response envelope has a changing timestamp, so the tag is made from the data itself). */
export function etagOf(data: unknown): string {
  return `W/"${crypto.createHash('sha1').update(JSON.stringify(data ?? null)).digest('hex').slice(0, 20)}"`;
}

/**
 * For a member's own read-only routes: (1) the answer is kept for MOBILE_CACHE_TTL_SECONDS (default 45, 0 = off) per member and
 * address, so repeated opening of the same screen does not hit the database each time; (2) every answer carries an ETag, and a
 * request with a matching If-None-Match gets 304 with no body (saves the member's data). Never used on routes that depend on
 * a step-up approval (the ledger), because a cached answer would skip that check.
 * It sits inside the audit interceptor, so cached answers are still audited.
 */
@Injectable()
export class MemberCacheInterceptor implements NestInterceptor {
  private readonly cache = new ResponseCache(Number(process.env.MOBILE_CACHE_MAX_ENTRIES ?? 2000));
  private readonly ttlMs: number;

  constructor(config: ConfigService) {
    this.ttlMs = Math.max(0, Number(config.get('MOBILE_CACHE_TTL_SECONDS', 45))) * 1000;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    const mbno = req?.user?.mbno;
    if (req?.method !== 'GET' || !mbno) return next.handle();

    const key = `${mbno}|${req.originalUrl || req.url}`;
    const reply = (data: unknown, etag: string, fromCache: boolean): unknown => {
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      res.setHeader('X-Cache', fromCache ? 'HIT' : 'MISS');
      if (req.headers?.['if-none-match'] === etag) {
        res.status(304);
        return undefined;
      }
      return data;
    };

    if (this.ttlMs > 0) {
      const hit = this.cache.get(key);
      if (hit) return of(reply(hit.data, hit.etag, true));
    }
    return next.handle().pipe(
      tap((data) => {
        if (this.ttlMs > 0) this.cache.set(key, data, etagOf(data), this.ttlMs);
      }),
      map((data) => reply(data, etagOf(data), false)),
    );
  }
}

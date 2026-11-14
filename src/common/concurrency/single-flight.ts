/**
 * ES-267: helpers that keep a few heavy report queries from using up the whole database connection pool.
 *
 * singleFlight(key, fn)  - while a computation for `key` is running, every other caller with the same key waits for that
 *                          one result instead of starting its own query. Nothing is cached afterwards, so a request made
 *                          after the run finished always reads fresh data (no stale figures).
 * Gate                   - lets at most `limit` heavy computations run at once; the others queue (first come, first
 *                          served) instead of each taking a pool connection.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * @param shareMs optional: a successful result is also handed to identical requests that arrive within this many
 *                milliseconds after it finished (a very short window, so a queue of people opening the same report
 *                reads the database once, while a report opened after a posting is at most `shareMs` old).
 */
export function singleFlight<T>(key: string, fn: () => Promise<T>, shareMs = 0): Promise<T> {
    const running = inFlight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = (async () => fn())();
    inFlight.set(key, p);
    const clear = () => { if (inFlight.get(key) === p) inFlight.delete(key); };
    p.then(() => { if (shareMs > 0) setTimeout(clear, shareMs); else clear(); }, clear);
    return p;
}

export class Gate {
    private active = 0;
    private readonly waiting: Array<() => void> = [];

    constructor(private readonly limit: number) { }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) {
            await new Promise<void>((resolve) => this.waiting.push(resolve));
        }
        this.active++;
        try {
            return await fn();
        } finally {
            this.active--;
            const next = this.waiting.shift();
            if (next) next();
        }
    }
}

/**
 * ES-267: one shared limit for the heavy report screens. Reports scan large tables for seconds; thirty of them at the
 * same moment used every database connection and froze the screens that only need a quick lookup. At most
 * REPORT_MAX_CONCURRENCY (default 6) heavy requests run at the same time; the others wait in line WITHOUT holding a
 * database connection and are answered 503 "server busy, retry" only if they wait longer than REPORT_QUEUE_WAIT_MS
 * (default 60 s). A caller that gives up while waiting is simply removed from the line.
 */
const HEAVY_PATHS: RegExp[] = [
    /^\/api\/v\d+\/reports\//,
    /^\/api\/v\d+\/utilities\/head-master/,
    /^\/api\/v\d+\/utilities\/head-balance/,
    /^\/api\/v\d+\/print-voucher\/journal\/list/,
    /^\/api\/v\d+\/general-ledger\//,
    /^\/api\/v\d+\/member-ledger\//,
];

class QueueGate {
    private active = 0;
    private readonly waiting: Array<{ go: () => void }> = [];

    constructor(private readonly limit: number) { }

    /** Resolves with a release function, or null when `maxWaitMs` passed first (or `cancelled()` became true). */
    acquire(maxWaitMs: number, onCancelHook: (cancel: () => void) => void): Promise<(() => void) | null> {
        return new Promise((resolve) => {
            const release = () => {
                this.active--;
                const next = this.waiting.shift();
                if (next) next.go();
            };
            if (this.active < this.limit) {
                this.active++;
                resolve(release);
                return;
            }
            const entry = { go: () => { clearTimeout(timer); this.active++; resolve(release); } };
            const leave = () => {
                const i = this.waiting.indexOf(entry);
                if (i >= 0) this.waiting.splice(i, 1);
            };
            const timer = setTimeout(() => { leave(); resolve(null); }, maxWaitMs);
            this.waiting.push(entry);
            onCancelHook(() => { clearTimeout(timer); leave(); resolve(null); });
        });
    }
}

export function createHeavyReportGate() {
    const limit = Math.max(1, Number(process.env.REPORT_MAX_CONCURRENCY) || 6);
    const maxWait = Math.max(1000, Number(process.env.REPORT_QUEUE_WAIT_MS) || 60000);
    const gate = new QueueGate(limit);
    return async (req: any, res: any, next: () => void) => {
        const path = String(req.originalUrl || req.url || '').split('?')[0];
        if ((req.method !== 'GET' && req.method !== 'POST') || !HEAVY_PATHS.some((rx) => rx.test(path))) return next();
        let gone = false;
        const release = await gate.acquire(maxWait, (cancel) => { res.once('close', () => { if (!res.writableEnded) { gone = true; cancel(); } }); });
        if (!release) {
            if (gone || res.destroyed) return;
            res.setHeader('Retry-After', '3');
            res.status(503).json({
                statusCode: 503, timestamp: new Date().toISOString(), path: req.originalUrl, method: req.method,
                error: 'Service Unavailable', message: 'The server is busy right now. Please try again in a few seconds.', code: 'SERVER_BUSY', retryAfterSeconds: 3,
            });
            return;
        }
        let released = false;
        const done = () => { if (!released) { released = true; release(); } };
        res.once('finish', done);
        res.once('close', done);
        next();
    };
}

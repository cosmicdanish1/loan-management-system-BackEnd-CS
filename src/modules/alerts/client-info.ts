import type { Request } from 'express';

export interface ClientInfo {
    ip: string;
    host: string;
    mac: string;
    version: string;
}

const clean = (v: unknown, max: number): string =>
    String(Array.isArray(v) ? v[0] : v ?? '').replace(/[\r\n<>]/g, '').slice(0, max);

/**
 * Who is calling: IP from the socket, PC name / MAC / app version from headers the desktop
 * app sends. The headers are self-reported — use them to recognise a machine, never to
 * authorise anything.
 */
export function clientInfoOf(req: Request | undefined): ClientInfo {
    if (!req) return { ip: '', host: '', mac: '', version: '' };
    const rawIp = req.ip || req.socket?.remoteAddress || '';
    return {
        ip: rawIp.replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1'),
        host: clean(req.headers?.['x-client-host'], 60),
        mac: clean(req.headers?.['x-client-mac'], 20).toUpperCase(),
        version: clean(req.headers?.['x-client-version'], 20),
    };
}

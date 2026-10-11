import type { AlertService } from './alert.service';

/**
 * Lets code that is not built by Nest's DI (e.g. `new GlobalExceptionFilter()` in main.ts)
 * reach the AlertService. Every call site uses `AlertBridge.get()?.…`, so an alert problem
 * can never break the request that triggered it.
 */
export class AlertBridge {
    private static instance?: AlertService;

    static set(service: AlertService): void {
        AlertBridge.instance = service;
    }

    static get(): AlertService | undefined {
        return AlertBridge.instance;
    }
}

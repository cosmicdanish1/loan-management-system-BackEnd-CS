/** Client details copied from the HTTP request, used for the audit trail and device records. */
export interface ClientCtx {
  ip?: string;
  deviceId?: string; // raw X-Device-Id / body deviceId
  requestId?: string;
  appVersion?: string;
  platform?: string;
}

export function clientCtx(req: any, deviceId?: string): ClientCtx {
  const h = req?.headers ?? {};
  return {
    ip: req?.ip,
    deviceId: deviceId || (h['x-device-id'] as string | undefined),
    requestId: h['x-request-id'] as string | undefined,
    appVersion: h['x-app-version'] as string | undefined,
    platform: h['x-platform'] as string | undefined,
  };
}

/** What the app gets after a successful activation or login. */
export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  /** seconds until the access token expires */
  expiresIn: number;
}

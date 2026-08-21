// Shared PII/secret redaction — used by both the winston redactFormat (for
// backend-originated logs) and ClientLogsService (for frontend logs, which
// bypass winston entirely and are written directly to file + service_log).
export const REDACT_PATTERNS = [
  { regex: /("?password"?\s*[:=]\s*)"[^"]*"/gi, replacement: '$1"[REDACTED]"' },
  { regex: /("?token"?\s*[:=]\s*)"[^"]*"/gi, replacement: '$1"[REDACTED]"' },
  { regex: /("?aadhaar"?\s*[:=]\s*)"?\d{4}\s?\d{4}\s?\d{4}"?/gi, replacement: '$1"[REDACTED]"' },
  { regex: /("?pan"?\s*[:=]\s*)"?[A-Z]{5}\d{4}[A-Z]"?/gi, replacement: '$1"[REDACTED]"' },
  { regex: /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/g, replacement: 'Bearer [REDACTED]' },
];

export function redactText(text: string): string {
  let out = text;
  for (const p of REDACT_PATTERNS) {
    out = out.replace(p.regex, p.replacement);
  }
  return out;
}

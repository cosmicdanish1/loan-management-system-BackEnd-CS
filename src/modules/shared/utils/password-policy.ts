import { applyDecorators } from '@nestjs/common';
import { IsString, IsNotEmpty, MinLength, MaxLength, Matches } from 'class-validator';

/**
 * One password policy for every door that sets a password: Change Password, Forgot password, an administrator creating a
 * user or resetting a password (ES-660). Before, Change Password asked for 8 characters with upper, lower and a digit while
 * an administrator could hand out a 6-character password, and nothing had a maximum (ES-657: bcrypt only reads the first
 * 72 bytes, so a longer password was silently cut).
 *
 * A password may not START with a bcrypt hash marker ($2a$, $2b$, $2y$): the entity used to take such a value for an
 * already-hashed password and stored it as plain text (ES-654). It is refused here and the entity checks for a real hash.
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 64;
export const PASSWORD_RULE_TEXT = `Password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters with an uppercase letter, a lowercase letter and a number, and must not start with $2a$, $2b$ or $2y$.`;
const PASSWORD_PATTERN = /^(?!\$2[aby]\$)(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/s;

/** null when the password is acceptable, else the sentence to show */
export function passwordPolicyError(password: unknown): string | null {
  if (typeof password !== 'string' || password.length === 0) return 'Password is required.';
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX || !PASSWORD_PATTERN.test(password)) return PASSWORD_RULE_TEXT;
  return null;
}

/** A real bcrypt hash: $2a / $2b / $2y, two-digit cost, 53 characters of salt and hash (60 in all). */
export const isBcryptHash = (v: unknown): boolean => typeof v === 'string' && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(v);

/** Decorator for a DTO field that carries a NEW password. */
export const NewPassword = () =>
  applyDecorators(
    IsString(),
    IsNotEmpty(),
    MinLength(PASSWORD_MIN, { message: PASSWORD_RULE_TEXT }),
    MaxLength(PASSWORD_MAX, { message: PASSWORD_RULE_TEXT }),
    Matches(PASSWORD_PATTERN, { message: PASSWORD_RULE_TEXT }),
  );

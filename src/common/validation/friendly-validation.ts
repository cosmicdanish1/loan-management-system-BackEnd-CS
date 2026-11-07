import { BadRequestException, ValidationError } from '@nestjs/common';

/**
 * Turns class-validator errors into plain-language problems the screen can show next to the right field (ES-468),
 * each with a stable `code` (and `params`) so the front end can translate it (ES-286).
 *
 *   before: "firstName must be longer than or equal to 1 characters,firstName should not be empty"
 *   after : { field: 'firstName', label: 'First name', code: 'FIELD_REQUIRED', message: 'First name is required.' }
 *
 * The response keeps `message` (a list of the plain sentences) so older screens keep working.
 */
export interface FieldProblem {
  field: string;
  label: string;
  code: string;
  message: string;
  params?: Record<string, string | number>;
}

/** "firstName" -> "First name", "rlnMaxLoanAmt" -> "Rln max loan amt", "address.line1" -> "Address line 1" */
export function humanizeField(path: string): string {
  const words = path
    .replace(/\[(\d+)\]/g, ' $1')
    .replace(/[._]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const n = (v: unknown) => (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : String(v));

/** constraint name -> plain sentence builder; `raw` is class-validator's own sentence (used to read the limits). */
const TRANSLATORS: Record<string, (label: string, raw: string) => { code: string; message: string; params?: Record<string, string | number> }> = {
  isNotEmpty: (l) => ({ code: 'FIELD_REQUIRED', message: `${l} is required.` }),
  isDefined: (l) => ({ code: 'FIELD_REQUIRED', message: `${l} is required.` }),
  isString: (l) => ({ code: 'FIELD_TEXT', message: `${l} must be text.` }),
  isNumber: (l) => ({ code: 'FIELD_NUMBER', message: `${l} must be a number.` }),
  isNumberString: (l) => ({ code: 'FIELD_NUMBER', message: `${l} must be a number.` }),
  isInt: (l) => ({ code: 'FIELD_WHOLE_NUMBER', message: `${l} must be a whole number.` }),
  isPositive: (l) => ({ code: 'FIELD_POSITIVE', message: `${l} must be more than 0.` }),
  isNegative: (l) => ({ code: 'FIELD_NEGATIVE', message: `${l} must be less than 0.` }),
  isBoolean: (l) => ({ code: 'FIELD_YES_NO', message: `${l} must be Yes or No.` }),
  isArray: (l) => ({ code: 'FIELD_LIST', message: `${l} must be a list.` }),
  isEmail: (l) => ({ code: 'FIELD_EMAIL', message: `${l} must be a valid email address.` }),
  isDateString: (l) => ({ code: 'FIELD_DATE', message: `${l} must be a valid date.` }),
  isDate: (l) => ({ code: 'FIELD_DATE', message: `${l} must be a valid date.` }),
  isUUID: (l) => ({ code: 'FIELD_FORMAT', message: `${l} is not in the right format.` }),
  isEnum: (l, raw) => {
    const list = (raw.match(/one of the following values: (.*)$/) || [])[1];
    return { code: 'FIELD_CHOICE', message: list ? `${l} must be one of: ${list}.` : `${l} is not an allowed choice.` };
  },
  isIn: (l, raw) => {
    const list = (raw.match(/one of the following values: (.*)$/) || [])[1];
    return { code: 'FIELD_CHOICE', message: list ? `${l} must be one of: ${list}.` : `${l} is not an allowed choice.` };
  },
  min: (l, raw) => {
    const v = (raw.match(/not be less than (-?[\d.]+)/) || [])[1];
    return v === undefined
      ? { code: 'FIELD_MIN', message: `${l} is too small.` }
      : { code: 'FIELD_MIN', message: `${l} cannot be less than ${v}.`, params: { min: n(v) as number } };
  },
  max: (l, raw) => {
    const v = (raw.match(/not be greater than (-?[\d.]+)/) || [])[1];
    return v === undefined
      ? { code: 'FIELD_MAX', message: `${l} is too large.` }
      : { code: 'FIELD_MAX', message: `${l} cannot be more than ${v}.`, params: { max: n(v) as number } };
  },
  minLength: (l, raw) => {
    const v = (raw.match(/longer than or equal to (\d+)/) || [])[1];
    return { code: 'FIELD_TOO_SHORT', message: v ? `${l} must be at least ${v} characters.` : `${l} is too short.`, params: v ? { min: Number(v) } : undefined };
  },
  maxLength: (l, raw) => {
    const v = (raw.match(/shorter than or equal to (\d+)/) || [])[1];
    return { code: 'FIELD_TOO_LONG', message: v ? `${l} can be at most ${v} characters.` : `${l} is too long.`, params: v ? { max: Number(v) } : undefined };
  },
  matches: (l) => ({ code: 'FIELD_FORMAT', message: `${l} is not in the right format.` }),
  isDecimal: (l, raw) => {
    const v = (raw.match(/(\d+) decimal/) || [])[1];
    return { code: 'FIELD_DECIMALS', message: v ? `${l} can have at most ${v} decimal places.` : `${l} has too many decimal places.`, params: v ? { max: Number(v) } : undefined };
  },
  whitelistValidation: (l) => ({ code: 'FIELD_UNKNOWN', message: `${l} is not a field this request accepts.` }),
};

function fallback(label: string, constraint: string, raw: string): { code: string; message: string; params?: Record<string, string | number> } {
  // unknown rule: use class-validator's sentence with the technical field name replaced by the label
  const cleaned = raw.replace(/^[A-Za-z0-9_.[\]]+ (?=(must|should|has|is)\b)/, '').replace(/^property .+? should not exist$/, 'is not accepted');
  return { code: 'FIELD_INVALID', message: `${label} ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}`.replace(/\.?$/, '.') };
}

const TYPE_CODES = new Set(['FIELD_TEXT', 'FIELD_NUMBER', 'FIELD_WHOLE_NUMBER', 'FIELD_LIST', 'FIELD_YES_NO', 'FIELD_DATE', 'FIELD_EMAIL', 'FIELD_FORMAT']);
const LIMIT_CODES = new Set(['FIELD_MIN', 'FIELD_MAX', 'FIELD_TOO_SHORT', 'FIELD_TOO_LONG', 'FIELD_DECIMALS', 'FIELD_POSITIVE', 'FIELD_NEGATIVE']);

export function flattenValidationErrors(errors: ValidationError[], parent = ''): FieldProblem[] {
  const out: FieldProblem[] = [];
  for (const e of errors) {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const label = humanizeField(field);
    if (e.constraints) {
      for (const [constraint, raw] of Object.entries(e.constraints)) {
        const t = TRANSLATORS[constraint];
        const r = t ? t(label, raw) : fallback(label, constraint, raw);
        out.push({ field, label, code: r.code, message: r.message, ...(r.params ? { params: r.params } : {}) });
      }
    }
    if (e.children?.length) out.push(...flattenValidationErrors(e.children, field));
  }
  // "must be a number" and "is required" for the same empty field say the same thing: keep the first only
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = `${p.field}|${p.code === 'FIELD_REQUIRED' ? 'R' : p.code}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => (a.code === 'FIELD_REQUIRED' ? 0 : 1) - (b.code === 'FIELD_REQUIRED' ? 0 : 1)).reduce<FieldProblem[]>((acc, p) => {
    // when a field is required and missing, its other problems (wrong type, too short) are noise
    if (p.code !== 'FIELD_REQUIRED' && acc.some((x) => x.field === p.field && x.code === 'FIELD_REQUIRED')) return acc;
    // when the value is the wrong kind (text for a number), limits on it (min, max, length) say nothing useful
    if (LIMIT_CODES.has(p.code) && acc.some((x) => x.field === p.field && TYPE_CODES.has(x.code))) return acc;
    if (LIMIT_CODES.has(p.code)) { const later = out.some((x) => x.field === p.field && TYPE_CODES.has(x.code)); if (later) return acc; }
    acc.push(p);
    return acc;
  }, []);
}

export function buildValidationException(errors: ValidationError[]): BadRequestException {
  const problems = flattenValidationErrors(errors);
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'VALIDATION_FAILED',
    message: problems.map((p) => p.message),
    errors: problems,
  });
}

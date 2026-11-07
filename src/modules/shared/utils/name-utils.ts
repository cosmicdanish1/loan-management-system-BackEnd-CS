/** Name parts joined with single spaces; empty or blank parts are skipped (a member with no middle name has no double space) */
export function joinName(...parts: Array<string | null | undefined>): string {
    return parts.map((p) => (p ?? '').toString().trim()).filter(Boolean).join(' ');
}

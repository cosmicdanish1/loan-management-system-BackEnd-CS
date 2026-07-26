// A=Asset, E=Expense: debit-normal (balance = opening + debits - credits)
// L=Liability, I=Income, R=Reserve: credit-normal (balance = opening + credits - debits)
export function isDebitNormal(pflag: string | null | undefined): boolean {
    const flag = (pflag || '').trim().toUpperCase();
    return flag === 'A' || flag === 'E';
}

export function calculateClosingBalance(
    pflag: string | null | undefined,
    openingBalance: number,
    totalDebits: number,
    totalCredits: number,
): number {
    if (isDebitNormal(pflag)) {
        return Math.round((openingBalance + totalDebits - totalCredits) * 100) / 100;
    }
    return Math.round((openingBalance + totalCredits - totalDebits) * 100) / 100;
}

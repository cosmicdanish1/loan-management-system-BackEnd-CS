export class VoucherPrintDto {
    voucher_no: string;
    trans_date: Date;
    amount: number;
    narration: string;
    dr_cr: string; // 'Payment' (Debit) or 'Receipt' (Credit)

    // Payment details
    mode: string; // 'Cash', 'Cheque', etc.
    cheque_no?: string;
    cheque_date?: Date;
    bank_name?: string;

    // Member details
    member_no: number;
    member_name: string;

    // Account Head details
    head_code: string;
    head_name: string;
}

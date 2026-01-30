export class VoucherPrintEntryDto {
    trans_no: number;
    head_code: string;
    head_name: string;
    amount: number;
    narration: string;
    mbno?: number;
    access_no?: number;
    acc_type?: string;
}

export class VoucherPrintDto {
    voucher_no: string;
    trans_date: Date;
    total_amount: number;
    narration: string;
    dr_cr: string; // 'Payment' or 'Receipt'

    // Payment details
    mode: string;
    cheque_no?: string;
    cheque_date?: Date;
    bank_name?: string;

    // Common Member/Header details (from first entry)
    member_no?: number;
    member_name?: string;

    entries: VoucherPrintEntryDto[];
}

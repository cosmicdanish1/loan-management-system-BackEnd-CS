export class JournalVoucherDto {
    voucher_no: string;
    trans_date: Date;
    narration: string;
    entries: JournalEntryDto[];
}

export class JournalEntryDto {
    trans_no: number;
    member_code: number;
    member_name: string;
    head_code: string;
    head_name: string;
    debit: number;
    credit: number;
}

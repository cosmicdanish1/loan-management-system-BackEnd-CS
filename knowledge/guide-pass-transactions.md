# Staff Guide: Pass Transactions

## What it is

Pass Transactions (Transaction > Pass Transactions) is the last checkpoint before an entry becomes final. Vouchers wait here, grouped under their voucher number, until someone passes or rejects them.

## How to use it

1. Open Transaction > Pass Transactions. The waiting vouchers load automatically.
2. Check each voucher's lines: member, head, debit or credit, amount and cheque details.
3. Pass: posts the voucher to the ledger and cashbook permanently. A confirmation box warns that this cannot be undone.
4. Reject: permanently deletes a voucher that is still pending, with all its lines. It only works while the voucher is still pending. It also asks for confirmation.
5. Export downloads the list shown as a CSV file. Refresh reloads the list.

## What goes through Pass Transactions

Journal/Transfer Entry, Loan Disbursement, FD Interest Payout and FD Closure/Withdrawal all wait here for passing.

Compulsory Deposit and Saving Receipt/Payment do not appear here. They are posted immediately when saved.

## Why this matters for Day-End

Day-End refuses to run while any voucher is unpassed. If Day-End says "N unpass voucher(s) found", come here, pass or reject each one, and run Day-End again.

# Staff Guide: Day-End (closing the day)

## What Day-End does

Day-End closes the current working date and opens the next one. It checks the day's data, creates the day's report, takes a database backup and then opens the next working date. It normally takes 15 to 35 seconds, mostly for the backup. Open it from Administration > DayEnd Processing.

## Who can do it

An Administrator or a Manager can close the day. An Accountant can open the screen and see the figures but cannot close the day. If you see "Access denied", your login role is not allowed: ask an Administrator or Manager.

## How to close the day

1. Open Administration > DayEnd Processing.
2. Check the figures on the screen: Opening Balance, total Debit, total Credit and Closing Balance (Opening + Credit - Debit). Check that the System Verification items (Ledger Consistency, Voucher Sync, Date Alignment, Balance Reconciliation) are OK.
3. Before you start, make sure every voucher of the day has been passed in Transaction > Pass Transactions and every pending loan application has been approved or declined. Day-End refuses to run otherwise.
4. Click Close Day.
5. In the "Select Next Working Date" box, confirm the next date (it defaults to the current working date plus one day) and press OK. You can pick a later date, for example to skip a holiday, but never an earlier one.
6. Wait for it to finish, then refresh the screen. The old day is closed and the next day is open for entries.

You do not have to close the day every real day. If staff are still entering vouchers for the open working date, simply do not run Day-End yet.

## First use on a new installation

On a brand-new installation the screen first asks you to "Set initial working date". Only an Administrator can do this. Pick the real starting date of the books and confirm. It can be done only once; it cannot be changed after a day has been closed.

## Common messages and what to do

- "Cannot perform Day End - N unpass voucher(s) found! Go to Pass Transactions first." Open Transaction > Pass Transactions and pass or reject each pending voucher, then run Day-End again.
- "Cannot perform Day End - N pending loan application(s) awaiting approval!" Approve (sanction) or decline each pending loan application, then run Day-End again.
- "Day-end processing already completed for this date." The day is already closed. Nothing to do; continue with the next working date.
- "Another day-end process is currently in progress." Someone (or you) already started it. Wait for it to finish, then refresh. Do not click again.
- "Backup failed ..." or a permission error about the backup. The backup folder is full or not writable. The whole Day-End is cancelled safely and nothing is left half done. Ask your administrator to free disk space or fix the folder permissions, then retry.
- "Cannot reset - day-end has already been completed at least once." The system refuses to clear the working date after real history exists. This is a safety rule: do not try to force it.
- 401 or "session expired". Sign in again.

## Automatic closing

The nightly automatic Day-End (11:30 PM) is off by default. An Administrator can switch it on in Administration > Modify Business Rules > General Settings > "Auto Day-End (Nightly Close, 11:30 PM)". Even when it is on, it obeys the same checks: unpassed vouchers or pending loan applications stop it.

# Staff Guide: Loan from application to disbursement

## The path of a loan

1. Loan Application (Administration > Loan > Loan Application): enter the application. The screen checks eligibility for you.
2. Sanction: an authorised person sanctions the application. A loan application that is still pending blocks Day-End, so every application must be sanctioned or declined.
3. Loan Payment (Transaction > Loan Payment): stage the disbursement. The Transaction Breakdown table fills in automatically, including any Share or RD amount that is withheld.
4. Pass Transactions (Transaction > Pass Transactions): the disbursement voucher waits here. Passing it posts it to the ledger and cashbook for good. This cannot be undone, so check the lines first.

After a pass, the full sanctioned amount is booked as the member's loan, even if part of it was withheld and only the net amount was paid out.

## Regular Loan (RLN) rules

These apply to Regular Loans only, at any amount.

- Maximum limit: the member's existing regular-loan outstanding plus the new loan must not exceed the limit. The standard setting is Rs 10,00,000.
- RD requirement: the member's RD balance should be at least 5% of that total (existing plus new loan).
- Share value requirement: the member's share value should be at least 5% of the same total.
- A shortfall in RD or Share does not stop the application by default. The missing amount is withheld from the disbursement, not added to the loan. The application screen shows an amber "Shortfall" state with the net amount payable and asks you to confirm. A red "Over Limit" state means the application cannot be saved.
- A Regular Loan needs at least one guarantor (surety).
- All of these values (limit, RD %, Share %, whether a shortfall is withheld, blocked or ignored) can be changed by an Administrator in Administration > Modify Business Rules > Regular Loan Eligibility. The numbers above are the standard settings and can differ on your society's system, so trust what the application screen shows.

Worked example from the specification: existing regular loan Rs 2,00,000 and new loan Rs 2,00,000 give total Rs 4,00,000. Required RD is Rs 20,000 and required Share Rs 20,000. If the RD balance is Rs 15,000 the shortfall is Rs 5,000, so the member receives Rs 1,95,000.

Where the withheld amounts go: the Share shortfall is credited to the Share head (L1001) and the RD shortfall to the Compulsory Deposit head (L1004).

## Emergency Loan (ALN) and Loan Against Recovery (ELN)

- The 5% RD/Share rule does not apply to them.
- Emergency Loan has no limit on how many times a member can take it. The only rule is that the current emergency-loan balance plus the new amount must not exceed the cap (standard Rs 5,00,000). Repaying frees room for a new one.
- Emergency Loan needs no guarantor.

## Common problems

- Application shows "Over Limit": the total exposure is above the maximum. Reduce the amount or ask an Administrator whether the limit should change.
- Emergency loan refused with figures shown: the balance plus the new amount is above the cap.
- Cash disbursement refused: the system blocks a cash payout that would push the cash-in-hand balance further below zero. Use Bank mode, or correct the cash position first.
- Member Lookup shows "Failed to load members" or screens show 0 pending: the login may have expired. Sign in again.
- Day-End refuses to run because of pending loan applications: sanction or decline each one first.

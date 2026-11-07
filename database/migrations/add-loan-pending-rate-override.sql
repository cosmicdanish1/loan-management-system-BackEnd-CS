-- ES-506: per-loan interest / penal rate override entered at Loan Sanction.
-- loan_pending.rate and loan_pending.penalrate already exist (used by re-agreements). For a normal loan they stay NULL,
-- which means "use the loan type's card in Business Rules". When the sanctioning officer gives one customer a different
-- rate, the values are stored there together with the reason and who set it. Idempotent.
ALTER TABLE loan_pending ADD COLUMN IF NOT EXISTS rate_override_reason VARCHAR(200);
ALTER TABLE loan_pending ADD COLUMN IF NOT EXISTS rate_override_by VARCHAR(100);

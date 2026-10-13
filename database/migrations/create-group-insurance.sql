-- ES-98: yearly Group Insurance run. One lump sum per financial year is split over the active members and
-- deducted from each member's RD (member_balances.compulsory_deposit) at year end.
-- Same DDL as src/migrations/1791158400000-CreateGroupInsurance.ts.
CREATE TABLE IF NOT EXISTS group_insurance_run (
    id                 SERIAL PRIMARY KEY,
    yearcode           integer       NOT NULL,
    fy_label           varchar(20)   NOT NULL,
    fy_start           date          NOT NULL,
    fy_end             date          NOT NULL,
    lump_sum           numeric(14,2) NOT NULL,
    active_members     integer       NOT NULL,      -- members the lump sum was divided by
    per_member_amount  numeric(14,4) NOT NULL,      -- lump_sum / active_members, before pro-rata and rounding
    include_retired    boolean       NOT NULL DEFAULT true,
    posting_date       date          NOT NULL,
    voucher_no         varchar(20),
    charged_members    integer       NOT NULL DEFAULT 0,
    total_charged      numeric(14,2) NOT NULL DEFAULT 0,
    status             varchar(10)   NOT NULL DEFAULT 'POSTED',
    created_by         varchar(50),
    created_at         timestamp     NOT NULL DEFAULT now()
);
-- only one POSTED run per financial year, so a second click can never charge everybody twice
CREATE UNIQUE INDEX IF NOT EXISTS uq_group_insurance_run_year ON group_insurance_run (yearcode) WHERE status = 'POSTED';

CREATE TABLE IF NOT EXISTS group_insurance_charge (
    id          SERIAL PRIMARY KEY,
    run_id      integer       NOT NULL REFERENCES group_insurance_run(id),
    mbno        numeric       NOT NULL,
    months      integer       NOT NULL,             -- months of the year charged (joining month counted)
    calc_amount numeric(14,4) NOT NULL,             -- per_member_amount * months / 12
    charge      numeric(14,2) NOT NULL,             -- calc_amount rounded up
    rd_before   numeric(14,2) NOT NULL,
    rd_after    numeric(14,2) NOT NULL,             -- may be negative: recovered later (loan / new-year deposits)
    uncovered   numeric(14,2) NOT NULL DEFAULT 0,   -- part of the charge the RD balance could not cover
    UNIQUE (run_id, mbno)
);
CREATE INDEX IF NOT EXISTS idx_group_insurance_charge_mbno ON group_insurance_charge (mbno);

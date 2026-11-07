# Backend QA suite (tests/qa)

Black-box API tests against a running backend. They do not touch application code.

## Safety rules (hard)
- Never delete or change existing data. Delete/update paths are exercised only on records the suite creates itself (e.g. `QA_TMP_<timestamp>` users) and only by the id returned from its own create call.
- `01-route-sweep.js` sends GET only.
- Never put real credentials in files: pass them as environment variables.

## Run
```bash
cd backend
QA_USER=<test user> QA_PASS=<password> node tests/qa/01-route-sweep.js   # every route: no token / bad token / GET with token
QA_USER=... QA_PASS=... node tests/qa/02-auth.js                          # login negatives, JWT tampering, logout revocation
QA_USER=... QA_PASS=... node tests/qa/03-loan-calc.js                     # EMI maths, invalid input, read-only loan data invariants
QA_USER=... QA_PASS=... node tests/qa/04-user-lifecycle.js                # create/validate/role limits/reset/disable/delete on a temp user
QA_USER=... QA_PASS=... node tests/qa/05-stress.js                        # 10/50/150 concurrent users, payload abuse, recovery (~5 min)
QA_USER=... QA_PASS=... node tests/qa/06-member-write.js   # also 07-voucher, 08-savings, 09-loan-lifecycle, 10-loan-closure, 11-cd-journal-batch, 12-masters
                                                           # write flows; they only touch records they create themselves (QATEST members, QA masters)
node tests/qa/compare-migration.js                         # legacy MS SQL vs Postgres -> Migration_Gap_Analysis.xlsx (read-only)
node tests/qa/build-manual-tests.js                                        # regenerates docs/final-documentation/qa/Manual_Regression_Test_Plan.xlsx
```
Env: `QA_BASE` (default `http://localhost:3001/api/v1`). Results are written to `tests/qa/results/*.json`.

## Not yet covered
RD write flow, day-end initiate, interest update, dividend commit (global batches that change every member, so only previews/reads are tested), demand generation/import, backup restore, support desk, and report accuracy against the ledger.

## Old scripts
`tests/scripts/*` (about 170 ad-hoc scripts) and `tests/e2e` target port 3000 or `/api/v1` without a login token and are stale; use this folder instead.

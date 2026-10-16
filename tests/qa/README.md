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
node tests/qa/build-manual-tests.js                                        # regenerates docs/final-documentation/qa/Manual_Regression_Test_Plan.xlsx
```
Env: `QA_BASE` (default `http://localhost:3001/api/v1`). Results are written to `tests/qa/results/*.json`.

## Not yet covered (see Jira ES-248, 250-254)
Member create/edit, deposits (SB/RD/CD), voucher/journal/day-end posting, interest/dividend/demand, masters, utilities and backup restore. These need either a disposable database or clone records, so they are written only after that is agreed.

## Old scripts
`tests/scripts/*` (about 170 ad-hoc scripts) and `tests/e2e` target port 3000 or `/api/v1` without a login token and are stale; use this folder instead.

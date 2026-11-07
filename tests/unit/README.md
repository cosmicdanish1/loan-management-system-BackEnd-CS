# Backend unit tests (single home)

All Jest unit tests live in `tests/unit/<module>/` (one folder per `src/modules/<module>`, plus `common/`).
The report lives in `tests/unit/report/` and is ONE Excel file: `Backend_Unit_Test_Report.xlsx`.

```bash
cd backend
npm test                                         # every unit test
npx jest --config tests/jest.json tests/unit/auth   # one module
node tests/unit/report/run-phase.js 1            # run phase 1, store the result, rebuild the Excel
node tests/unit/report/run-phase.js --rebuild    # rebuild the Excel only
```

- `report/phases.json` - the phase plan (which folders belong to which phase)
- `report/results.json` - stored results of every phase run so far (source of the Excel)
- `report/jira-map.json` - which failing test is tracked by which Jira issue (new bug / comment)
- Excel sheets: Summary (per phase), Results (every test), Failures (with Jira key), Jira links.

Rules: unit tests mock the database and never touch real data. A failing test means the code is wrong
(or the test is stale and is then rewritten/removed); it is never "fixed" by loosening the expectation.

Other test folders in `tests/`: `qa/` and `qa-sweep/` are black-box API suites run against a live backend
(kept, they test things unit tests cannot). `scripts/`, `e2e/`, `data/` are old ad-hoc material (see report notes).

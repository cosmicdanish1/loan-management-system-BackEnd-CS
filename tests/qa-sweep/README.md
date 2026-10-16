# Backend QA sweep (2026-10-16)

Scripts: auth enforcement (p1), GET sweep (p2), DTO fuzz (p3), CRUD lifecycle with fake data (p4), stress (p5), security (p6).
Bugs found: Jira ES-291 .. ES-308.

Run against the LOCAL dev DB only. `lib.js` logs in as `qa_admin` / `QaAdmin@2026` - create that
level-1 user first (bcrypt hash into usermaster) and delete it afterwards.
Refresh `swagger.json` from http://localhost:3001/api/docs-json before running.

WARNING: lib.js DANGER filter skips mutating probes on risky routes, but p3 still POSTs bodies to
non-filtered write endpoints - POST /utilities/business-rules inserts a zeroed busrules row (ES-293)
and data-correction/* mutate data (ES-301). Keep them in the DANGER regex.

# LMS API Documentation

This folder is the single place to understand and exercise the backend API — useful
for **emergency direct-IP operations** when the desktop client is unavailable.

All files below are **auto-generated** from the NestJS Swagger metadata. Do not edit
them by hand; regenerate instead (see below).

| File | Use it for |
| --- | --- |
| `openapi.json` | The full OpenAPI 3.0 spec. Import into Postman **or** any Swagger viewer. |
| `LMS-API.postman_collection.json` | Ready-to-import Postman collection — all 465 endpoints, grouped into 46 folders, with `{{baseUrl}}` / `{{token}}` variables and sample JSON bodies. |
| `API_REFERENCE.md` | Human-readable list of every endpoint (method, path, what it does), grouped by module. |
| `API_DOCUMENTATION.docx` / `.pdf` | Full **API manual** (~242 pages): every endpoint with description, impact, auth, parameters, a working curl example and a sample response. The polished, shareable/printable reference. |

## Quick start (Postman)

1. **Import** → drag in `LMS-API.postman_collection.json`.
2. Open the collection's **Variables** tab:
   - `baseUrl` → `http://<server-ip>:3001` (the server root; the `/api/v1` prefix is already in each path).
   - `token` → leave blank for now.
3. Run **Authentication → `POST /api/v1/auth/login`** with a valid username/password.
   Copy `accessToken` from the response into the `token` variable.
4. Every other request now sends `Authorization: Bearer {{token}}` automatically.

## Live Swagger UI (browser)

Swagger is served by the running backend at:

- UI:   `http://<server-ip>:3001/api/docs`
- JSON: `http://<server-ip>:3001/api/docs-json`  ← Postman can import this URL directly

It is **enabled automatically outside production**. In production it is **off by
default** so the API map isn't exposed on the LAN. For an emergency, on the server:

1. Set `ENABLE_SWAGGER=true` in `backend/.env`.
2. Restart the backend.
3. Use the docs, then set it back to `false` and restart when done.

## Regenerating these files

After changing controllers/DTOs, refresh the docs (no database needed — uses Nest
preview mode):

```bash
cd backend
npm run openapi:generate
```

Then rebuild the DOCX + PDF manual from the refreshed `openapi.json`:

```bash
cd backend
npm run docs:manual
```

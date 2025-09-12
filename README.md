# Financial Dashboard

A simple full-stack financial dashboard using Express, SQLite, and vanilla JS + Tailwind + Chart.js.

## Features
- Add / edit income and expenditure transactions
- Charts: expenditure breakdown, daily flow
- SQLite persistence
- One-time CSV import endpoint (`POST /api/import-csv-once`)
- CSV export (`GET /api/transactions.csv`)
- Mobile-friendly UI

## Local Development
```bash
npm install
npm start
# open http://localhost:3000
```

## One-Time CSV Import
If deploying fresh and you want to seed from `updated-financial-data.csv`:
```bash
curl -X POST https://<your-domain>/api/import-csv-once
```
Subsequent calls return 409 once imported.

## Deployment (Render Free Tier)
1. Push this repo to GitHub.
2. Create new Web Service in Render.
3. Select your repo, choose Docker environment.
4. Render auto-detects `Dockerfile`.
5. Set `PORT=3000` environment variable (already in `render.yaml`).
6. Deploy.

### Provided Files
- `Dockerfile` – builds production image.
- `render.yaml` – infrastructure as code for Render (optional; add at root before first deploy). Use Render's "Blueprint" deployment if desired.

### Non-Docker Render Deployment
If you prefer not to use Docker, use `render-non-docker.yaml` or configure manually:
1. Remove / ignore `Dockerfile` (or keep, but choose non-Docker in UI).
2. Build Command: `npm install --production`
3. Start Command: `node server.js`
4. Add env var `PORT=3000`.
5. Deploy. Render will run Node directly.
`render-non-docker.yaml` can be used as a Blueprint for this variant.

## Manual (Non-Docker) Render Deploy Alternative
Instead of Docker, you can remove `Dockerfile` and set:
- Build Command: `npm install`
- Start Command: `node server.js`

## Persistence Notes
Render's free ephemeral disk resets on redeploy. For durable data, add a Render PostgreSQL instance and migrate, or periodically export CSV via `/api/transactions.csv`.

## Future Enhancements
- Incremental CRUD endpoints (PATCH/DELETE)
- Authentication
- Pagination & category normalization
- Data backup job

## License
MIT

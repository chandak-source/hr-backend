# hr-backend

REST API for **Chanda HR** — the FactoHR-style employee self-service app.
Node 20 + Express 5 + MySQL 8, JWT auth with refresh tokens, zod validation.

## Setup

```bash
npm install
cp .env.example .env        # fill in DB creds + a long random JWT_SECRET
npm run db:reset            # create schema + seed demo data
npm run dev                 # http://localhost:4000/api/v1
```

Seeded accounts all use the password from `SEED_PASSWORD` (default `demo@1234`).

## Scripts

| Script | Does |
|---|---|
| `npm start` | Run the API |
| `npm run dev` | Run with `--watch` |
| `npm run db:migrate` | Apply `src/db/schema.sql` (`--fresh` drops first) |
| `npm run db:seed` | Load demo employees, attendance, leave, payroll |
| `npm run db:reset` | `db:migrate --fresh` + `db:seed` |

## Environment

| Var | Default | Notes |
|---|---|---|
| `PORT` | `4000` | |
| `NODE_ENV` | `development` | |
| `API_PREFIX` | `/api/v1` | |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | — | MySQL 8 |
| `DB_CONNECTION_LIMIT` | `10` | Pool size |
| `DB_SSL` | `false` | `true` for managed MySQL (Aiven, PlanetScale, RDS) |
| `DB_SSL_CA` | — | Provider CA cert as PEM. Omitted ⇒ encrypted but unverified |
| `JWT_SECRET` | — | **Required.** Long random string |
| `JWT_EXPIRES_IN` | `1d` | Access token TTL |
| `REFRESH_TOKEN_EXPIRES_IN_DAYS` | `30` | |
| `SEED_PASSWORD` | `demo@1234` | Seeder only |

## API

All routes are under `API_PREFIX` and need `Authorization: Bearer <token>`
except `/auth/login`, `/auth/refresh` and `/health`.

| Group | Endpoints |
|---|---|
| `/auth` | `POST /login` · `POST /refresh` · `POST /logout` · `GET /me` · `POST /change-password` |
| `/attendance` | `GET /today` · `POST /punch-in` · `POST /punch-out` · `GET /log` · `GET /summary` · `GET /calendar` · `GET,POST /regularizations` |
| `/leave` | `GET /types` · `GET /balances` · `GET,POST /requests` · `POST /requests/:id/cancel` |
| `/payroll` | `GET /payslips` · `GET /payslips/:id` · `GET /ytd` |
| `/team` | `GET /members` · `GET /members/:id` · `GET /stats` · `GET /trend` |
| `/approvals` | `GET /summary` · `GET,POST /leave` · `POST /leave/bulk-approve` · `GET,POST /expenses` · `GET,POST /regularizations` |
| `/admin` | `GET /overview` · `GET,POST /employees` · `PATCH /employees/:id` · `GET /payroll/runs` · `POST /payroll/run` · `POST /payroll/runs/:id/publish` · `POST /payroll/runs/:id/unlock` · `POST,DELETE /announcements` · `GET /reports/{attendance,leave-balances,payroll-trend}` |
| root | `GET /expenses` · `POST /expenses` · `GET /expenses/categories` · `GET /tasks` · `PATCH /tasks/:id` · `GET /holidays` · `GET /announcements` · `GET /notifications` · `PATCH /notifications/:id/read` · `POST /notifications/read-all` · `GET /directory` · `GET /departments` |
| — | `GET /health` readiness (503 if MySQL down) · `GET /health/live` liveness — both outside the prefix |

Role guards live in `src/middleware/auth.js`: `/approvals` needs manager, `/admin`
needs admin, admin passes every guard.

## Layout

```
src/
├─ server.js          entry point — listen + graceful shutdown
├─ app.js             express wiring, helmet/cors/rate-limit, route mounting
├─ config/            env.js (validated config), db.js (pool + query helpers)
├─ db/                schema.sql, migrate.js, seed.js
├─ middleware/        auth.js (JWT + role guards), error.js
├─ routes/            one file per module
├─ services/          employee + payroll logic shared across routes
└─ utils/             ApiError, asyncHandler, response helpers
```

## Deploy — Render + Aiven MySQL

`render.yaml` is a Render Blueprint; Aiven supplies the MySQL 8 that Render
doesn't offer. The app is MySQL-specific (`ENUM`, `ON UPDATE CURRENT_TIMESTAMP`),
so Render's own Postgres is not a drop-in swap.

**1 — Aiven MySQL**

Create a free *MySQL* service (Aiven console → Services → MySQL → free plan).
From the service *Overview* tab collect: Host, Port, User (`avnadmin`),
Password, and download **CA Certificate** (`ca.pem`).

**2 — Create the database and load it (run locally)**

Aiven's free plan has no shell, so point your local `.env` at Aiven and run the
scripts from your machine:

```env
DB_HOST=mysql-xxxx.aivencloud.com
DB_PORT=12345
DB_USER=avnadmin
DB_PASSWORD=<aiven password>
DB_NAME=chanda_hr        # not defaultdb — migrate creates this one
DB_SSL=true
DB_SSL_CA="-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"
```

```bash
npm run db:migrate      # creates chanda_hr + 20 tables
npm run db:seed         # demo employees, attendance, leave, payroll
```

Don't use `db:reset` / `--fresh` against Aiven unless you mean it — it drops the
database first.

**3 — Render**

New → **Blueprint** → pick this repo. Render reads `render.yaml` and prompts for
the six `sync: false` vars — paste the same Aiven values (`DB_SSL_CA` as the full
PEM, newlines and all). `JWT_SECRET` is generated automatically; **don't** reuse
your local one.

Health check is `/health/live` (liveness). Hit `/health` yourself to confirm the
database leg: it returns `{"status":"ok","database":"up"}` when Aiven is wired up.

**Free-tier caveats**

- Render free spins down after ~15 min idle — first request then takes ~50s.
- Aiven free caps connections; `DB_CONNECTION_LIMIT` is set to `5` in the blueprint.
- Both free tiers are fine for demos, not for production payroll data.

Any other Node host works too — set the env vars above and run `npm ci && npm start`.
`src/server.js` binds the port before pinging MySQL so health checks pass during a
cold start, and handles `SIGTERM` for clean restarts.

## Not built yet

- File upload for expense receipts / leave attachments (`receipt_path` and
  `attachment_path` columns exist but no multipart route)
- Forgot / reset password
- CSV report export
- Masters CRUD (departments, shifts, locations, leave types)

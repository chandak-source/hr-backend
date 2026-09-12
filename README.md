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
| — | `GET /health` (outside the prefix) |

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

## Deploy

Any Node host works — set the env vars above, run `npm ci && npm start`.
`src/server.js` binds the port before pinging MySQL so platform health checks
pass during a cold start, and handles `SIGTERM` for zero-downtime restarts.

## Not built yet

- File upload for expense receipts / leave attachments (`receipt_path` and
  `attachment_path` columns exist but no multipart route)
- Forgot / reset password
- CSV report export
- Masters CRUD (departments, shifts, locations, leave types)

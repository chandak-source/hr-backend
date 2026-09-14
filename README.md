# hr-backend

REST API for **Chanda HR** — the FactoHR-style employee self-service app.
Node 20 + Express 5 + **MongoDB** (Mongoose), JWT auth with refresh tokens,
zod validation.

## Setup

```bash
npm install
cp .env.example .env        # set MONGODB_URI + a long random JWT_SECRET
npm run db:migrate          # build indexes
npm run db:seed             # master data + one bootstrap admin
npm run dev                 # http://localhost:4000/api/v1
```

## Accounts

There are **no demo users**. The seeder creates master data (departments,
shifts, leave types, holidays…) and exactly one administrator, taken from
configuration rather than source:

```env
BOOTSTRAP_ADMIN_EMAIL=admin@superaip.com
BOOTSTRAP_ADMIN_PASSWORD=<a long random string>
```

Other accounts come from one of two places, both dynamic:

- **Sign up** (`POST /auth/signup`) — open self-registration from the app's
  login screen. The caller picks their own role and is signed straight in.
- **Create User** (`POST /admin/employees`) — an admin adds someone from
  **Employees → Add**, and can set their department, manager and CTC.

> **Signup grants the role the caller asks for.** Anyone with a company address
> can register as an admin and read everyone's payroll. If that isn't wanted,
> the smallest fix is to create signup accounts with `status: 'on_notice'` and
> have `authenticate` refuse them until an admin activates the record.

Self-registered accounts get no department and a placeholder CTC
(`SIGNUP_DEFAULT_CTC`) — a user must not set their own pay — so an admin should
complete the record afterwards.

**Email domain is enforced.** An account may only be created under
`ALLOWED_EMAIL_DOMAIN` (`@superaip.com`); anything else is refused with a
validation message. The check is `endsWith`, so `x@superaip.com.evil.com` fails
too. New accounts get the password in `SEED_PASSWORD` and should change it.

Creating a user also provisions what its modules need: a salary structure,
leave balances for the current financial year, and 30 days of attendance
history so the dashboards aren't blank. All of it lives in one place —
`src/services/provisioning.service.js` — used by both the API and the seeder.

## Scripts

| Script | Does |
|---|---|
| `npm start` | Run the API |
| `npm run dev` | Run with `--watch` |
| `npm run db:migrate` | Create collections + build indexes (`--fresh` drops the database first) |
| `npm run db:seed` | Master data + the one bootstrap admin (clears the collections it writes) |
| `npm run db:reset` | `db:migrate --fresh` + `db:seed` |
| `npm run smoke` | Read-only end-to-end check of every route group — safe to re-run |
| `npm run verify:writes` | Exercises every mutating endpoint. **Not idempotent** — run `npm run db:seed` afterwards |
| `npm run verify:users` | Checks dynamic user creation, the email domain rule and role enforcement |

## Environment

| Var | Default | Notes |
|---|---|---|
| `PORT` | `4000` | Render injects its own |
| `NODE_ENV` | `development` | |
| `API_PREFIX` | `/api/v1` | |
| `MONGODB_URI` | — | **Required.** Atlas SRV string, database in the path |
| `MONGODB_DB` | — | Optional override of the database in the URI |
| `DNS_SERVERS` | — | See *Local DNS* below. Leave empty on Linux/Render |
| `JWT_SECRET` | — | **Required.** Long random string |
| `JWT_EXPIRES_IN` | `1d` | Access token TTL |
| `REFRESH_TOKEN_EXPIRES_IN_DAYS` | `30` | |
| `SEED_PASSWORD` | `demo@1234` | Default password for accounts created in the app |
| `ALLOWED_EMAIL_DOMAIN` | `@superaip.com` | The only domain an account may be created under |
| `BOOTSTRAP_ADMIN_EMAIL` | — | **Required by the seeder.** The one pre-existing account |
| `BOOTSTRAP_ADMIN_PASSWORD` | — | **Required by the seeder.** Minimum 8 characters |
| `BOOTSTRAP_ADMIN_NAME` | `System Administrator` | |
| `AUTH_RATE_LIMIT` | `50` | Sign-in attempts per IP per 15 minutes |

### Local DNS

`mongodb+srv://` needs an SRV lookup, and Node's bundled resolver refuses it on
some Windows/router setups — you get `querySrv ECONNREFUSED` even though the
cluster is reachable and `nslookup` resolves it fine. Set:

```env
DNS_SERVERS=8.8.8.8,1.1.1.1
```

`src/config/db.js` applies this with `dns.setServers()` before connecting. It's a
local-machine workaround; leave it empty in production.

## API

All routes are under `API_PREFIX` and need `Authorization: Bearer <token>`
except `/auth/signup`, `/auth/login`, `/auth/refresh` and the health endpoints.

| Group | Endpoints |
|---|---|
| `/auth` | `POST /signup` · `POST /login` · `POST /refresh` · `POST /logout` · `GET /me` · `POST /change-password` |
| `/attendance` | `GET /today` · `POST /punch-in` · `POST /punch-out` · `GET /log` · `GET /summary` · `GET /calendar` · `GET,POST /regularizations` |
| `/leave` | `GET /types` · `GET /balances` · `GET,POST /requests` · `POST /requests/:id/cancel` |
| `/payroll` | `GET /payslips` · `GET /payslips/:id` · `GET /ytd` |
| `/team` | `GET /members` · `GET /members/:id` · `GET /stats` · `GET /trend` |
| `/approvals` | `GET /summary` · `GET,POST /leave` · `POST /leave/bulk-approve` · `GET,POST /expenses` · `GET,POST /regularizations` |
| `/admin` | `GET /overview` · `GET,POST /employees` · `PATCH /employees/:id` · `GET /payroll/runs` · `POST /payroll/run` · `POST /payroll/runs/:id/publish` · `POST /payroll/runs/:id/unlock` · `POST,DELETE /announcements` · `GET /reports/{attendance,leave-balances,payroll-trend}` |
| root | `GET /expenses` · `POST /expenses` · `GET /expenses/categories` · `GET /tasks` · `PATCH /tasks/:id` · `GET /holidays` · `GET /announcements` · `GET /notifications` · `PATCH /notifications/:id/read` · `POST /notifications/read-all` · `GET /directory` · `GET /departments` |
| — | `GET /health` readiness (503 if MongoDB is down) · `GET /health/live` liveness — both outside the prefix |

Role guards live in `src/middleware/auth.js`: `/approvals` needs manager,
`/admin` needs admin, admin passes every guard. Managers only ever see their own
direct reports; admins see the whole org.

## Data model

22 collections, one per former SQL table, with `payslip_components` embedded into
`payslips` (they're only ever read with their slip).

Three conventions worth knowing:

- **Calendar dates are `YYYY-MM-DD` strings**, clock times are `HH:mm:ss`
  strings — not `Date`. ISO strings sort and range-compare correctly with
  `$gte`/`$lte`, the API returns exactly what it always did, and no timezone can
  shift a punch onto the wrong day. Real `Date` is used only for true instants
  (`createdAt`, `actionOn`, `publishedAt`).
- **Ids are ObjectId strings**, exposed as `id`. The MySQL build returned
  integers, so any client that stored ids needs to treat them as opaque strings.
- **Business codes come from a `counters` collection** (`$inc`, atomic) instead
  of `SELECT COUNT(*) + offset`, which handed two concurrent requests the same
  number. Bases live in `src/services/sequence.service.js`.

Uniqueness that SQL enforced with `UNIQUE KEY` is now enforced by unique indexes
— `employees.email`, `employees.empCode`, `(attendance.employeeId, workDate)`,
`(payslips.payrollRunId, employeeId)`, `(payrollRuns.payMonth, payYear)` and the
request codes. `npm run db:migrate` builds them; refresh tokens also get a TTL
index so Mongo expires them without a cleanup job.

Multi-document writes (leave approval, payroll run, employee creation) run in
transactions via `withTransaction()`. These need a replica set — Atlas is one. On
a standalone `mongod` the helper warns once and falls back to unbatched writes.

## Layout

```
src/
├─ server.js          entry point — listen + graceful shutdown
├─ app.js             express wiring, helmet/cors/rate-limit, route mounting
├─ config/            env.js (validated config), db.js (connection + transactions)
├─ models/            mongoose schemas, one file per domain
├─ db/                migrate.js (indexes), seed.js (masters + bootstrap admin)
├─ middleware/        auth.js (JWT + role guards), error.js
├─ routes/            one file per module
├─ services/          provisioning (the one way an account is made), employee,
│                     payroll and sequence logic shared across routes
└─ utils/             ApiError, asyncHandler, date/response helpers
scripts/              _fixtures.js, smoke.js, verify-writes.js, verify-users.js
```

## Docker

```bash
docker compose up --build          # reads .env, serves on :4000
```

Or without compose:

```bash
docker build -t hr-backend .
docker run --rm -p 4000:4000 --env-file .env -e DNS_SERVERS= hr-backend
```

`-e DNS_SERVERS=` is worth keeping: container DNS resolves SRV records fine, and
the Windows-only workaround in `.env` shouldn't follow the app into the image
(`docker-compose.yml` clears it for you).

The image is `node:22-alpine`, multi-stage so only production `node_modules`
ship, runs as the unprivileged `node` user, and uses `tini` as PID 1 so
`docker stop` reaches the `SIGTERM` handler in `src/server.js`. Its `HEALTHCHECK`
hits `/health/live`, not `/health` — a readiness probe would mark the container
unhealthy and restart it every time MongoDB blipped.

`.dockerignore` keeps `.env` and the host's `node_modules` out of the image;
don't remove those two lines.

One-off commands against the same image:

```bash
# These talk to Atlas directly, so a throwaway container is fine.
docker compose run --rm api npm run db:migrate
docker compose run --rm api npm run db:seed

# The smoke test talks to the API over HTTP — run it inside the live container,
# where localhost:4000 is the server.
docker compose exec api npm run smoke
```

## Deploy — Render + MongoDB Atlas

`render.yaml` is a Render Blueprint.

**1 — Atlas**

Create a free M0 cluster. Under *Database Access* add a user; under *Network
Access* allow Render's egress (or `0.0.0.0/0` if you accept the exposure). Copy
the connection string and put the database name in the path:

```
mongodb+srv://<user>:<password>@<cluster>.mongodb.net/hrmh?retryWrites=true&w=majority
```

**2 — Load the data (from your machine)**

```bash
npm run db:migrate
npm run db:seed     # needs BOOTSTRAP_ADMIN_EMAIL / _PASSWORD set
```

**3 — Render**

New → **Blueprint** → pick this repo. Render reads `render.yaml` and prompts for
`MONGODB_URI`; `JWT_SECRET` is generated automatically — **don't** reuse your
local one.

Health check is `/health/live`. Hit `/health` yourself to confirm the database
leg: it returns `{"status":"ok","database":"up"}` when Atlas is wired up.

**Free-tier caveats**

- Render free spins down after ~15 min idle — the first request then takes ~50s.
- Atlas M0 is shared and capped at 512 MB.
- Fine for demos, not for production payroll data.

Any other Node host works too — set the env vars above and run `npm ci && npm start`.
`src/server.js` binds the port before connecting to MongoDB so health checks pass
during a cold start, and handles `SIGTERM` for clean restarts.

## Not built yet

- File upload for expense receipts / leave attachments (`receiptPath` and
  `attachmentPath` fields exist but no multipart route)
- Forgot / reset password
- CSV report export
- Masters CRUD (departments, shifts, locations, leave types)

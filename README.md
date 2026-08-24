# CaliBet Platform Skeleton

This is a production-oriented Node.js + PostgreSQL skeleton for your authorized integration platform.

## Tech Stack

- Node.js 20+
- NestJS 10
- PostgreSQL 16
- Prisma ORM
- Redis (session and queue cache)

## Project Structure

- `apps/api`: backend API service
- `infra`: deployment-related notes and placeholders
- `docs`: architecture and implementation documents

## Quick Start

1. Start infrastructure:
   - `docker compose up -d`
2. Go to API folder:
   - `cd apps/api`
3. Copy environment file:
   - `cp .env.example .env`
4. Install dependencies:
   - `npm install`
5. Generate Prisma client:
   - `npm run prisma:generate`
6. Run migrations:
   - `npm run prisma:migrate`
7. Start development server:
   - `npm run start:dev`

## Worker Quick Start

1. Go to worker folder:
   - `cd apps/worker`
2. Copy environment file:
   - `cp .env.example .env`
3. Install dependencies:
   - `npm install`
4. Start worker:
   - `npm run start:dev`

## Website Entry and Vercel Static Upload

The browser site source lives in `apps/api/public`. Edit the files there only.

After editing files in `apps/api/public`, run `npm run build` from the repository root to regenerate `public`.

For Vercel, deploy this repository with the included `vercel.json`. Vercel runs `npm run build` and serves the generated `public/index.html`. Root-level website copies are intentionally not tracked, so there is only one source of truth.

Note: the static site still needs the API, worker, PostgreSQL, LiveKit, and environment variables running for login and remote control to work.

## One-Click Local Startup (Windows)

Use the scripts in [scripts/restart-all.ps1](scripts/restart-all.ps1) and [scripts/stop-all.ps1](scripts/stop-all.ps1):

1. Start everything:
   - `powershell -ExecutionPolicy Bypass -File scripts/restart-all.ps1`
2. Stop everything:
   - `powershell -ExecutionPolicy Bypass -File scripts/stop-all.ps1`

`restart-all.ps1` will:
- start PostgreSQL and Redis containers,
- prepare `.env` files if missing,
- generate Prisma client and deploy migrations,
- build API and worker,
- start API (`4000`) and worker (`4300`),
- wait until health endpoints respond.

## Bridge and Signaling Endpoints

- `POST /api/v1/bridge/sessions/start`
- `GET /api/v1/bridge/sessions/:bridgeSessionId`
- `POST /api/v1/bridge/sessions/:bridgeSessionId/signal/offer`
- `POST /api/v1/bridge/sessions/:bridgeSessionId/signal/answer`
- `POST /api/v1/bridge/sessions/:bridgeSessionId/signal/candidate`
- `GET /api/v1/bridge/sessions/:bridgeSessionId/signal/poll?afterId=0`
- `GET /api/v1/bridge/sessions/:bridgeSessionId/frame`
- `POST /api/v1/bridge/sessions/:bridgeSessionId/input`

## Viewer Page

- Open `http://localhost:4000/viewer.html` after API startup.
- Login with platform credentials.
- Start bridge session and verify remote screen refresh.
- Click on the screen and use keyboard input to send remote controls.

## Compliance Logging Model

- Raw action logs are immutable and source-truth.
- Adjustments are editable records with full version history.
- Every adjustment keeps operator, reason, and timestamp.

## Next Build Targets

- External browser worker service for 1:1 session rendering.
- Secure token handoff between platform session and worker session.
- Admin console for adjustment workflow and audit views.

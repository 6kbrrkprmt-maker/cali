# Implementation Phases

## Phase 1 - Foundation

- Build user auth and RBAC.
- Build immutable raw log write path.
- Build adjustment APIs and versioning.
- Enable PostgreSQL migration pipeline.

## Phase 2 - External Session Integration

- Add session orchestrator service.
- Implement external login flow with robust retries.
- Persist session lifecycle events.

## Phase 3 - Browser Worker Integration

- Add Playwright worker pool on Linux.
- Bind frontend user sessions to worker sessions.
- Capture action events and map to raw logs.

## Phase 4 - Hardening

- Add MFA for operators and admins.
- Add anomaly alerts for login/session failures.
- Add audit export endpoints and retention policies.

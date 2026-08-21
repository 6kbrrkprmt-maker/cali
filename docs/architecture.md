# Architecture Overview

## Core Services

1. API Gateway (NestJS)
- User auth, RBAC, admin APIs, immutable log write pipeline.

2. Session Orchestrator
- Manages external website login sessions and refresh strategy.
- Issues internal short-lived session tokens for frontend.

3. Browser Worker Pool
- One isolated browser context per user session.
- Renders and controls the authorized external site in near 1:1 mode.

4. Audit and Adjustment Service
- Writes raw logs as append-only.
- Stores editable adjustment records and version history.

## Data Rules

- Raw action records are immutable by policy and schema ownership.
- Any business correction is stored as an adjustment row.
- Every adjustment mutation creates a version row.

## Security Baseline

- Never store external credentials in plaintext.
- Store token hashes and encrypted secret material only.
- Enforce operator MFA for adjustment actions.
- Keep per-action trace IDs for legal and operational auditing.

## Scaling for Under 100 Concurrent Users

- 2 API instances behind Nginx.
- 2-4 browser worker instances.
- Single PostgreSQL primary with daily backups.
- Redis for short-lived state and queue metadata.

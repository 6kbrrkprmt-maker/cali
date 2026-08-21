# Bridge and Worker Flow

## API Side

1. User logs in to platform and gets JWT.
2. Frontend calls POST /api/v1/bridge/sessions/start with JWT.
3. API creates BridgeSession row and mints a short-lived view token.
4. API calls worker internal endpoint to create worker session.
5. API updates BridgeSession as ACTIVE and returns bridgeSessionId and workerSessionId.

## Worker Side

1. Worker verifies shared key from API.
2. Worker launches a browser context and opens the authorized external URL.
3. Worker returns workerSessionId and start timestamp.
4. Worker stores session metadata for future action and stream modules.

## Current Scope in This Skeleton

- Authentication and RBAC are active.
- Bridge session creation and status query are active.
- Worker bootstrap and internal session creation are active.
- Streaming and action relay are intentionally pending for the next phase.

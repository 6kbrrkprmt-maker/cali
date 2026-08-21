# Production Notes (Linux)

## Recommended Baseline

- OS: Ubuntu 24.04 LTS
- CPU: 8 vCPU
- RAM: 16 GB
- Disk: 200 GB NVMe

## Runtime

- Node.js 20 LTS
- PostgreSQL 16
- Redis 7
- Nginx (TLS termination)

## Minimal Rollout

1. API service as systemd service or container.
2. Browser worker service as separate deployment unit.
3. PostgreSQL backup every day, retain 14-30 days.
4. Centralized logs with request and trace IDs.

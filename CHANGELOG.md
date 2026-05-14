# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [0.3.0] - 2026-05-12

### Added
- Jira integration module (`src/modules/jira/`): OAuth 2.0 (3LO) connect/disconnect flow, connection status endpoint, and a caller-agnostic `syncForUser(userId, dateStart, dateEnd)` that imports the user's Jira activity (comments, transitions, worklogs) into `DailyActivity` with `source='jira'`
  - Endpoints: `GET /api/jira/auth`, `GET /api/jira/auth/callback`, `GET /api/jira/status`, `DELETE /api/jira/connection`, `POST /api/jira/sync`
  - `jira.client.js` HTTP adapter over native `fetch` with timeout (`AbortController`), retry/backoff on 429/5xx, and refresh-token rotation
  - `jira.mapper.js` pure Atlassian → `DailyActivity` transformations with deterministic `externalId` for idempotency
  - Typed errors (`jira.errors.js`) mapped to HTTP status codes by the global error handler
- Prisma migration `20260512120000_add_jira_integration`: Jira credential fields + `jiraReconnectRequired`/`jiraLastSyncAt` on `User`, new `JiraOAuthState` table (one-shot CSRF `state` with 10‑min TTL), `external_id` column + `@@unique([userId, source, externalId])` + `@@index([userId, source, startTime])` on `DailyActivity`
- Environment variables: `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_REDIRECT_URI`, `JIRA_SCOPES`, `JIRA_REQUEST_TIMEOUT_MS`, `JIRA_SYNC_MAX_WINDOW_HOURS`, `FRONTEND_BASE_URL` (documented in `.env.example`)
- Jest tests for the Jira service, client, mapper, and controller

### Changed
- `src/app.js` mounts the Jira routes under `/api/jira`

## [0.2.0] - 2026-05-02

### Added
- Express app setup with `src/app.js` and `src/server.js` (singleton pattern, graceful shutdown on SIGINT/SIGTERM)
- Modular project structure under `src/modules/` with scaffolded stubs for admin, ai, auth, google, and reports modules
- Prisma ORM with PostgreSQL: schema defining `User`, `DailyActivity`, and `Report` models with enums `Role` and `ReportStatus`
- Initial database migration (`20260430214657_init`) and seed script with sample employee data
- Shared middleware: `requestLogger` (HTTP access logging, skips `/health`) and `errorHandler` (4xx → warn, 5xx → error, hides internal details from clients)
- CRLF log-injection sanitization utility (`src/shared/utils/sanitize.js`) applied across all middleware logging
- Winston logger with colorized console transport and rotating JSON file transports for `error.log` and `combined.log`
- Jest test suite covering `errorHandler`, `requestLogger`, and `sanitizeForLog`
- Dockerfile using `node:20-slim` with non-root `node` user
- Docker Compose with `app` and `postgres:15` services
- CodeQL workflow for JavaScript/TypeScript security analysis on push and pull requests to `main`/`develop`
- PR description template (`.github/pull_request_template.md`)
- ESLint and Prettier configuration
- `.dockerignore` and `.env.example`

### Changed
- CI workflow updated to run from the repository root (removed `backend/` working-directory prefix)
- Security workflow refactored to install and run gitleaks binary locally instead of using the cloud-licensed action

## [0.1.1] - 2026-04-18

### Added
- Add develop branch

### Removed
- CI check till we have Node configured

### Changed
- Refactor security workflow so that github leaks uses binary local engine and not the cloud licence one.

## [0.1.0] - 2026-04-10

### Added
- Github initial configuration for github rules

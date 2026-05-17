# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [0.3.0] - 2026-05-17

### Added
- Google OAuth authentication flow: `signInWithGoogle` and `signUpWithGoogle` in `auth.service.js`, issuing JWT access tokens on success
- JWT-based access tokens (`jsonwebtoken`) for authenticated sessions
- Encrypted refresh token storage: AES encrypt/decrypt utilities in `src/shared/utils/crypto.js` applied when persisting refresh tokens via `upsertGoogleUser`
- Role assignment with validation key: first-user bootstrap assigns `ADMIN` role when a shared key is provided; subsequent users receive `EMPLOYEE`
- `requireRole` middleware for role-based route protection
- `authMiddleware` for JWT verification on protected routes (`src/shared/middleware/authMiddleware.js`)
- `authErrorHandler` middleware for structured authentication/authorization error responses
- Users module: `src/modules/users/users.service.js` and `src/modules/users/users.routes.js`
- Rate limiting middleware (`src/shared/middleware/rateLimiter.js`) applied to public endpoints and user routes
- ADR-002: Modular monolith architecture decision record (`docs/adr/ADR-002-arquitectura-monolito-modular.md`)
- ADR-003: Adapter pattern for AI integration decision record (`docs/adr/ADR-003-adapter-pattern-ia.md`)
- Comprehensive test suite: `auth.controller.test.js`, `auth.service.test.js`, `google.service.test.js`, `users.service.test.js`, `authMiddleware.test.js`, `authErrorHandler.test.js`, `rateLimiter.test.js`, `requireRole.test.js`, `crypto.test.js`
- `.gitleaksignore` to suppress false-positive secret detection on test-only keys

### Changed
- User service refactored: aligned `fullName` field with database schema, added `client_id` validation, improved sanitized logging and error stack propagation
- Crypto utility refactored to use arrow functions; `.env.example` updated with new required variables (`JWT_SECRET`, `REFRESH_TOKEN_KEY`, `ADMIN_ROLE_KEY`)
- ESLint configuration updated to include all global Node.js packages
- Google service moved to `src/modules/google/` and users service moved to `src/modules/users/`

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

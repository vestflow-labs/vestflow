# Highlights

- Added local Git hooks so commits and pushes are guarded by linting and tests.
- Configured Husky and lint-staged to auto-fix formatting and lint issues on staged TypeScript files.
- Added a pre-push test gate that runs the Vitest suite before pushes are allowed.
- Introduced ESLint and Prettier configuration so the new hooks work consistently in local development.

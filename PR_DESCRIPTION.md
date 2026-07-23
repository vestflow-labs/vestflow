# Git hooks for local linting and test enforcement

## Summary

This PR adds local Git hook automation to catch formatting and lint issues before they reach CI, and to block pushes when the test suite fails.

## What changed

- Added Husky-based pre-commit hooks that run lint-staged on staged TypeScript files.
- Configured lint-staged to run ESLint auto-fix and Prettier on staged files, then re-stage any fixes.
- Added a pre-push hook that runs the Vitest suite with `--passWithNoTests` before a push is allowed.
- Added ESLint and Prettier configuration so the hooks work consistently across contributors.

## Files added/updated

- [.husky/pre-commit](.husky/pre-commit)
- [.husky/pre-push](.husky/pre-push)
- [package.json](package.json)
- [package-lock.json](package-lock.json)
- [eslint.config.mjs](eslint.config.mjs)
- [.prettierrc.json](.prettierrc.json)
- [HIGHLIGHT.md](HIGHLIGHT.md)

## Verification

- `npm install` completed successfully and installed the hook tooling.
- `npm test -- --passWithNoTests` passed with 19 tests passing.

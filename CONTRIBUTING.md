# Contributing to VestFlow

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Table of Contents

- [Branch Naming](#branch-naming)
- [Commit Message Convention](#commit-message-convention)
- [Running Tests](#running-tests)
- [Pull Request Process](#pull-request-process)
- [Issue Guidelines](#issue-guidelines)
- [Review Process](#review-process)

---

## Branch Naming

Use the following patterns depending on the type of change:

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feat/<short-description>` | `feat/add-revoke-schedule` |
| Bug fix | `fix/<short-description>` | `fix/claimable-amount-overflow` |
| Documentation | `docs/<short-description>` | `docs/add-contributing-guide` |
| Chore / tooling | `chore/<short-description>` | `chore/upgrade-stellar-sdk` |
| Multiple issues | `issues/<issue-numbers>` | `issues/100-104-115-117` |

Keep branch names lowercase and hyphenated. Avoid generic names like `patch` or `update`.

---

## Commit Message Convention

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification.

```
<type>(<scope>): <short summary>

[optional body]

[optional footer — closes issues]
```

**Types:** `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`

**Examples:**

```
feat(contract): add revoke schedule entry point

fix(sdk): correct claimable amount calculation for cliff schedules

docs: add local dev quickstart with soroban-cli

Closes #100
```

To close a GitHub issue automatically on merge, add `Closes #<issue-number>` in the commit footer or PR description.

---

## Running Tests

Install dependencies first:

```bash
npm install
```

Run the full test suite:

```bash
npm test
```

Run tests in watch mode during development:

```bash
npm run test:watch
```

Lint the codebase:

```bash
npm run lint
```

Type-check without emitting:

```bash
npm run type-check
```

All tests and lint checks must pass before a PR can be merged.

---

## Pull Request Process

1. Fork the repository and create your branch off `main` following the [branch naming](#branch-naming) convention.
2. Make your changes with clear, focused commits.
3. Ensure `npm test` and `npm run lint` pass locally.
4. Open a PR against `main` and fill in the pull request template completely.
5. Reference the related issue(s) in the PR description using `Closes #<issue-number>`.
6. Keep PRs focused — one concern per PR makes review faster.
7. Do not include AI-generated artifact files (e.g. `agent.md`, `claude.md`, `.kiro/`) in your commits.

---

## Issue Guidelines

Before opening a new issue:

- Search existing issues to avoid duplicates.
- Use the provided issue templates where available.

When writing an issue:

- **Title:** concise and specific — describe the problem or feature, not the solution.
- **Body:** include context, reproduction steps (for bugs), or acceptance criteria (for features).
- **Labels:** apply relevant labels (`bug`, `enhancement`, `documentation`, etc.).

---

## Review Process

- At least **one maintainer approval** is required before merging.
- Reviewers will look at correctness, test coverage, code style, and documentation.
- Address review comments with new commits — do not force-push during an open review unless asked.
- Once approved, the PR author merges (squash merge preferred for feature branches).
- The branch is deleted after merge.

---

## Questions?

Open a [discussion](../../discussions) or reach out in the project's community channels.

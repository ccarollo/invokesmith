# Contributing to InvokeSmith

InvokeSmith is an early developer preview. The most useful contributions make a consequential action easier to specify, harder to mis-execute, or simpler to verify with authoritative evidence.

## Before opening a pull request

1. Open an issue describing the unsafe or ambiguous behavior you want to address.
2. Include a minimal action contract or sanitized failure example when possible.
3. Keep application authority intact: a policy permit must never bypass owner, tenant, scope, or business-rule checks in the application.
4. Avoid expanding the public contract for hypothetical platforms without a concrete action that needs it.

## Development

```sh
bun install
bun run check
bun test
bun run package:check
bun run generate:examples
bun run test:outcomes
```

Generated output is reviewable source. If a compiler change modifies `generated/`, include those changes and explain any semantic-loss differences.

## Pull request expectations

- Add or update tests for behavior changes.
- Keep deterministic output deterministic across runs.
- Use stable diagnostic codes for user-actionable failures.
- Preserve minimized observations; do not place raw customer state in evidence artifacts.
- Update the relevant guide and example when changing a public interface.
- Confirm `bun run check` and `bun test` pass.
- If the CLI or package metadata changes, confirm `bun run package:check` passes. It builds the exact npm tarball, installs it in an isolated temporary project, and runs the packaged CLI under Node.js.

By contributing, you agree that your contribution is licensed under Apache-2.0.
Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

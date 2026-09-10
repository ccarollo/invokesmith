# Deterministic outcome testing

InvokeSmith turns contract scenarios into executable proofs. The public seam is the CLI; the TypeScript
packages behind it are versioned integration seams for providers and evidence consumers.

## Commands

Inspect a stable plan:

```sh
bun run packages/cli/src/index.ts scenario compile examples/smithtasks/search-tasks.json
bun run packages/cli/src/index.ts scenario compile examples/smithtasks/search-tasks.json --json
```

Run all authored and contract-generated SmithTasks outcomes:

```sh
bun run test:outcomes
```

The command discovers the contracted tool, measures the negotiated target identity, runs isolated fixtures through the generated MCP server, observes authoritative state before
and after, writes `.invokesmith/outcome-evidence.json`, and prints a reproduction command for failures.
Exit `0` means every outcome passed, `1` means InvokeSmith verified a product/action/assertion failure, `2`
means invalid CLI or contract configuration, and `3` means the harness, environment, target, or provider
could not establish a trustworthy outcome.

For a repeatable diagnostic demonstration, add one of:
`--demo-defect wrong-response`, `wrong-state`, `extra-mutation`, `missing-audit`, or `provider-failure`.
These switches are test fixtures, not production target mutation features.

## Observation trust boundary

An observation request uses `invokesmith.observation-provider/v0alpha1` and declares only the fact IDs and
paths required by the plan. A response must identify the provider and phase, use `redaction: minimized`,
and return exactly those fact IDs. Undeclared facts are rejected as potential leakage.

The built-in SmithTasks JSON provider is a reference implementation. Customers can keep observation
inside their environment with either:

- `HookObservationProvider`, wrapping a TypeScript function with timeout, exception, validation, and
  leakage controls; see `examples/observation-providers/smithtasks-hook.ts`.
- `HttpObservationProvider`, posting the versioned request to a customer service with optional headers
  and a timeout. Authentication failures, timeouts, provider errors, malformed data, and network failures
  have distinct codes. A local server is in `examples/observation-providers/http-server.ts`.

Never place bearer tokens in a contract or checked-in configuration. Supply authorization headers from
the execution environment or secret manager.

## Evidence format

`invokesmith.evidence-manifest/v0alpha1` records contract, action, scenario-plan, fixture, measured implementation,
target, runtime, and observation-provider identities. Each assertion retains its classification, source,
result, and minimized-redaction marker. The manifest digest is SHA-256 over canonical JSON excluding the
digest field itself, so `verifyEvidenceManifest` can detect modification.

Raw authoritative state and action inputs are deliberately absent. Runtime-dependent fields must be
declared before the format advances beyond alpha; equivalent runs on the same implementation produce
the same manifest identity.

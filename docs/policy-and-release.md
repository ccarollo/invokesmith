# Policy, local authorization, and release decisions

InvokeSmith turns a proven action contract into a portable runtime policy and an offline-verifiable release
decision. It does not create a gateway or replace the application's own authorization checks.

## Trust boundaries

The reference flow has three deliberately separate decisions:

1. The local AuthZEN Policy Decision Point evaluates the compiled policy.
2. The enforcement point refuses missing, mismatched, denied, or unavailable policy context.
3. SmithTasks remains the final authority for scope, ownership, tenant, state, and mutation rules.

A policy permit therefore cannot grant access that SmithTasks itself would reject. Protected writes fail
closed when the local decision service is unavailable. Read actions can use `allow_read_only` only when
that risk posture is explicitly compiled into the policy.

## Policy IR v0alpha1

Each policy binds the exact contract, implementation, evidence manifest, and release. Its digest covers
all protected obligations. Each obligation has one of six dispositions:

- `native`: evaluated directly through ordinary AuthZEN subject/action/resource/context information;
- `generated`: context or adapter behavior generated from the contract;
- `application`: still enforced by the business application;
- `gateway`: enforced by a PEP or gateway extension;
- `verified_only`: established by outcome or post-execution evidence;
- `unsupported`: a semantic loss that blocks compilation unless an attributable exception is supplied.

Policy compilation is deterministic. Known weakening overrides produce stable `CS-POLICY-*`
diagnostics; they are never silently accepted. Compilation also requires every authored scenario and
generated retry, conflict, and confirmation case to pass on the exact implementation and environment
named by the policy.

## AuthZEN compatibility

The local service implements the final OpenID AuthZEN Authorization API 1.0 access-evaluation shape at
`POST /access/v1/evaluation`: a request has `subject`, `action`, `resource`, and optional `context`; the
response has a required boolean `decision` and optional `context`.

InvokeSmith does not turn approval into a third AuthZEN decision value. Approval-required remains a
standard denial (`decision: false`) with namespaced `context.invokesmith.decision` metadata. Confirmation,
idempotency, and policy/release identity are also namespaced under `context.invokesmith`. See the
[final Authorization API 1.0 specification](https://openid.net/specs/authorization-api-1_0.html).

Start the customer-side example after compiling a policy:

```sh
INVOKESMITH_POLICY=.invokesmith/reschedule.policy.json bun run examples/authzen/server.ts
curl -sS http://localhost:8787/access/v1/evaluation \
  -H 'content-type: application/json' \
  --data @examples/authzen/reschedule-request.json
```

The reference server reads a local policy and has no synchronous InvokeSmith Cloud dependency.

## End-to-end CLI example

Generate release-bound evidence and compile policy:

```sh
bun run packages/cli/src/index.ts test --outcome \
  --server generated/smithtasks-mcp \
  --release smithtasks-2026.09.1 \
  --environment test \
  --evidence .invokesmith/reschedule.evidence.json \
  examples/smithtasks/reschedule-task.json

bun run packages/cli/src/index.ts policy compile \
  --evidence .invokesmith/reschedule.evidence.json \
  --release smithtasks-2026.09.1 \
  --implementation invokesmith-generated@0.1.0 \
  --environment test \
  --expires 2026-10-01T00:00:00Z \
  --out .invokesmith/reschedule.policy.json \
  examples/smithtasks/reschedule-task.json
```

Evaluate a request without starting an HTTP server:

```sh
bun run packages/cli/src/index.ts authzen evaluate \
  --policy .invokesmith/reschedule.policy.json \
  --request examples/authzen/reschedule-request.json --json
```

## Signing and lifecycle

Signatures use Ed25519 and include an explicit manifest version, artifact type, algorithm, key ID, and
payload digest. Private key bytes are never included in a signed artifact. Verification is offline and
distinguishes modified content, invalid signatures, wrong keys, and unsupported versions.

```sh
bun run packages/cli/src/index.ts artifact sign --type policy \
  --key release-private.pem --key-id release-key-2026-09 \
  --out .invokesmith/reschedule.policy.signed.json \
  .invokesmith/reschedule.policy.json

bun run packages/cli/src/index.ts artifact sign --type evidence \
  --key release-private.pem --key-id release-key-2026-09 \
  --out .invokesmith/reschedule.evidence.signed.json \
  .invokesmith/reschedule.evidence.json

bun run packages/cli/src/index.ts artifact verify --key release-public.pem \
  .invokesmith/reschedule.policy.signed.json --json
```

A wrong key, altered payload, or invalid signature exits nonzero with a stable diagnostic. For example,
the following reports `CS-SIGN-INVALID`:

```sh
bun run packages/cli/src/index.ts artifact verify --key wrong-public.pem \
  .invokesmith/reschedule.policy.signed.json --json
```

`policy status` additionally detects stale contract or release identities, expiry, revocation,
replacement, modification, and invalid signatures. Revocation and replacement registries are local
inputs to the library API; no hosted lookup is required.

Inspect or persist the verified status with:

```sh
bun run packages/cli/src/index.ts policy status \
  --key release-public.pem --now 2026-09-09T12:00:00Z \
  --contract-digest <current-contract-digest> \
  --release-digest <current-release-digest> \
  --out .invokesmith/reschedule.policy-status.json \
  .invokesmith/reschedule.policy.signed.json --json
```

## Release gate

The initial gate requires structural, security, and outcome evidence. It blocks invalid manifests,
failed assertions, missing evidence classes, stale policy, and source-identity mismatches. An approval
binds the contract, implementation, policy, evidence, release, environments, approver, and decision
time.

`release decide` requires `--now` and `--decided-at` to be the same instant, preventing an approval
from being recorded after the lifecycle check it relies on.

```sh
bun run packages/cli/src/index.ts release decide \
  --policy .invokesmith/reschedule.policy.signed.json \
  --evidence .invokesmith/reschedule.evidence.signed.json \
  --key release-public.pem --now 2026-09-09T12:00:00Z \
  --contract-digest <current-contract-digest> \
  --release-digest <current-release-digest> \
  --approved-by security@example.test \
  --decided-at 2026-09-09T12:00:00Z \
  --out .invokesmith/reschedule.release.json --json

bun run packages/cli/src/index.ts artifact sign --type release_decision \
  --key release-private.pem --key-id release-key-2026-09 \
  --out .invokesmith/reschedule.release.signed.json \
  .invokesmith/reschedule.release.json

bun run packages/cli/src/index.ts release verify \
  --policy .invokesmith/reschedule.policy.signed.json \
  --evidence .invokesmith/reschedule.evidence.signed.json \
  --key release-public.pem --now 2026-09-09T12:00:00Z \
  --contract-digest <current-contract-digest> \
  --release-digest <current-release-digest> \
  .invokesmith/reschedule.release.signed.json --json
```

Release creation and verification authenticate both source artifacts, re-evaluate current policy
status, require the complete structural/security/outcome gate, and reproduce the decision before
accepting its signature.

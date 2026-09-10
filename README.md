<p align="center"><img src="assets/invokesmith-mark.svg" width="86" height="86" alt="InvokeSmith spark mark"></p>

# InvokeSmith

**InvokeSmith proves that consequential MCP actions do what they claim before you trust them in production.**

MCP can tell an agent how to call `refund_payment`, `reschedule_task`, or `delete_account`. A successful response does not prove the right record changed, the write happened once, the caller had authority, or the confirmation was valid. InvokeSmith checks the authoritative before-and-after state, generates adversarial cases, emits signed evidence, gates releases, and compiles the same action contract into portable runtime policy.

> Developer preview: the contract format is `invokesmith.dev/v0alpha1`. It is intentionally unstable while real customer actions pressure-test the model.

## Five-minute quick start

You need [Bun](https://bun.sh/) and Node.js 22 or newer.

```sh
git clone https://github.com/ccarollo/invokesmith.git
cd invokesmith
bun install
bun run check
bun run demo:proof
```

The demo runs the public [OutcomeGap OG-001 benchmark](benchmarks/outcome-gap/README.md) against two independently runnable SmithTasks MCP applications:

1. run ordinary response and tool-call checks against a vulnerable application—and pass;
2. expose the application silently rescheduling another tenant's task;
3. detect that unauthorized authoritative-state change and block the release;
4. run the fixed application and emit passing outcome evidence;
5. compile the tested contract into Policy IR;
6. sign the policy, evidence, and release decision, then verify them offline.

Artifacts are written to `.invokesmith/outcome-gap/`. The demo never contacts InvokeSmith or uploads application state.

## What is open source

Everything needed to prove and enforce an action locally is Apache-2.0 licensed:

- the TypeScript action-contract compiler and JSON Schema;
- deterministic scenario and adversarial-case generation;
- authoritative observation providers for JSON files, HTTP, and customer hooks;
- minimized evidence manifests and Ed25519 artifact signing;
- gateway-neutral Policy IR and an AuthZEN-compatible reference PDP;
- the reference SmithTasks policy enforcement point;
- declarative release decisions and offline verification;
- the generated SmithTasks MCP server and all local conformance tests;
- OutcomeGap OG-001, including the real buggy and fixed applications used in the public demonstration.

No account, license key, or hosted control plane is required.

## The contract-to-production loop

```text
Action contract
      │
      ├── compile ──→ MCP tool + semantic-loss report
      │
      ├── test ─────→ real invocation + private before/after observations
      │                          │
      │                          └──→ minimized signed evidence ──→ release gate
      │
      └── govern ───→ Policy IR ──→ PDP / gateway ──→ application-owned PEP
```

The application remains the final authority. A gateway permit never bypasses tenant, owner, scope, or business-rule checks inside the application.

Explore the [interactive architecture map](docs/invokesmith-technology-map.html), the [outcome-testing guide](docs/outcome-testing.md), and the [policy and release guide](docs/policy-and-release.md).

## Common commands

```sh
# Validate and inspect a contract
bun run packages/cli/src/index.ts validate examples/smithtasks/reschedule-task.json
bun run packages/cli/src/index.ts scenario compile examples/smithtasks/reschedule-task.json

# Generate the reviewable MCP target
bun run generate:examples

# Run the full local outcome suite and emit evidence
bun run test:outcomes

# Reproduce the complete public benchmark
bun run benchmark:outcome-gap

# Build the standalone Node.js CLI
bun run build
node dist/invokesmith.js help
```

Run the reference MCP server directly with `bun run start:demo`. See the [SmithTasks guide](examples/smithtasks/README.md) for identity, scopes, persistence, and confirmation behavior.

## Repository map

| Path | Responsibility |
| --- | --- |
| `packages/contract` | Public action types and JSON Schema |
| `packages/compiler` | Validation, canonicalization, hashing, and typed IR |
| `packages/testplan` | Deterministic scenarios and authoritative outcome runner |
| `packages/observations` | Private observation-provider seams |
| `packages/evidence` | Minimized evidence manifests |
| `packages/policy` | Gateway-neutral Policy IR compiler |
| `packages/authzen` | AuthZEN-compatible reference decision service |
| `packages/enforcement` | Application-side reference enforcement point |
| `packages/signing`, `policy-status`, `release` | Artifact trust and release decisions |
| `plugins/target-mcp` | MCP analyzer and generator |
| `examples/smithtasks` | Three synthetic consequential-action contracts |
| `generated/smithtasks-mcp` | Reviewable generated server and conformance tests |
| `benchmarks/outcome-gap` | Real buggy/fixed applications and reproducible outcome-verification benchmark |

## Free tooling and a possible managed product

The local proof engine and reference enforcement stack are the product's open-source foundation. A future managed product may coordinate team evidence history, release approvals, customer-controlled runners, policy lifecycle operations, and audit integrations. Those capabilities are demand-gated; they are not required to use the open-source project and are not promises that every platform compiler will be built.

See the [public roadmap](ROADMAP.md) for the evidence gates that determine what comes next.

## Current limits

InvokeSmith currently targets MCP and reads authored JSON contracts. YAML/OpenAPI import, production OAuth/token validation, managed key storage, remote runners, hosted evidence retention, a production gateway, WebMCP, and non-MCP compilers are outside the current release. We will add a new surface only after partner evidence shows that semantic portability solves a real workflow problem.

OutcomeGap compares InvokeSmith with a defined response-and-tool-call baseline. It does not claim that another system could never detect the same defect if given equivalent authoritative-state access and invariants.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change. Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not a public issue.

Licensed under the [Apache License 2.0](LICENSE).

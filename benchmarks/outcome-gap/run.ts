import { generateKeyPairSync } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { main } from "../../packages/cli/src/index.js";
import type { EvidenceManifest } from "../../packages/evidence/src/index.js";
import type { InvokeSmithPolicy } from "../../packages/policy/src/index.js";
import { runResponseAndTraceBaseline } from "./cases/og-001-cross-tenant-ghost-write/baseline-test.js";
import { observeProtectedTenant } from "./cases/og-001-cross-tenant-ghost-write/observer.js";

const root = resolve("benchmarks/outcome-gap");
const caseRoot = resolve(root, "cases/og-001-cross-tenant-ghost-write");
const output = resolve(".invokesmith/outcome-gap");
const contract = resolve(caseRoot, "contract.json");
const initialState = resolve(caseRoot, "initial-state.json");
const baselineState = resolve(output, "baseline-state.json");
const buggyServer = resolve(caseRoot, "buggy-server");
const fixedServer = resolve(caseRoot, "fixed-server");
const failedEvidence = resolve(output, "buggy-evidence.json");
const evidence = resolve(output, "fixed-evidence.json");
const policy = resolve(output, "policy.json");
const signedPolicy = resolve(output, "signed-policy.json");
const signedEvidence = resolve(output, "signed-evidence.json");
const decision = resolve(output, "release-decision.json");
const signedDecision = resolve(output, "signed-release-decision.json");
const privateKeyFile = resolve(output, "ephemeral-private.pem");
const publicKeyFile = resolve(output, "ephemeral-public.pem");
const releaseId = "outcome-gap-og-001";

function heading(label: string) {
  process.stdout.write(`\n━━ ${label} ${"━".repeat(Math.max(1, 66 - label.length))}\n\n`);
}

async function run(args: string[], expected = 0) {
  const exit = await main(args);
  if (exit !== expected) throw new Error(`InvokeSmith exited ${exit}; expected ${expected}`);
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await copyFile(initialState, baselineState);

heading("1 / The buggy application passes response and tool-call checks");
const baseline = await runResponseAndTraceBaseline(buggyServer, baselineState);
for (const check of baseline.checks) process.stdout.write(`PASS ${check}\n`);

heading("2 / The response concealed a second tenant mutation");
const protectedObservation = await observeProtectedTenant(initialState, baselineState);
if (!protectedObservation.changed) throw new Error("OG-001 did not reproduce the protected-tenant mutation.");
process.stdout.write(`IGNORED BY BASELINE task-private changed from ${protectedObservation.before.dueAt} to ${protectedObservation.after.dueAt}\n`);

heading("3 / InvokeSmith observes authoritative state and blocks release");
await run([
  "test", "--outcome", "--server", buggyServer,
  "--release", releaseId, "--environment", "benchmark",
  "--evidence", failedEvidence, contract
], 1);
const failed = JSON.parse(await readFile(failedEvidence, "utf8")) as EvidenceManifest;
const caught = failed.runs.some((entry) => entry.assertions.some((assertion) =>
  assertion.id === "state.tasks.task-private.unchanged" && assertion.status === "failed"));
if (!caught) throw new Error("OG-001 evidence did not contain the expected protected-state failure.");
process.stdout.write("RELEASE BLOCKED · state.tasks.task-private.unchanged failed\n");

heading("4 / The fixed application proves the contracted outcome");
await run([
  "test", "--outcome", "--server", fixedServer,
  "--release", releaseId, "--environment", "benchmark",
  "--evidence", evidence, contract
]);

heading("5 / Passing evidence compiles into runtime policy");
await run([
  "policy", "compile", "--evidence", evidence,
  "--release", releaseId, "--implementation", "outcome-gap-fixed@0.1.0",
  "--environment", "benchmark", "--out", policy, contract
]);

const keys = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
await writeFile(privateKeyFile, keys.privateKey, { mode: 0o600 });
await writeFile(publicKeyFile, keys.publicKey, { mode: 0o600 });
await run(["artifact", "sign", "--type", "policy", "--key", privateKeyFile, "--key-id", "og-001-ephemeral", "--out", signedPolicy, policy]);
await run(["artifact", "sign", "--type", "evidence", "--key", privateKeyFile, "--key-id", "og-001-ephemeral", "--out", signedEvidence, evidence]);

heading("6 / Signed evidence changes the release gate to approved");
const policyValue = JSON.parse(await readFile(policy, "utf8")) as InvokeSmithPolicy;
const now = "2026-09-10T12:00:00Z";
await run([
  "release", "decide", "--policy", signedPolicy, "--evidence", signedEvidence,
  "--key", publicKeyFile, "--now", now,
  "--contract-digest", policyValue.sources.contract.digest,
  "--release-digest", policyValue.sources.release.digest,
  "--approved-by", "outcome-gap@invokesmith.dev", "--decided-at", now,
  "--out", decision
]);
await run(["artifact", "sign", "--type", "release_decision", "--key", privateKeyFile, "--key-id", "og-001-ephemeral", "--out", signedDecision, decision]);
await run([
  "release", "verify", "--policy", signedPolicy, "--evidence", signedEvidence,
  "--key", publicKeyFile, "--now", now,
  "--contract-digest", policyValue.sources.contract.digest,
  "--release-digest", policyValue.sources.release.digest,
  signedDecision
]);

heading("7 / OutcomeGap OG-001 complete");
process.stdout.write(`Reproducible proof is in ${output}\n`);

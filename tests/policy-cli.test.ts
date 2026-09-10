import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const cli = join(root, "packages/cli/src/index.ts");
const contract = join(root, "examples/smithtasks/reschedule-task.json");

async function run(args: string[]) {
  const child = Bun.spawn([Bun.which("bun")!, "run", cli, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

describe("policy and release CLI", () => {
  test("compiles deterministic policy with human and JSON output and evaluates AuthZEN requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "invokesmith-policy-cli-"));
    try {
      const evidence = join(directory, "evidence.json");
      const policy = join(directory, "policy.json");
      const outcome = await run(["test", "--outcome", "--server", join(root, "generated/smithtasks-mcp"), "--release", "smithtasks-2026.09.1", "--environment", "test", "--evidence", evidence, contract]);
      expect(outcome.exitCode).toBe(0);

      const compiled = await run(["policy", "compile", "--evidence", evidence, "--release", "smithtasks-2026.09.1", "--implementation", "invokesmith-generated@0.1.0", "--environment", "test", "--out", policy, contract, "--json"]);
      expect(compiled.exitCode).toBe(0);
      const output = JSON.parse(compiled.stdout);
      expect(output).toMatchObject({ apiVersion: "invokesmith.policy/v0alpha1", action: { id: "dev.smithtasks.tasks.reschedule" } });
      expect(JSON.parse(await readFile(policy, "utf8"))).toEqual(output);

      const human = await run(["policy", "compile", "--evidence", evidence, "--release", "smithtasks-2026.09.1", "--implementation", "invokesmith-generated@0.1.0", "--environment", "test", contract]);
      expect(human).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("POLICY dev.smithtasks.tasks.reschedule") });

      const request = join(directory, "request.json");
      await writeFile(request, JSON.stringify({
        subject: { type: "user", id: "user-123", properties: { scopes: ["tasks:write"], tenantId: "tenant-demo" } },
        action: { name: "dev.smithtasks.tasks.reschedule" },
        resource: { type: "task", id: "task-123", properties: { ownerId: "user-123", tenantId: "tenant-demo" } },
        context: { invokesmith: { environment: "test", caller: { type: "user", id: "user-123" }, idempotencyKey: "01J7INVOKESMITHDEMO" } }
      }));
      const evaluated = await run(["authzen", "evaluate", "--policy", policy, "--request", request, "--json"]);
      expect(evaluated.exitCode).toBe(0);
      expect(JSON.parse(evaluated.stdout)).toMatchObject({ decision: true, context: { invokesmith: { decision: "allow" } } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("signs, checks lifecycle, makes a release decision, and verifies everything offline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "invokesmith-release-cli-"));
    try {
      const evidence = join(directory, "evidence.json");
      const policy = join(directory, "policy.json");
      const signedPolicy = join(directory, "policy.signed.json");
      const signedEvidence = join(directory, "evidence.signed.json");
      const decision = join(directory, "decision.json");
      const signedDecision = join(directory, "decision.signed.json");
      const statusFile = join(directory, "policy-status.json");
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const privateFile = join(directory, "private.pem");
      const publicFile = join(directory, "public.pem");
      await writeFile(privateFile, privateKey.export({ format: "pem", type: "pkcs8" }));
      await writeFile(publicFile, publicKey.export({ format: "pem", type: "spki" }));
      expect((await run(["test", "--outcome", "--server", join(root, "generated/smithtasks-mcp"), "--release", "smithtasks-2026.09.1", "--environment", "test", "--evidence", evidence, contract])).exitCode).toBe(0);
      expect((await run(["policy", "compile", "--evidence", evidence, "--release", "smithtasks-2026.09.1", "--implementation", "invokesmith-generated@0.1.0", "--environment", "test", "--expires", "2026-10-01T00:00:00Z", "--out", policy, contract])).exitCode).toBe(0);
      expect((await run(["artifact", "sign", "--type", "policy", "--key", privateFile, "--key-id", "release-key", "--out", signedPolicy, policy])).exitCode).toBe(0);
      expect((await run(["artifact", "sign", "--type", "evidence", "--key", privateFile, "--key-id", "release-key", "--out", signedEvidence, evidence])).exitCode).toBe(0);
      expect((await run(["artifact", "verify", "--key", publicFile, signedPolicy, "--json"]))).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('"valid": true') });
      const wrongPublicFile = join(directory, "wrong-public.pem");
      await writeFile(wrongPublicFile, generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }));
      expect((await run(["artifact", "verify", "--key", wrongPublicFile, signedPolicy, "--json"]))).toMatchObject({
        exitCode: 1,
        stdout: expect.stringContaining('"code": "CS-SIGN-INVALID"')
      });

      const policyValue = JSON.parse(await readFile(policy, "utf8"));
      const status = await run(["policy", "status", "--key", publicFile, "--now", "2026-09-09T12:00:00Z", "--contract-digest", policyValue.sources.contract.digest, "--release-digest", policyValue.sources.release.digest, "--out", statusFile, signedPolicy, "--json"]);
      expect(JSON.parse(status.stdout)).toEqual({ valid: true, status: "valid" });

      const decided = await run(["release", "decide", "--policy", signedPolicy, "--evidence", signedEvidence, "--key", publicFile, "--now", "2026-09-09T12:00:00Z", "--contract-digest", policyValue.sources.contract.digest, "--release-digest", policyValue.sources.release.digest, "--approved-by", "security@example.test", "--decided-at", "2026-09-09T12:00:00Z", "--out", decision, "--json"]);
      expect(decided.exitCode).toBe(0);
      expect(JSON.parse(decided.stdout)).toMatchObject({ status: "approved" });
      expect((await run(["artifact", "sign", "--type", "release_decision", "--key", privateFile, "--key-id", "release-key", "--out", signedDecision, decision])).exitCode).toBe(0);
      expect((await run(["artifact", "verify", "--key", publicFile, signedDecision, "--json"]))).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('"valid": true') });
      expect((await run(["release", "verify", "--policy", signedPolicy, "--evidence", signedEvidence, "--key", publicFile, "--now", "2026-09-09T12:00:00Z", "--contract-digest", policyValue.sources.contract.digest, "--release-digest", policyValue.sources.release.digest, signedDecision, "--json"]))).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('"valid": true') });
      expect((await run(["release", "decide", "--policy", signedPolicy, "--evidence", signedEvidence, "--key", publicFile, "--now", "2026-09-09T12:00:00Z", "--contract-digest", policyValue.sources.contract.digest, "--release-digest", policyValue.sources.release.digest, "--approved-by", "security@example.test", "--decided-at", "2026-10-02T00:00:00Z", "--json"])))
        .toMatchObject({ exitCode: 2, stderr: expect.stringContaining("CS-RELEASE-TIME-MISMATCH") });
      expect(JSON.stringify(JSON.parse(await readFile(signedPolicy, "utf8")))).not.toContain("PRIVATE KEY");
      expect(JSON.parse(await readFile(signedEvidence, "utf8"))).toMatchObject({ artifactType: "evidence" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

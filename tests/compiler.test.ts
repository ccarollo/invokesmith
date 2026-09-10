import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { canonicalize, contractDigest, validateActionContract } from "../packages/compiler/src/index.js";

const examples = ["search-tasks", "reschedule-task", "delete-task"];

async function loadExample(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`../examples/smithtasks/${name}.json`, import.meta.url), "utf8")) as unknown;
}

describe("SmithTasks reference contracts", () => {
  for (const name of examples) {
    test(`${name} is valid`, async () => {
      const result = validateActionContract(await loadExample(name));
      expect(result.diagnostics).toEqual([]);
      expect(result.valid).toBe(true);
    });
  }
});

describe("canonical contract representation", () => {
  test("object key order does not change canonical output or digest", () => {
    const left = { z: [3, { b: true, a: null }], a: "InvokeSmith" };
    const right = { a: "InvokeSmith", z: [3, { a: null, b: true }] };

    expect(canonicalize(left)).toBe(canonicalize(right));
    expect(contractDigest(left)).toBe(contractDigest(right));
    expect(contractDigest(left)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("array order remains significant", () => {
    expect(contractDigest(["mcp", "webmcp"])).not.toBe(contractDigest(["webmcp", "mcp"]));
  });

  test("rejects non-JSON objects", () => {
    expect(() => canonicalize({ createdAt: new Date() })).toThrow("non-JSON object");
  });
});

describe("semantic safety", () => {
  test("returns diagnostics rather than throwing for an incomplete nested shape", () => {
    const result = validateActionContract({
      apiVersion: "invokesmith.dev/v0alpha1",
      kind: "Action",
      metadata: { id: "dev.smithtasks.tasks.incomplete", version: "0.1.0", title: "Incomplete" },
      spec: {
        description: "An intentionally incomplete action contract.",
        input: {},
        output: {},
        errors: [],
        authorization: {},
        effects: {},
        confirmation: {},
        idempotency: {},
        audit: {},
        scenarios: []
      }
    });

    expect(result.valid).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(5);
    expect(result.diagnostics.map((entry) => entry.code)).toContain("CS-SCHEMA-001");
  });

  test("rejects a destructive action without confirmation or audit receipt", async () => {
    const contract = structuredClone(await loadExample("delete-task")) as {
      spec: { confirmation: { required: boolean; facts?: string[] }; audit: { receiptRequired: boolean } };
    };
    contract.spec.confirmation.required = false;
    contract.spec.confirmation.facts = [];
    contract.spec.audit.receiptRequired = false;

    const result = validateActionContract(contract);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain("CS-SAFETY-001");
    expect(result.diagnostics.map((entry) => entry.code)).toContain("CS-SAFETY-002");
    expect(result.diagnostics.map((entry) => entry.code)).toContain("CS-AUDIT-001");
  });

  test("rejects read-only combined with destructive", async () => {
    const contract = structuredClone(await loadExample("search-tasks")) as {
      spec: { effects: { classifications: string[] } };
    };
    contract.spec.effects.classifications.push("destructive");

    const result = validateActionContract(contract);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain("CS-EFFECT-004");
  });

  test("rejects a reversible action without compensation", async () => {
    const contract = structuredClone(await loadExample("reschedule-task")) as {
      spec: { effects: { compensationAction?: string } };
    };
    delete contract.spec.effects.compensationAction;

    const result = validateActionContract(contract);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain("CS-REVERSIBILITY-001");
  });
});

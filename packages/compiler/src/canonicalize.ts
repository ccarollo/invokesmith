import { createHash } from "node:crypto";
import type { JsonValue } from "../../contract/src/index.js";

function assertJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`));
    return;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} contains a non-JSON object`);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) throw new TypeError(`${path}.${key} is undefined`);
      assertJsonValue(entry, `${path}.${key}`);
    }
    return;
  }

  throw new TypeError(`${path} contains unsupported value type ${typeof value}`);
}

function serialize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;

  const properties = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(value[key] as JsonValue)}`);
  return `{${properties.join(",")}}`;
}

export function canonicalize(value: unknown): string {
  assertJsonValue(value, "$contract");
  return serialize(value);
}

export function contractDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import contractSchema from "../../contract/schema/invokesmith.action.v0alpha1.schema.json" with { type: "json" };
import { diagnostic, type Diagnostic } from "./diagnostics.js";

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
const validateSchema: ValidateFunction = ajv.compile(contractSchema);
const instanceAjv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });

function pointerToPath(pointer: string): string {
  if (pointer === "") return "$";
  return `$${pointer.split("/").slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((segment) => (/^(0|[1-9][0-9]*)$/.test(segment) ? `[${segment}]` : `.${segment}`))
    .join("")}`;
}

function diagnosticPath(error: ErrorObject): string {
  const base = pointerToPath(error.instancePath);
  if (error.keyword === "required" && typeof error.params.missingProperty === "string") return `${base}.${error.params.missingProperty}`;
  if (error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string") return `${base}.${error.params.additionalProperty}`;
  return base;
}

export function validateAgainstContractSchema(input: unknown): Diagnostic[] {
  if (validateSchema(input)) return [];
  return (validateSchema.errors ?? []).map((error) => diagnostic(
    "CS-SCHEMA-001",
    "error",
    diagnosticPath(error),
    `Contract schema violation: ${error.message ?? error.keyword}.`,
    `Schema keyword: ${error.keyword}`
  ));
}

export function matchesJsonSchema(schema: object, input: unknown): boolean {
  try {
    return instanceAjv.validate(schema, input) === true;
  } catch {
    return false;
  }
}

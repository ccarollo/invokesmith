import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { GenerationPlan } from "../../plugin-sdk/src/index.js";
import { assertGenerationPlan } from "../../plugin-sdk/src/index.js";

export type WriteStatus = "created" | "updated" | "unchanged" | "preserved";
export interface WriteResult { path: string; status: WriteStatus; ownership: "managed" | "custom" }

async function existing(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeGenerationPlan(plan: GenerationPlan, outputDirectory: string): Promise<WriteResult[]> {
  assertGenerationPlan(plan);
  const root = resolve(outputDirectory);
  const results: WriteResult[] = [];

  for (const file of plan.files) {
    const destination = resolve(root, file.path);
    if (destination !== root && !destination.startsWith(`${root}${sep}`)) throw new Error(`Generated path escapes output directory: ${file.path}`);
    const previous = await existing(destination);
    if (file.ownership === "custom" && previous !== undefined) {
      results.push({ path: file.path, status: "preserved", ownership: file.ownership });
      continue;
    }
    if (previous === file.contents) {
      results.push({ path: file.path, status: "unchanged", ownership: file.ownership });
      continue;
    }

    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.invokesmith-tmp-${process.pid}`;
    await writeFile(temporary, file.contents, "utf8");
    await rename(temporary, destination);
    if (file.executable) await chmod(destination, 0o755);
    results.push({ path: file.path, status: previous === undefined ? "created" : "updated", ownership: file.ownership });
  }
  return results;
}

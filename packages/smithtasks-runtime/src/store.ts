import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SmithTasksState } from "./types.js";

export interface StateStore {
  transact<T>(operation: (state: SmithTasksState) => T | Promise<T>): Promise<T>;
  snapshot(): Promise<SmithTasksState>;
}

export class InMemoryStateStore implements StateStore {
  private state: SmithTasksState;

  constructor(initial: SmithTasksState) {
    this.state = structuredClone(initial);
  }

  async transact<T>(operation: (state: SmithTasksState) => T | Promise<T>): Promise<T> {
    const draft = structuredClone(this.state);
    const result = await operation(draft);
    this.state = draft;
    return structuredClone(result);
  }

  async snapshot(): Promise<SmithTasksState> {
    return structuredClone(this.state);
  }
}

export class JsonFileStateStore implements StateStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string, private readonly initial: SmithTasksState) {}

  async transact<T>(operation: (state: SmithTasksState) => T | Promise<T>): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    this.tail = this.tail.then(async () => {
      try {
        const state = await this.load();
        const value = await operation(state);
        await this.save(state);
        resolveResult(structuredClone(value));
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }

  async snapshot(): Promise<SmithTasksState> {
    await this.tail;
    return structuredClone(await this.load());
  }

  private async load(): Promise<SmithTasksState> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as SmithTasksState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(this.initial);
      throw error;
    }
  }

  private async save(state: SmithTasksState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}

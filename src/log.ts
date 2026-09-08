import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttemptLog } from "./tick.js";

/**
 * Derived state, not source of truth — safe to delete; the backlog is
 * authoritative. `baseDir` is per-project state under the shared bakloop
 * home (see config.ts#stateDir), never inside the target repo: it must
 * never appear in that repo's `git diff` and skew the gates.
 */
export function createLogStore(baseDir: string) {
  const dir = join(baseDir, "attempts");

  const pathFor = (taskId: string) => join(dir, `${taskId}.json`);

  return {
    async loadLog(taskId: string): Promise<AttemptLog> {
      try {
        const raw = await readFile(pathFor(taskId), "utf-8");
        return JSON.parse(raw) as AttemptLog;
      } catch {
        return { taskId, attempts: 0, signatures: [], modelErrors: 0 };
      }
    },
    async saveLog(log: AttemptLog): Promise<void> {
      await mkdir(dir, { recursive: true });
      await writeFile(pathFor(log.taskId), JSON.stringify(log, null, 2), "utf-8");
    },
  };
}

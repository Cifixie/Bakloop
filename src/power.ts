import { execFile, spawn } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import { warn as colorWarn } from "./colors.js";

const run = promisify(execFile);

export interface BatteryState {
  percent: number;
  onAcPower: boolean;
}

/**
 * Parses `pmset -g batt` stdout, e.g.:
 *   "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=...) 100%; discharging; 12:32 remaining present: true"
 * Deliberately ignores the charge-state word and time-remaining field — both
 * vary by OS version and neither changes the stop/go decision.
 */
export function parseBatteryState(stdout: string): BatteryState | null {
  const percentMatch = stdout.match(/(\d{1,3})%/);
  if (!percentMatch) return null;
  return {
    percent: Number(percentMatch[1]),
    onAcPower: /drawing from 'AC Power'/.test(stdout),
  };
}

/** Runs `pmset -g batt`; null on any failure or off darwin (desktop, CI, other OS). */
export async function readBatteryState(): Promise<BatteryState | null> {
  if (platform() !== "darwin") return null;
  try {
    const { stdout } = await run("pmset", ["-g", "batt"]);
    return parseBatteryState(stdout);
  } catch {
    return null;
  }
}

/**
 * Holds a `caffeinate -i` (idle-sleep only, not display/lid sleep) for the
 * life of this process. Returns a stop function; safe to call multiple
 * times. No-op off darwin, when opted out, or if `caffeinate` isn't found —
 * a missing binary must degrade, not kill the run.
 */
export function startCaffeinate(): () => void {
  if (platform() !== "darwin" || process.env.BAKLOOP_NO_CAFFEINATE === "1") {
    return () => {};
  }
  let child: ReturnType<typeof spawn> | null = null;
  try {
    // -w <pid>: caffeinate exits on its own if bakloop's process dies
    // (e.g. kill -9) without going through the normal stop path.
    child = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
    child.unref();
    child.on("error", (err) => {
      console.warn(colorWarn(`[power] caffeinate unavailable, idle sleep is not prevented: ${err.message}`));
      child = null;
    });
  } catch {
    return () => {};
  }
  return () => {
    child?.kill();
    child = null;
  };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBatteryState } from "./power.js";

test("parseBatteryState: discharging on battery", () => {
  const stdout =
    "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=22413411)\t62%; discharging; 3:15 remaining present: true\n";
  assert.deepEqual(parseBatteryState(stdout), { percent: 62, onAcPower: false });
});

test("parseBatteryState: on AC power", () => {
  const stdout =
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=22413411)\t100%; charged; 0:00 remaining present: true\n";
  assert.deepEqual(parseBatteryState(stdout), { percent: 100, onAcPower: true });
});

test("parseBatteryState: no battery present (desktop)", () => {
  const stdout = "Now drawing from 'AC Power'\n";
  assert.equal(parseBatteryState(stdout), null);
});

test("parseBatteryState: garbage input", () => {
  assert.equal(parseBatteryState("not a real pmset output"), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeLimits, limitNumbersFor, OVERRIDE_KEYS, parseOverrideBody, parsePolicyBody, POLICY_KEYS } from "./container-limits.js";

/** runtime config の偽物（層ごとの値だけ） */
function fakeConfig(instance: Record<string, unknown>, projects: Record<string, Record<string, unknown>> = {}) {
  return {
    layerValue: (key: string, projectId?: string) =>
      (projectId ? projects[projectId]?.[key] : instance[key]) as string | number | boolean | undefined,
  };
}
const HOST = { memoryBytes: 16 * 1024 ** 3, cpus: 4 };

test("設定が無ければ既定（2GiB・1コアを残し、8192）", () => {
  assert.deepEqual(limitNumbersFor(fakeConfig({}), HOST, "p1"), { memoryMiB: 14336, cpus: 3, processes: 8192 });
});

test("banto 全体の残す量と Project ごとの値は別の鍵で、Project の値は天井より上がらない", () => {
  const config = fakeConfig(
    { [POLICY_KEYS.hostReserveMemoryMiB]: 4096, [POLICY_KEYS.hostReserveCpus]: 2 },
    { p1: { [OVERRIDE_KEYS.memoryMiB]: 2048, [OVERRIDE_KEYS.cpus]: 8 } },
  );
  assert.deepEqual(limitNumbersFor(config, HOST, "p1"), { memoryMiB: 2048, cpus: 2, processes: 8192 });
  assert.deepEqual(limitNumbersFor(config, HOST, "p2"), { memoryMiB: 12288, cpus: 2, processes: 8192 }, "別の Project に漏れた");
  const view = describeLimits(config, HOST, "p1");
  assert.deepEqual(view.ceiling, { memoryMiB: 12288, cpus: 2, processes: 8192 });
  assert.deepEqual(view.override, { memoryMiB: 2048, cpus: 8 });
});

test("画面から来た値は検査する——壊れた値は断り、null は上書きをやめる", () => {
  assert.deepEqual(parsePolicyBody({ hostReserveMemoryMiB: 2048, hostReserveCpus: 1, processes: 8192 }), {
    hostReserveMemoryMiB: 2048,
    hostReserveCpus: 1,
    processes: 8192,
  });
  assert.throws(() => parsePolicyBody({ hostReserveMemoryMiB: -1, hostReserveCpus: 1, processes: 8192 }));
  assert.throws(() => parsePolicyBody({ hostReserveMemoryMiB: 2048, hostReserveCpus: "1", processes: 8192 }));
  assert.deepEqual(parseOverrideBody({ memoryMiB: 4096, cpus: null }), { memoryMiB: 4096, cpus: null, processes: null });
  assert.throws(() => parseOverrideBody({ memoryMiB: 100 }));
  assert.throws(() => parseOverrideBody({ cpus: 0 }));
});

// アーキ仕様 §4.3「段2」の「待たれている出どころを眠らせない」——どの Module が待たれているか
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Automation, AutomationSource } from "./fold.js";
import { awaitedModules, awaitingAutomations } from "./keep-awake.js";

function automation(projectId: string, source: AutomationSource, paused = false): Automation {
  return { projectId, source, paused } as Automation;
}
const event = (name: string): AutomationSource => ({ kind: "event", event: name, batchSeconds: 0, allowSelfTriggered: false });

test("一時停止していない出来事の自動化が待つ Module だけ。ほかの Project・時刻・Webhook・一時停止したものは数えない", () => {
  const list = [
    automation("p1", event("service.crashed")),
    automation("p1", event("factory.item-stopped"), true),
    automation("p2", event("backlog.item-changed")),
    automation("p1", { kind: "webhook", batchSeconds: 0, allowProjectContainer: false } as AutomationSource),
  ];
  assert.deepEqual(awaitedModules(list, "p1", ["service", "factory", "backlog", "shell"]), ["service"]);
  assert.deepEqual(awaitedModules(list, "p2", ["service", "backlog"]), ["backlog"]);
  assert.deepEqual(awaitedModules(list, "p3", ["service"]), []);
});

test("名前の頭は「.」まで一致したものだけ（service-x は service を待たせない）", () => {
  const list = [automation("p1", event("service-x.crashed"))];
  assert.deepEqual(awaitedModules(list, "p1", ["service", "service-x"]), ["service-x"]);
});

test("待っている自動化の名前も添える（眠っている Project の行・眠らせるときの確かめ）。一時停止したものは入れない", () => {
  const named = (id: string, source: AutomationSource, paused = false) => ({ ...automation("p1", source, paused), id, name: `自動化${id}` }) as Automation;
  const list = [named("a", event("service.crashed")), named("b", event("service.recovered")), named("c", event("service.crashed"), true)];
  assert.deepEqual(awaitingAutomations(list, "p1", ["backlog", "service"]), [
    { module: "service", automations: [{ id: "a", name: "自動化a" }, { id: "b", name: "自動化b" }] },
  ]);
});

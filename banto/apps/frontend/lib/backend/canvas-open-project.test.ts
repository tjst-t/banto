// Canvas から既にある Project を開く口：押した直後だけ・無い Project・閉じた Project は断る
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideOpenProject, parseOpenProjectParams } from "./canvas-open-project.ts";

const projects = [
  { id: "p1", name: "家計簿", status: "active" },
  { id: "p2", name: "古いもの", status: "closed" },
];

test("Project を開く：id だけ受け、押した直後でない・無い・閉じた Project は理由を返す", () => {
  assert.deepEqual(parseOpenProjectParams({ projectId: "p1" }), { projectId: "p1" });
  assert.ok("error" in parseOpenProjectParams({ projectId: "../x" }));
  assert.ok("error" in parseOpenProjectParams({}));
  assert.deepEqual(decideOpenProject({ projectId: "p1", activated: true, projects }), { ok: true });
  assert.deepEqual(decideOpenProject({ projectId: "p1", activated: false, projects }), { error: "Project を開くのは、人が画面を押した直後だけです" });
  assert.match((decideOpenProject({ projectId: "nope", activated: true, projects }) as { error: string }).error, /その Project はありません/);
  assert.equal(
    (decideOpenProject({ projectId: "p2", activated: true, projects }) as { error: string }).error,
    "「古いもの」は閉じた Project です——閉じたものの一覧から再開してから開いてください",
  );
});

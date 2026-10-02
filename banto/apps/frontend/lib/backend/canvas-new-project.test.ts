// Canvas から「新しい Project の画面を、このフォルダで」——受け取る値の読み方と、頼みの受け渡し
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearNewProjectRequest,
  getNewProjectRequest,
  parseNewProjectParams,
  requestNewProject,
  subscribeNewProjectRequest,
} from "./canvas-new-project.ts";

test("folder は / か ~/ から始まるパスだけ受け、名前は短い文字列だけ。読めなければ理由を返す", () => {
  assert.deepEqual(parseNewProjectParams({ folder: " /home/u/banto/x ", name: " x " }), { basePath: "/home/u/banto/x", name: "x" });
  assert.deepEqual(parseNewProjectParams({ folder: "~/banto/x" }), { basePath: "~/banto/x" });
  assert.deepEqual(parseNewProjectParams({}), { error: "folder が要ります" });
  assert.deepEqual(parseNewProjectParams({ folder: "relative/x" }), { error: "folder は / か ~/ から始まるパスで渡してください" });
  assert.deepEqual(parseNewProjectParams({ folder: "/x", name: "n".repeat(201) }), { error: "name は 200 字までの文字列で渡してください" });
  assert.deepEqual(parseNewProjectParams(undefined), { error: "folder が要ります" });
});

test("頼まれるたびに番号が進み（同じ中身でも開き直す）、閉じたら消える", () => {
  let heard = 0;
  const off = subscribeNewProjectRequest(() => (heard += 1));
  requestNewProject({ basePath: "/a" });
  const first = getNewProjectRequest();
  requestNewProject({ basePath: "/a" });
  const second = getNewProjectRequest();
  assert.equal(second!.seq, first!.seq + 1);
  clearNewProjectRequest();
  assert.equal(getNewProjectRequest(), null);
  assert.equal(heard, 3);
  off();
});

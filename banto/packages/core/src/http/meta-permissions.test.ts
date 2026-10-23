import { test } from "node:test";
import assert from "node:assert/strict";
import {
  META_RELEASE_KEY,
  metaAutoApproveReachFor,
  metaPermissionsPromptSection,
  metaProjectPermissions,
  metaReleasePolicy,
} from "./meta-permissions.js";

/** Project の層だけを持つ設定（`layerValue` の形） */
function configWith(values: Record<string, Record<string, string>>) {
  return { layerValue: (key: string, projectId?: string) => (projectId ? values[projectId]?.[key] : undefined) };
}

// **メタ Project の権限**（追加・2026-10-23、アーキ仕様 §4.6「権限」、Backlog #537）
test("メタ Project だけが任せ方を持ち、release の既定は「任せる」——普通の Project・チャットは何も変わらない", () => {
  const config = configWith({});
  assert.deepEqual(metaProjectPermissions(config, { id: "m", kind: "meta" }), { spec: true, publishLan: true, release: "delegate" });
  assert.equal(metaProjectPermissions(config, { id: "p" }), undefined, "普通の Project に任せ方が付いた");
  assert.equal(metaProjectPermissions(config, { id: "c", kind: "chat" }), undefined, "チャットに任せ方が付いた");
  assert.equal(metaProjectPermissions(config, undefined), undefined);
  assert.equal(metaProjectPermissions(undefined, { id: "m", kind: "meta" })?.release, "delegate", "設定が無くても既定は任せる");
});

test("release は Project の層に \"human\" があるときだけ人に残す（ほかの値・別の Project の値は効かない）", () => {
  const config = configWith({ m1: { [META_RELEASE_KEY]: "human" }, m2: { [META_RELEASE_KEY]: "nope" } });
  assert.equal(metaReleasePolicy(config, "m1"), "human");
  assert.equal(metaReleasePolicy(config, "m2"), "delegate");
  assert.equal(metaReleasePolicy(config, "m3"), "delegate");
  assert.equal(metaProjectPermissions(config, { id: "m1", kind: "meta" })?.release, "human");
});

test("LAN までの公開の印は、メタ Project の判断役でない会話にだけ \"lan\"", () => {
  const kinds: Record<string, "meta" | "chat" | undefined> = { m: "meta", c: "chat", p: undefined };
  const reach = metaAutoApproveReachFor({
    projectThread: { getProject: (id: string) => (id in kinds ? ({ id, kind: kinds[id] } as never) : undefined) },
    isJudgeThread: (threadId) => threadId === "judge",
  });
  assert.equal(reach("m", "t1"), "lan");
  assert.equal(reach("m"), "lan", "会話が分からない呼び出しは Project で決める");
  assert.equal(reach("m", "judge"), undefined, "判断役の会話に効いた");
  assert.equal(reach("p", "t1"), undefined, "普通の Project に効いた");
  assert.equal(reach("c", "t1"), undefined, "チャットに効いた");
  assert.equal(reach("gone", "t1"), undefined);
});

test("system prompt の節：spec・LAN の中の公開は任せ、release は設定どおり、外への公開・お金・消す操作は人に残す", () => {
  const delegate = metaPermissionsPromptSection({ spec: true, publishLan: true, release: "delegate" });
  assert.match(delegate, /^# メタ Project の権限/);
  assert.match(delegate, /spec（仕様・アーキテクチャの向きの判断）：任されている/);
  assert.match(delegate, /LAN の中だけに届く公開.*任されている/);
  assert.match(delegate, /release.*：任されている/);
  assert.match(delegate, /インターネットに届く公開/);
  assert.match(delegate, /お金/);
  assert.match(delegate, /消す・取り消せない操作/);
  const human = metaPermissionsPromptSection({ spec: true, publishLan: true, release: "human" });
  assert.match(human, /release.*：\*\*人に残す\*\*/);
  assert.doesNotMatch(human, /release.*：任されている/);
});

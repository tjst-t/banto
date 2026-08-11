/**
 * **職人を起こしたら、会話に必ず口が立つ**（PO要望 2026-08-11）。
 *
 * 枝を開くと幹に札が1行立つ（決定77）のと同じ形を、職人にも与える。押すと職人ビューアが
 * 開き、いま何をしているかが読める。
 *
 * **番頭の心がけにしない。** `canvas.open` を思い出したときだけ口が立つ形だと、忘れた
 * ときに見えない——実際、暴走した枝（thread-69）では職人の様子を見る手立てが会話に無く、
 * 番頭は `worker.attach` を繰り返して自分で覗くしかなかった。PO も同じものを見られない。
 *
 * 決定77 が枝で立てた不変条件と同じ考え：**どこにも出ていない職人は起こせない。**
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { withWorkerCard, WORKER_VIEW } from "@banto/host";
import type { NamespacedToolDefinition, UtsuwaView } from "@banto/host";

/** 起こせたことにして識別子を返す偽の `worker.delegate`。 */
function fakeDelegate(details: Record<string, unknown>): NamespacedToolDefinition {
  return {
    name: "worker.delegate",
    label: "Worker: Delegate",
    description: "",
    parameters: { type: "object", properties: {} },
    async execute() {
      return {
        content: [{ type: "text" as const, text: "職人を起こしました" }],
        details,
      };
    },
  } as unknown as NamespacedToolDefinition;
}

type OpenUtsuwa = Extract<UtsuwaView, { kind: "open" }>;

describe("[PO要望 2026-08-11] 職人を起こしたら、押せば様子が見られる口が立つ", () => {
  it("番頭が canvas.open を呼ばなくても、口が会話に積まれる", async () => {
    const shown: UtsuwaView[] = [];
    const tool = withWorkerCard(
      fakeDelegate({ sessionId: "s-1", taskId: "banto-similar-survey", runtime: "claude-agent-sdk", model: "opus" }),
      (u) => shown.push(u)
    );

    await tool.execute({ taskId: "banto-similar-survey" } as never, { toolCallId: "t" });

    assert.equal(shown.length, 1, "起こしたのに会話へ口が立っていない");
    const open = shown[0] as OpenUtsuwa;
    assert.equal(open.kind, "open");
    assert.equal(open.view, WORKER_VIEW, "押したら職人ビューアが開くこと");
    // **どの職人か**が渡らないと、押しても一覧が出るだけで様子は見えない
    assert.deepEqual(open.args, { sessionId: "s-1" });
    assert.match(open.label, /banto-similar-survey/u, "どの仕事の職人かが押す前に分かること");
    assert.match(open.meta ?? "", /claude-agent-sdk/u, "何で動いているかも添える");
  });

  it("職人ごとに別の口が立つ（2人目が1人目に吸われない）", async () => {
    const shown: UtsuwaView[] = [];
    const first = withWorkerCard(fakeDelegate({ sessionId: "s-1", taskId: "調査" }), (u) => shown.push(u));
    const second = withWorkerCard(fakeDelegate({ sessionId: "s-2", taskId: "実装" }), (u) => shown.push(u));

    await first.execute({} as never, { toolCallId: "t" });
    await second.execute({} as never, { toolCallId: "t" });

    assert.deepEqual(
      shown.map((u) => (u as OpenUtsuwa).args),
      [{ sessionId: "s-1" }, { sessionId: "s-2" }]
    );
  });

  it("職人を起こした結果はそのまま返る（口は足すだけ）", async () => {
    const tool = withWorkerCard(fakeDelegate({ sessionId: "s-1", pid: 42 }), () => undefined);
    const result = await tool.execute({} as never, { toolCallId: "t" });
    assert.match(result.content.map((c) => c.text).join(""), /職人を起こしました/u);
    assert.equal((result.details as Record<string, unknown>)["pid"], 42);
  });

  it("口を立てられなくても、起こしたことは取り消さない（I2）", async () => {
    const logged: string[] = [];
    const tool = withWorkerCard(
      fakeDelegate({ sessionId: "s-1" }),
      () => {
        throw new Error("配信できません");
      },
      (m) => logged.push(m)
    );

    // 職人は起きているので、ここで投げると「起きているのに誰も知らない」になる
    const result = await tool.execute({} as never, { toolCallId: "t" });
    assert.match(result.content.map((c) => c.text).join(""), /職人を起こしました/u);
    assert.equal(logged.length, 1, "黙って落としてはいけない");
  });

  it("識別子が返らなければ黙って省かず、理由を残す（I2）", async () => {
    const shown: UtsuwaView[] = [];
    const logged: string[] = [];
    const tool = withWorkerCard(fakeDelegate({ pid: 42 }), (u) => shown.push(u), (m) => logged.push(m));

    await tool.execute({} as never, { toolCallId: "t" });
    assert.deepEqual(shown, [], "どの職人か分からない口を立てても押せない");
    assert.match(logged.join(""), /識別子/u);
  });
});

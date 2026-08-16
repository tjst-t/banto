/**
 * task-0169: **添えた `canvasParams` が execute まで届く。**
 *
 * **踏んだこと**（2026-08-15〜16・3人が別々に）。`inbox.post` に `canvasKind: "kobo.review"` と
 * `canvasParams: {projectTag, taskId}` を**添えているのに**「添えてください」と断られる。
 * 直後に同じ値で `canvas.open` を撃つと通る（ように見える）ので、原因に辿り着けなかった。
 *
 * 犯人は Agent SDK バックエンドの引数変換（`schema-to-zod.ts`）。`OpenObject()` は
 * `{type:"object", additionalProperties:true}` で **`properties` を持たない**ので、
 * `jsonSchemaToZodShape` が `z.object({})`＝shape 空を作る。zod は既定で未知のキーを
 * **黙って落とす**ため、`{projectTag, taskId}` が `{}` になって execute に届いていた。
 *
 * **`canvas.open` も同じだけ壊れていた**——ただし `canvas.open` は `params` の中身を
 * 一切見ずに `?? {}` で通すので、空になっても成功を返す。「通った」のは効いていた証拠ではなく、
 * **黙って落ちていた**だけ（`schema-to-zod.ts` 冒頭の I2 がまさに戒めている形）。
 * だから見張るのは `inbox.post` だけではない——`OpenObject()` を使う道具**全部**について、
 * zod を通しても中身が残ることをここで見る。
 *
 * 当たり判定が広い直しなので、**PO の面（`canvas.open`）と検証（`env.verify` / `env.provision`）が
 * 壊れていないこと**をここで直接見えるようにしてある。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

import { OpenObject } from "@banto/core";
import { Type } from "typebox";
import {
  ArtifactStore,
  Canvas,
  Inbox,
  createCanvasCatalog,
  createCanvasTools,
  createInboxTools,
  jsonSchemaToZodShape,
  SHOWABLE_UTSUWA_KINDS,
  koboPoDecisionEffect,
  koboReviewTarget,
  type InboxEffect,
  type NamespacedToolDefinition,
} from "@banto/host";
import { createEnvTools } from "@banto/environment-pool";
import type { EnvironmentPool } from "@banto/environment-pool";

const PROJ = "banto";
const TASK = "task-0159";

/**
 * Agent SDK バックエンドが引数に対して実際にすることを、そのまま写した口。
 *
 * `claude-agent-harness.ts` は道具の定義を `jsonSchemaToZodShape` で raw shape にして
 * SDK の `tool()` へ渡し、SDK（MCP SDK）は `tools/call` のたびにその shape で組んだ
 * `z.object(shape)` に引数を通してからハンドラを呼ぶ。**ここを通さない試験は穴を見ない**
 * ——番頭が書いた JSON がそのまま execute に届くなら、この穴は最初から存在しない。
 */
function throughAgentSdkArgs(
  tool: NamespacedToolDefinition,
  args: Record<string, unknown>
): Record<string, unknown> {
  const shape = jsonSchemaToZodShape(tool.parameters as never);
  return z.object(shape).parse(args) as Record<string, unknown>;
}

function findTool(tools: NamespacedToolDefinition[], name: string): NamespacedToolDefinition {
  const found = tools.find((t) => t.name === name);
  assert.ok(found, `${name} が見つからない`);
  return found;
}

/** `bin.ts` の結線をそのまま写したもの（決定113）。ここに罠が無いことは task-0169 で確認済み。 */
function resolvePoDecisionEffect(input: {
  canvasKind?: string;
  canvasParams?: Record<string, unknown>;
  decision: string;
  detail?: string;
}): InboxEffect | undefined {
  const target = koboReviewTarget(input.canvasKind, input.canvasParams);
  if (!target) return undefined;
  if (input.decision !== "approve" && input.decision !== "send_back") return undefined;
  return koboPoDecisionEffect(target, input.decision, input.detail);
}

function inboxTools(): { inbox: Inbox; post: NamespacedToolDefinition } {
  const inbox = new Inbox();
  const tools = createInboxTools(inbox, { threadId: "thread-1", resolvePoDecisionEffect });
  return { inbox, post: findTool(tools, "inbox.post") };
}

/** 判断を仰ぐ札の中身（`canvasKind` / `canvasParams` は呼び出し側が足す）。 */
function postArgs(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    sourceId: "banto",
    sourceLabel: "番頭",
    kind: "review",
    title: "task-0159 を通してよいか",
    what: "決定番号の一意化",
    ask: "通してよいか",
    actions: [
      { id: "approve", label: "通す", tone: "call" },
      { id: "send_back", label: "差し戻す" },
    ],
    approveAction: "approve",
    sendBackAction: "send_back",
    sendBackReason: "決定番号が重複している。採番し直すこと",
    ...extra,
  };
}

describe("a1: 添えた canvasParams が zod 変換を通っても残り、approveAction に効果が結ばれる", () => {
  it("道具の定義から zod へ変換して parse しても canvasParams の中身が消えない", () => {
    const { post } = inboxTools();
    const parsed = throughAgentSdkArgs(
      post,
      postArgs({ canvasKind: "kobo.review", canvasParams: { projectTag: PROJ, taskId: TASK } })
    );
    assert.deepEqual(
      parsed["canvasParams"],
      { projectTag: PROJ, taskId: TASK },
      "zod 変換で canvasParams の中身が落ちている（これが task-0169 の穴そのもの）"
    );
  });

  it("その parse 済みの引数で inbox.post が通り、両方の選択肢に効果が結ばれる", async () => {
    const { inbox, post } = inboxTools();
    const parsed = throughAgentSdkArgs(
      post,
      postArgs({ canvasKind: "kobo.review", canvasParams: { projectTag: PROJ, taskId: TASK } })
    );
    await post.execute(parsed, { toolCallId: "call-1" });

    const items = inbox.list();
    assert.equal(items.length, 1);
    // 配る形（`InboxItemView`）に呼び出し先は載らない（決定73）ので、帳簿の側から見る
    const item = inbox.get(items[0]!.id)!;
    // 通す側だけ結ぶと、POは「駄目だ」を押しても何も起きない（決定113）
    for (const id of ["approve", "send_back"]) {
      const action = item.actions.find((a) => a.id === id);
      assert.ok(action?.effect, `${id} に効果が結ばれていない`);
    }
  });

  it("札に載る面の指定にも同じ値が残る（POが札から面へ移っても同じタスクを見る）", async () => {
    const { inbox, post } = inboxTools();
    const parsed = throughAgentSdkArgs(
      post,
      postArgs({ canvasKind: "kobo.review", canvasParams: { projectTag: PROJ, taskId: TASK } })
    );
    await post.execute(parsed, { toolCallId: "call-1" });
    assert.deepEqual(inbox.list()[0]!.opens?.canvas, {
      kind: "kobo.review",
      params: { projectTag: PROJ, taskId: TASK },
    });
  });
});

describe("a2: 結ばれた効果が工場の PO 専用の口へ projectTag / taskId / via を伴って届く", () => {
  it("approve の効果が kobo.po_decide 宛で、どの札のどの回答かまで載っている", async () => {
    const { inbox, post } = inboxTools();
    const parsed = throughAgentSdkArgs(
      post,
      postArgs({ canvasKind: "kobo.review", canvasParams: { projectTag: PROJ, taskId: TASK } })
    );
    await post.execute(parsed, { toolCallId: "call-1" });

    const item = inbox.get(inbox.list()[0]!.id)!;
    const effect = item.actions.find((a) => a.id === "approve")!.effect!;
    assert.equal(effect.module, "kobo");
    assert.equal(effect.tool, "kobo.po_decide");
    assert.equal(effect.args!["projectTag"], PROJ);
    assert.equal(effect.args!["taskId"], TASK);
    assert.equal(effect.args!["decision"], "approve");
    // 出どころ（`in-xxxxxxxx#approve`）は押された時にホストが埋める。
    // ここで見るのは「埋める先が決まっていること」——決まっていないと誰の回答か残らない
    assert.equal(effect.originArg, "via", "どの札のどの回答で通ったかを載せる先が無い");
  });

  it("send_back の効果には職人へ渡す指摘がそのまま載る", async () => {
    const { inbox, post } = inboxTools();
    const parsed = throughAgentSdkArgs(
      post,
      postArgs({ canvasKind: "kobo.review", canvasParams: { projectTag: PROJ, taskId: TASK } })
    );
    await post.execute(parsed, { toolCallId: "call-1" });

    const effect = inbox
      .get(inbox.list()[0]!.id)!
      .actions.find((a) => a.id === "send_back")!.effect!;
    assert.equal(effect.tool, "kobo.po_decide");
    assert.equal(effect.args!["decision"], "send_back");
    assert.equal(effect.args!["detail"], "決定番号が重複している。採番し直すこと");
  });
});

describe("a3: 添え忘れの断り文が、何が足りないのかを名指しして区別する", () => {
  const cases: { name: string; extra: Record<string, unknown>; expect: RegExp }[] = [
    {
      name: "canvasKind が無い",
      extra: { canvasParams: { projectTag: PROJ, taskId: TASK } },
      expect: /canvasKind を添えていません/,
    },
    {
      name: "canvasKind が別の値",
      extra: { canvasKind: "file.viewer", canvasParams: { projectTag: PROJ, taskId: TASK } },
      expect: /canvasKind が "kobo\.review" ではありません（受け取った値: "file\.viewer"）/,
    },
    {
      name: "canvasParams が無い",
      extra: { canvasKind: "kobo.review" },
      expect: /canvasParams を添えていません/,
    },
    {
      name: "taskId だけ欠けている",
      extra: { canvasKind: "kobo.review", canvasParams: { projectTag: PROJ } },
      expect: /canvasParams\.taskId が空です/,
    },
  ];

  const messages: string[] = [];

  for (const c of cases) {
    it(`${c.name} → その欠けを名指しする`, async () => {
      const { post } = inboxTools();
      // 断り文の試験なので zod は通さない（通すと canvasParams が消えて別の case になる）
      await assert.rejects(
        () => post.execute(postArgs(c.extra), { toolCallId: "call-1" }),
        (err: unknown) => {
          const message = (err as Error).message;
          messages.push(message);
          assert.match(message, c.expect);
          return true;
        }
      );
    });
  }

  it("4通りが同じ文言にならない", () => {
    assert.equal(messages.length, cases.length, "先の4件が全部走っていない");
    assert.equal(new Set(messages).size, cases.length, `断り文が重複している: ${messages.join(" | ")}`);
  });

  it("受け取った値を文言に出す（「添えたのに空で届いた」がその場で分かる）", async () => {
    const { post } = inboxTools();
    // 穴を踏んだときに実際に execute へ届いていた形＝中身が落ちた空の object
    await assert.rejects(
      () => post.execute(postArgs({ canvasKind: "kobo.review", canvasParams: {} }), { toolCallId: "c" }),
      (err: unknown) => {
        assert.match((err as Error).message, /受け取った canvasParams: \{\}/);
        return true;
      }
    );
  });
});

describe("当たり判定: OpenObject() を使う他の道具が壊れていない", () => {
  const catalog = createCanvasCatalog([
    {
      kind: "kobo.review",
      title: "レビュー",
      description: "タスクを見る",
      component: "KoboReview",
      parameters: { type: "object", properties: {} },
    },
  ]);

  /** `canvas.show` は退避先と器の出し口が揃って初めて載る（`canvas-tools.ts`）。 */
  function canvasTools(canvas: Canvas): NamespacedToolDefinition[] {
    return createCanvasTools(canvas, catalog, {
      artifacts: new ArtifactStore(fs.mkdtempSync(path.join(os.tmpdir(), "banto-t0169-"))),
      showUtsuwa: () => {},
    });
  }

  it("canvas.open の params が zod 変換を通っても残り、開いた面に届く（POの面）", async () => {
    const canvas = new Canvas(catalog);
    const open = findTool(canvasTools(canvas), "canvas.open");

    const parsed = throughAgentSdkArgs(open, {
      kind: "kobo.review",
      params: { projectTag: PROJ, taskId: TASK },
    });
    assert.deepEqual(parsed["params"], { projectTag: PROJ, taskId: TASK });

    await open.execute(parsed, { toolCallId: "call-1" });
    // 「開いた」だけでは足りない——**開いた面が正しいタスクを指している**ことを見る。
    // ここが空のまま成功するのが、3人が原因に辿り着けなかった理由そのもの
    assert.deepEqual(canvas.snapshot().tabs[0]!.params, { projectTag: PROJ, taskId: TASK });
  });

  it("canvas.show の args が zod 変換を通っても残る", () => {
    const show = findTool(canvasTools(new Canvas(catalog)), "canvas.show");
    const parsed = throughAgentSdkArgs(show, {
      utsuwa: SHOWABLE_UTSUWA_KINDS[0]!,
      artifact: "a-0001",
      args: { columns: ["id", "title"], sort: "id" },
    });
    assert.deepEqual(parsed["args"], { columns: ["id", "title"], sort: "id" });
  });

  for (const name of ["env.verify", "env.provision"]) {
    it(`${name} の config が zod 変換を通っても残る（検証）`, () => {
      // 引数の形だけを見るので、池は使わない（execute は呼ばない）
      const tools = createEnvTools({} as unknown as EnvironmentPool);
      const tool = findTool(tools, name);
      const parsed = throughAgentSdkArgs(tool, {
        repoPath: "/home/ubuntu/ghq/github.com/tjst-t/banto",
        driver: "docker",
        config: { image: "node:24", setup: ["npm ci"] },
        ...(name === "env.verify" ? { cmd: "npm test" } : {}),
      });
      assert.deepEqual(parsed["config"], { image: "node:24", setup: ["npm ci"] });
    });
  }

  it("中身を数え上げた object は今まで通り締まったまま（知らないキーは落とす）", () => {
    // `OpenObject()` を開くのは「開いていると書いてある object」だけ。
    // 普通の `Type.Object({...})` まで開くと、綴り違いの引数が黙って通る
    const shape = jsonSchemaToZodShape(Type.Object({ a: Type.String() }) as never);
    assert.deepEqual(z.object(shape).parse({ a: "x", typo: 1 }), { a: "x" });
  });

  it("OpenObject() が「開いた object」として zod へ写る", () => {
    const shape = jsonSchemaToZodShape(Type.Object({ p: OpenObject() }) as never);
    assert.deepEqual(z.object(shape).parse({ p: { any: "thing", n: 1 } }), {
      p: { any: "thing", n: 1 },
    });
  });
});

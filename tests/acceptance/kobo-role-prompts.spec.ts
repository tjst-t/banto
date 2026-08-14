/**
 * 第2便 (P): **役の説明を経路によらず職人に届ける**。
 *
 * **困っていたこと**：`skills/executor-system.md` / `skills/audit-system.md` を渡して
 * いたのは pi 拡張の `before_agent_start` だけだった。それは
 * `driverOptions.extensionPaths`＝**pi の言葉**で、Claude Agent SDK のドライバは
 * 読まない（`claude-agent-driver.ts` に `extensionPaths` は1度も出てこない）。
 * **実運用の職人はほぼ全て SDK 経路**なので、役の説明は職人に届いていなかった。
 *
 * いちばん重いのは実装役で、**「不可逆な変更を独断でしない」（D1）がプロンプトから
 * 丸ごと落ちていた**——SDK 経路の職人が受け取っていたのは Worker Pool の汎用
 * プロンプトだけである。
 *
 * 直し方は監査チェックリスト（段1）と同じ：**Kobo が指示文に載せる**。
 * driver 側のシステムプロンプトに足す形は採らない——経路ごとに別の場所へ載せると、
 * 次に経路が増えたときまた落ちる。どちらの役を起こすかを知っているのは最初から Kobo。
 *
 * **pi 経路では二重に届く。それは承知のうえ**（重複は無害、片方が届かないのは害）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAuditInstruction,
  buildExecutorInstruction,
} from "../../packages/banto-daemon/src/daemon.js";
import { loadPromptAsset, type TaskRecord } from "../../packages/banto-core/src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const skillsDir = path.join(repoRoot, "skills");

const task: TaskRecord = {
  id: "task-7001",
  status: "implementing",
  projectTag: "roleproj",
  title: "役の説明が届くこと",
  kind: "feature",
  scope: { paths: ["src/**"] },
  acceptance: [{ id: "a1", text: "動く" }],
};

describe("[(P)] 実装役の指示文に、役の説明が載る", () => {
  it("`skills/executor-system.md` の中身がそのまま入る", () => {
    const instruction = buildExecutorInstruction(task, "/tmp/wt");
    const asset = loadPromptAsset("executor-system");
    assert.ok(
      instruction.includes(asset),
      "指示文に役の説明が載っていない——**Agent SDK の職人には届かない**"
    );
  });

  it("**D1（不可逆な変更を独断でしない）が届く**——ここが丸ごと落ちていた", () => {
    const instruction = buildExecutorInstruction(task, "/tmp/wt");
    assert.match(
      instruction,
      /never making an irreversible change on your own judgement \(D1\)/,
      "D1 の指示が職人に届いていない（独断で不可逆な変更をされる）"
    );
    assert.match(instruction, /Escalating what you cannot decide/);
  });

  it("契約（スコープ・受け入れ基準・手順）は今までどおり載る", () => {
    const instruction = buildExecutorInstruction(task, "/tmp/wt");
    assert.match(instruction, /## 実装タスク task-7001/);
    assert.match(instruction, /- src\/\*\*/);
    assert.match(instruction, /report_done/);
  });

  it("手直し（rework）の指示文にも載る——指摘だけ渡して役を落とさない", () => {
    const instruction = buildExecutorInstruction(task, "/tmp/wt", ["a1 が未検証"]);
    assert.ok(instruction.includes(loadPromptAsset("executor-system")));
    assert.match(instruction, /a1 が未検証/);
  });
});

describe("[(P)] 監査人の指示文に、役の説明と観点の**両方**が載る", () => {
  it("`audit-system` と `audit-checklist` が同じ指示文から来る", () => {
    const instruction = buildAuditInstruction(task, "roleproj", "task-7001", "/tmp/wt");
    assert.ok(
      instruction.includes(loadPromptAsset("audit-system")),
      "役の説明が載っていない"
    );
    assert.ok(
      instruction.includes(loadPromptAsset("audit-checklist")),
      "監査の観点が載っていない"
    );
  });

  it("**別々の場所から来る状態にしない**——役が先、観点が後で、どちらも指示文の中", () => {
    const instruction = buildAuditInstruction(task, "roleproj", "task-7001", "/tmp/wt");
    const roleAt = instruction.indexOf(loadPromptAsset("audit-system"));
    const checklistAt = instruction.indexOf(loadPromptAsset("audit-checklist"));
    assert.ok(roleAt >= 0 && checklistAt >= 0);
    assert.ok(roleAt < checklistAt, "役の説明より先に観点が来ている（読む順が逆）");
  });
});

describe("[(P)] 資産が読めなければ**落ちる**（黙って役なしで動かさない）", () => {
  /**
   * 資産を退避して呼び、必ず戻す。
   *
   * **黙って落ちるのが第2便でいちばん危なかった形**——`audit-checklist` は誰にも
   * 届いていなかったのに、誰も気づかないまま監査が回り続けていた。
   */
  const withMissingAsset = (name: string, fn: () => void): void => {
    const assetPath = path.join(skillsDir, `${name}.md`);
    const saved = fs.readFileSync(assetPath, "utf-8");
    fs.rmSync(assetPath);
    try {
      fn();
    } finally {
      fs.writeFileSync(assetPath, saved, "utf-8");
    }
  };

  it("`executor-system.md` が無ければ、実装役を起こす前に落ちる", () => {
    withMissingAsset("executor-system", () => {
      assert.throws(
        () => buildExecutorInstruction(task, "/tmp/wt"),
        /executor-system/,
        "資産が無いのに指示文が組み上がっている（役を知らない職人が動く）"
      );
    });
  });

  it("`audit-system.md` が無ければ、監査人を起こす前に落ちる", () => {
    withMissingAsset("audit-system", () => {
      assert.throws(
        () => buildAuditInstruction(task, "roleproj", "task-7001", "/tmp/wt"),
        /audit-system/
      );
    });
  });

  it("`audit-checklist.md` が無ければ、監査人を起こす前に落ちる", () => {
    withMissingAsset("audit-checklist", () => {
      assert.throws(
        () => buildAuditInstruction(task, "roleproj", "task-7001", "/tmp/wt"),
        /audit-checklist/
      );
    });
  });
});

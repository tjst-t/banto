/**
 * モジュールが出す SKILL が、**在って・読めて・番頭に届く**こと（ADR-0010 決定26）。
 *
 * SKILL はコードで `name` / `description` / `filePath` を宣言し、本体は Markdown に置く。
 * **この2つはずれても型では落ちない**——番頭が `skill.read` したときに初めて
 * 「ファイルがありません」と分かる。P4：同じ抜けを繰り返さないよう、機械で見る。
 *
 * あわせて、**判断待ちの経路が言葉として繋がっているか**も見る。工場の知らせは
 * 「取次へ上げてください」と言うが、**どの道具でどう上げるか**が書かれていないと、
 * 番頭は上げ方を知らないまま止まる（決定58 の一次受けが機能しない）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { createKoboModule } from "../../packages/banto-daemon/src/kobo-module.js";
import { createEnvironmentPoolModule, EnvironmentPool } from "@banto/environment-pool";
import { createWorkerPoolModule, WorkerPool } from "@banto/worker-pool";
import * as os from "node:os";
import * as path from "node:path";
import type { RuntimeDriver, SessionHandle, SpawnOptions } from "@banto/core";

/** 何も起こさないドライバ（モジュール定義を組み立てるためだけ）。 */
const idleDriver: RuntimeDriver = {
  async spawn(_opts: SpawnOptions): Promise<SessionHandle> {
    throw new Error("この試験では職人を起こさない");
  },
  async inject() {},
  async kill() {},
  subscribe() {
    return () => undefined;
  },
};

/** 各モジュールが宣言している SKILL（由来つき）。 */
function declaredSkills(): Array<{ module: string; name: string; description: string; filePath: string }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "module-skills-"));
  const modules = [
    createKoboModule("http://127.0.0.1:1/api/kobo"),
    createEnvironmentPoolModule(new EnvironmentPool({ dataDir: path.join(tmp, "env") })),
    createWorkerPoolModule(
      new WorkerPool({ driver: idleDriver, dataDir: path.join(tmp, "worker"), idleTimeoutMs: 0 })
    ),
  ];
  return modules.flatMap((m) => m.skills.map((s) => ({ module: m.name, ...s })));
}

describe("[決定26] モジュールの SKILL は在って読める", () => {
  const skills = declaredSkills();

  it("宣言された SKILL のファイルが全部在る", () => {
    const missing = skills.filter((s) => !fs.existsSync(s.filePath));
    assert.deepEqual(
      missing.map((s) => `${s.module}/${s.name}: ${s.filePath}`),
      [],
      "宣言だけあって本体が無い SKILL は、番頭が読もうとして初めて分かる"
    );
  });

  it("SKILL の frontmatter の name が、宣言した name と一致する", () => {
    for (const skill of skills) {
      const body = fs.readFileSync(skill.filePath, "utf-8");
      const match = body.match(/^name:\s*(.+)$/m);
      assert.ok(match, `${skill.name}: frontmatter に name が無い`);
      assert.equal(
        match![1]!.trim(),
        skill.name,
        `${skill.filePath}: 宣言（コード）と本体（Markdown）で name がずれている`
      );
    }
  });

  it("description は「いつ使うか」を含む——番頭はこれだけを見て開くかを決める", () => {
    for (const skill of skills) {
      assert.ok(
        skill.description.length >= 40,
        `${skill.name}: description が短すぎる（いつ使うかが書けていない）`
      );
      assert.match(
        skill.description,
        /とき|ときに使う|使う/,
        `${skill.name}: どんなときに使うのかが書かれていない`
      );
    }
  });

  it("工場の SKILL が3本ある（積む・捌く・載せる）", () => {
    const kobo = skills.filter((s) => s.module === "kobo").map((s) => s.name).sort();
    assert.deepEqual(kobo, ["kobo-enqueue", "kobo-onboarding", "kobo-review"]);
  });

  it("検証環境の SKILL が2本ある（使う・設定ファイルを書く）", () => {
    const env = skills.filter((s) => s.module === "environment-pool").map((s) => s.name).sort();
    assert.deepEqual(env, ["environment", "environment-profiles"]);
  });
});

describe("[決定57・58] 判断待ちから取次までが言葉として繋がっている", () => {
  const read = (p: string): string => fs.readFileSync(p, "utf-8");
  const skills = declaredSkills();
  const skillPath = (name: string): string => skills.find((s) => s.name === name)!.filePath;

  it("工場の知らせが、上げ方（inbox.post）と手順（SKILL）を名指しする", () => {
    const notice = read(
      new URL("../../packages/banto-host/src/kobo-notice.ts", import.meta.url).pathname
    );
    assert.match(notice, /inbox\.post/, "どの道具で上げるかを言う");
    assert.match(notice, /kobo-review/, "手順の在り処を言う");
    assert.match(notice, /kobo\.approve/, "自分で通せる場合の道具も言う");
  });

  it("kobo-review が取次の札の埋め方を持つ（三部構成が欠けない）", () => {
    const body = read(skillPath("kobo-review"));
    for (const field of ["sourceId", "why", "what", "ask", "actions", "canvasKind"]) {
      assert.match(body, new RegExp(field), `取次に渡す ${field} の説明が無い`);
    }
    assert.match(body, /D1|D9|P3/, "何を上げるべきかの基準が書かれていない");
  });

  it("載せる手順が、層B設定と検証環境の SKILL へ繋がっている", () => {
    const body = read(skillPath("kobo-onboarding"));
    assert.match(body, /meta\/config\.yaml/, "層B設定の置き場が書かれていない");
    assert.match(body, /environment-profiles/, "検証環境の SKILL へ繋がっていない");
    assert.match(body, /kobo-enqueue/, "最初の1本の積み方へ繋がっていない");
  });

  it("設定ファイルの SKILL が、触れる環境の要件（config.port）を持つ", () => {
    const body = read(skillPath("environment-profiles"));
    assert.match(body, /config\.port/, "レビューで触るのに何が要るかが書かれていない");
    assert.match(body, /meta\/environments\.yaml/);
    assert.match(body, /credentials/, "秘密の扱いが書かれていない");
  });
});

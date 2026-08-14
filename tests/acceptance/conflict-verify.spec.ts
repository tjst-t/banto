/**
 * **コンフリクト解消タスクにも検査を持たせる**（realign 第3便・段3。番頭裁定 2026-08-14）。
 *
 * 段2で `review.policy` の既定を自動着地へ反転したとき、`conflict-filer.ts` が書き出す
 * 解消タスクが**検査コマンドを1本も持たない**ことが分かった。条件（→ `spec-daemon-core`
 * §2.5）を満たさないので、自動生成された解消タスクは必ず人の承認を通ることになり、
 * **元タスクは番頭が見るまで paused のまま止まる**。
 *
 * `kind: conflict` を例外にする案は却下した——「証拠のあるものだけを機械に通す」に
 * 穴が開く。代わりに**証拠を持たせる**：層Bに書かれた検査コマンドを契約に載せる。
 *
 * ## ここで見る不変条件
 *
 *   1. 層Bに `verify.conflict_command` があれば、契約の受け入れ条件すべてに載る
 *   2. **無ければ今までどおり検査ゼロ**。塞がない——設定した人だけが自動復旧を得る
 *   3. **名乗りと実態をずらさない。** 検査を載せたときだけ `policy: auto` を名乗り、
 *      載せられないときは `banto` と書く（`auto` と書いて必ず人を通るのは嘘になる）
 *   4. 書き出したものが**読み戻せる**。層Bの YAML パーサはエスケープを扱わないので、
 *      引用符を含むコマンドで契約が壊れないこと
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fileConflictTask } from "../../packages/banto-daemon/src/conflict-filer.js";
import { loadProjectConfig } from "../../packages/banto-daemon/src/review-policy.js";
import { autoLandBlockers } from "../../packages/banto-daemon/src/review-policy.js";
import { parseYamlFrontmatter, extractFrontmatter } from "../../packages/banto-core/src/index.js";

/** 使い捨てのリポジトリ。`meta/config.yaml` を書いた形で渡せる。 */
function repo(configYaml?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conflict-verify-"));
  fs.mkdirSync(path.join(dir, "work", "tasks"), { recursive: true });
  if (configYaml !== undefined) {
    fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
    fs.writeFileSync(path.join(dir, "meta", "config.yaml"), configYaml);
  }
  return dir;
}

/** コンフリクト解消タスクを1本書き出し、その中身を返す。 */
function file(repoPath: string, conflictedFiles: string[] = ["src/shared.ts"]): string {
  const { filePath } = fileConflictTask({
    projectTag: "proj-cv",
    originTaskId: "task-0001",
    originTaskTitle: "元のしごと",
    originTaskBranch: "task/task-0001",
    mainline: "main",
    conflictedFiles,
    rebaseErrorMessage: "CONFLICT (content): Merge conflict in src/shared.ts",
    repoPath,
  });
  return fs.readFileSync(filePath, "utf-8");
}

/** 書き出した契約を読み戻す（watcher が通る道と同じ形）。 */
function acceptanceOf(content: string): Array<{ id?: string; text?: string; verify?: string }> {
  const fm = extractFrontmatter(content);
  assert.ok(fm, "frontmatter が取り出せること");
  const parsed = parseYamlFrontmatter(fm);
  return (parsed["acceptance"] ?? []) as Array<{ id?: string; text?: string; verify?: string }>;
}

function policyOf(content: string): string | undefined {
  const fm = extractFrontmatter(content);
  assert.ok(fm);
  const review = parseYamlFrontmatter(fm)["review"] as { policy?: string } | undefined;
  return review?.policy;
}

// ── 1. 層B設定の読み取り ─────────────────────────────────────────────────────

describe("[realign-3 段3] 層B `verify.conflict_command`", () => {
  it("書いてあれば読む", () => {
    const dir = repo("verify:\n  conflict_command: npm test\n");
    assert.equal(loadProjectConfig(dir).verify.conflictCommand, "npm test");
  });

  it("書かなければ欄ごと無い（既定を作らない）", () => {
    const dir = repo("verify:\n  profile: test\n");
    assert.equal(loadProjectConfig(dir).verify.conflictCommand, undefined);
  });

  it("設定ファイルそのものが無くても無い", () => {
    assert.equal(loadProjectConfig(repo()).verify.conflictCommand, undefined);
  });

  /**
   * I2: 層Bの YAML パーサはエスケープを扱わない（`stripQuotes` / `splitRespectingQuotes`）。
   * 両方の引用符を含むコマンドは**契約に書き出せない**ので、黙って壊れた契約を書くのでなく
   * 設定を読んだ時点で断る——書いた人が直せるのはそこだけ。
   */
  it("引用符を両方含むコマンドは書き出せないので断る", () => {
    const dir = repo(`verify:\n  conflict_command: sh -c "echo 'x'"\n`);
    assert.throws(() => loadProjectConfig(dir), /conflict_command/);
  });

  it("空文字は「書いていない」と同じに扱わず断る（設定したのに効かないを作らない）", () => {
    const dir = repo('verify:\n  conflict_command: ""\n');
    assert.throws(() => loadProjectConfig(dir), /conflict_command/);
  });
});

// ── 2. 契約に載る ────────────────────────────────────────────────────────────

describe("[realign-3 段3] 層Bに検査があるとき、解消タスクは自動着地できる形になる", () => {
  it("受け入れ条件すべてに検査コマンドが載る", () => {
    const content = file(repo("verify:\n  conflict_command: npm test\n"), [
      "src/a.ts",
      "src/b.ts",
    ]);
    const acceptance = acceptanceOf(content);
    assert.equal(acceptance.length, 2, "コンフリクトしたファイルごとに1本");
    for (const ac of acceptance) {
      assert.equal(ac.verify, "npm test", `${ac.id} に検査が載っていない`);
    }
  });

  it("`policy: auto` を名乗る（検査があるので実態と合う）", () => {
    const content = file(repo("verify:\n  conflict_command: npm test\n"));
    assert.equal(policyOf(content), "auto");
  });

  /**
   * **段2の判定と地続きであること。** ここが繋がっていないと、契約に検査を載せたのに
   * 自動着地しない（あるいはその逆）が起きる。
   */
  it("刻みが揃えば `autoLandBlockers` が空になる（実際に自動着地する）", () => {
    const content = file(repo("verify:\n  conflict_command: npm test\n"));
    const blockers = autoLandBlockers({
      contractVersion: 1,
      checklistVersion: "abc123",
      acceptance: acceptanceOf(content),
    });
    assert.deepEqual(blockers, [], `止められている: ${blockers.join(" / ")}`);
  });

  it("コンフリクトしたファイルが特定できなくても検査は載る（catch-all の1本）", () => {
    const content = file(repo("verify:\n  conflict_command: npm test\n"), []);
    const acceptance = acceptanceOf(content);
    assert.equal(acceptance.length, 1);
    assert.equal(acceptance[0]!.verify, "npm test");
  });
});

// ── 3. 設定が無いときは塞がない ──────────────────────────────────────────────

describe("[realign-3 段3] 層Bに検査が無いときは、今までどおり人を通る", () => {
  it("検査コマンドは載らない", () => {
    const content = file(repo("verify:\n  profile: test\n"));
    for (const ac of acceptanceOf(content)) {
      assert.equal(ac.verify, undefined, "設定が無いのに検査が載っている");
    }
  });

  /**
   * **名乗りと実態をずらさない。** 検査が無ければ必ず人を通るので、`auto` と書かない
   * ——書くと帳簿には「auto」と残るのに一度も自動着地しない、という読めない状態になる。
   */
  it("`policy: banto` と名乗る（`auto` と書いて必ず人を通るのは嘘になる）", () => {
    assert.equal(policyOf(file(repo("verify:\n  profile: test\n"))), "banto");
  });

  it("`autoLandBlockers` が検査の無さを理由に止める", () => {
    const content = file(repo());
    const blockers = autoLandBlockers({
      contractVersion: 1,
      checklistVersion: "abc123",
      acceptance: acceptanceOf(content),
    });
    assert.equal(blockers.length, 1);
    assert.match(blockers[0]!, /verify/);
  });
});

// ── 4. 書いたものが読み戻せる ────────────────────────────────────────────────

describe("[realign-3 段3] 書き出した契約は読み戻せる", () => {
  it("コロンやスラッシュを含むコマンドでも壊れない", () => {
    const cmd = "BANTO_ENV_POOL_URL=http://127.0.0.1:1/x node --test tests/a.spec.ts";
    const content = file(repo(`verify:\n  conflict_command: ${cmd}\n`));
    assert.equal(acceptanceOf(content)[0]!.verify, cmd);
  });

  it("二重引用符を含むコマンドは単引用符で囲んで書き、そのまま読み戻せる", () => {
    const cmd = 'sh -c "npm test"';
    const content = file(repo(`verify:\n  conflict_command: ${cmd}\n`));
    assert.equal(acceptanceOf(content)[0]!.verify, cmd);
  });

  it("単引用符を含むコマンドは二重引用符で囲んで書き、そのまま読み戻せる", () => {
    const cmd = "sh -c 'npm test'";
    const content = file(repo(`verify:\n  conflict_command: ${cmd}\n`));
    assert.equal(acceptanceOf(content)[0]!.verify, cmd);
  });

  it("コンマを含むコマンドでも受け入れ条件が切れない", () => {
    const cmd = "node --test a.spec.ts,b.spec.ts";
    const content = file(repo(`verify:\n  conflict_command: ${cmd}\n`));
    const acceptance = acceptanceOf(content);
    assert.equal(acceptance.length, 1);
    assert.equal(acceptance[0]!.verify, cmd);
  });
});

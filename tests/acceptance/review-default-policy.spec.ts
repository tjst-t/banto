/**
 * `review.policy` の解決（realign 第3便）。ADR-0013 決定57・66。
 *
 * 見張るのは3つ:
 *   1. **旧称 `manual` は人（`banto`）へ写る**。既定が何であっても——既定への
 *      fall-through で表していると、既定を反転した瞬間に「人が見る」と書いたものが
 *      黙って機械通過になる
 *   2. **既定は層B（`meta/config.yaml`）で差し替えられる**。これが反転の後戻りの口
 *   3. **厳しい側の上書きが必ず勝つ**。`governance` / `po_required_paths` は、
 *      既定を緩めても素通りしない
 *
 * `resolveReviewStage` は純関数（task と config だけを見る）なので、工場は立てない。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveReviewStage,
  loadProjectConfig,
  DEFAULT_REVIEW_STAGE,
  type ProjectConfig,
} from "../../packages/banto-daemon/src/review-policy.js";
import type { TaskRecord } from "@banto/core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 最小のタスク。`extra` で契約の欄を足す。 */
function task(extra: Record<string, unknown> = {}): TaskRecord {
  return {
    id: "task-0001",
    status: "auditing",
    projectTag: "banto",
    title: "テスト用",
    ...extra,
  };
}

/** 最小の層B設定。`review` を差し替えたいときだけ渡す。 */
function config(review: Partial<ProjectConfig["review"]> = {}): ProjectConfig {
  return {
    verify: { profile: "test" },
    review: { poRequiredPaths: [], ...review },
    limits: {},
  };
}

/** `meta/config.yaml` を1本書いた使い捨てのリポジトリを作る。 */
function repoWithConfig(yaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-review-policy-"));
  fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
  fs.writeFileSync(path.join(dir, "meta", "config.yaml"), yaml);
  return dir;
}

describe("[realign-3] 層B設定の読み取り（review.default_policy）", () => {
  it("`review.default_policy` を読む", () => {
    const dir = repoWithConfig("review:\n  default_policy: auto\n");
    assert.equal(loadProjectConfig(dir).review.defaultPolicy, "auto");
  });

  it("書かなければ欄ごと無い（既定へ落ちる）", () => {
    const dir = repoWithConfig("review:\n  po_required_paths:\n    - packages/banto-web/**\n");
    assert.equal(loadProjectConfig(dir).review.defaultPolicy, undefined);
  });

  /** I2: 知らない綴りを黙って既定へ落とさない——設定したのに効かない状態を作らない。 */
  it("知らない綴りは黙って無視せず投げる", () => {
    const dir = repoWithConfig("review:\n  default_policy: つよい\n");
    assert.throws(() => loadProjectConfig(dir), /default_policy/);
  });

  it("同じファイルの他の欄と併存する", () => {
    const dir = repoWithConfig(
      "review:\n  default_policy: banto\n  env_profile: dev\n  po_required_paths:\n    - prototype/**\n"
    );
    const config = loadProjectConfig(dir);
    assert.equal(config.review.defaultPolicy, "banto");
    assert.equal(config.review.envProfile, "dev");
    assert.deepEqual(config.review.poRequiredPaths, ["prototype/**"]);
  });
});

/**
 * **退役した設定は、書いてあっても Kobo を止めない**（第4便）。
 *
 * `verify.conflict_command` は第3便が足した設定で、読み手は「自動起票した解消タスクへ
 * 検査コマンドを写す」処理**だけ**だった。第4便で解消タスクの起票ごと無くなったので、
 * この設定は役目を終えている——残すと「効いている」と誤読される。
 *
 * **ただし消す前に確かめる。** 稼働中のプロジェクトの `meta/config.yaml` には
 * この欄が書かれたまま残りうる。**未知の欄で起動できなくなってはいけない**ので、
 * 読み手を消したあとも「書いてあれば黙って無視する」ことをここで縛る。
 */
describe("[第4便] 退役した層B設定（verify.conflict_command）", () => {
  it("書いてあっても読めて落ちない（未知の欄を弾かない）", () => {
    const dir = repoWithConfig("verify:\n  profile: test\n  conflict_command: npm test\n");
    const loaded = loadProjectConfig(dir);
    assert.equal(loaded.verify.profile, "test", "他の欄はいままでどおり読める");
  });

  it("値が壊れていても落ちない（もう誰も使わないので検査もしない）", () => {
    // 第3便は空文字と引用符の混在を積む時点で断っていた。読み手が消えた以上、
    // ここで断るのは「使っていない設定のために起動を止める」ことになる
    for (const yaml of [
      "verify:\n  profile: test\n  conflict_command: \"\"\n",
      `verify:\n  profile: test\n  conflict_command: sh -c "echo 'x'"\n`,
    ]) {
      const dir = repoWithConfig(yaml);
      assert.equal(loadProjectConfig(dir).verify.profile, "test");
    }
  });

  it("読み取った設定に conflict_command は現れない（退役済み）", () => {
    const dir = repoWithConfig("verify:\n  profile: test\n  conflict_command: npm test\n");
    assert.equal(
      (loadProjectConfig(dir).verify as Record<string, unknown>)["conflictCommand"],
      undefined,
      "退役した設定が読み取り結果に残っていると、使えると誤読される"
    );
  });
});

describe("[realign-3] review.policy の解決", () => {
  describe("旧称 `manual` は人へ写る（既定に依らない）", () => {
    it("`manual` と書いたタスクは `banto`（人が見る）になる", () => {
      assert.equal(resolveReviewStage(task({ review: { policy: "manual" } }), config()), "banto");
    });

    /**
     * **これが本命。** 既定を `auto` にしても `manual` は `banto` のままであること。
     *
     * 実装が「`manual` を明示的に写す」のではなく「知らない値は既定へ落とす」で
     * 済ませていると、ここで落ちる——既定の反転（段3）で人を素通りする瞬間が生まれる。
     */
    it("既定が `auto` でも `manual` は `banto` のまま（既定へ落ちていない）", () => {
      assert.equal(
        resolveReviewStage(task({ review: { policy: "manual" } }), config({ defaultPolicy: "auto" })),
        "banto"
      );
    });

    it("知らない綴りは既定へ落ちる（`manual` だけを特別扱いしている）", () => {
      assert.equal(
        resolveReviewStage(task({ review: { policy: "しらない値" } }), config({ defaultPolicy: "auto" })),
        "auto"
      );
    });
  });

  describe("既定は層Bで差し替えられる（後戻りの口）", () => {
    it("層Bに何も書かなければ `DEFAULT_REVIEW_STAGE`", () => {
      assert.equal(resolveReviewStage(task(), config()), DEFAULT_REVIEW_STAGE);
    });

    it("`review.default_policy: banto` で人の承認へ戻せる", () => {
      assert.equal(resolveReviewStage(task(), config({ defaultPolicy: "banto" })), "banto");
    });

    it("`review.default_policy: auto` で自動着地へ倒せる", () => {
      assert.equal(resolveReviewStage(task(), config({ defaultPolicy: "auto" })), "auto");
    });

    it("タスク自身の宣言は層Bの既定より強い", () => {
      assert.equal(
        resolveReviewStage(task({ review: { policy: "banto" } }), config({ defaultPolicy: "auto" })),
        "banto"
      );
    });
  });

  /**
   * **緩い側の口を足しても緩みは増えないこと。** 既定を `auto` にしても、
   * 厳しい側の上書き（統治コード・PO 必須の面）は必ず勝つ。
   */
  describe("厳しい側の上書きが必ず勝つ", () => {
    it("`governance: true` は既定が `auto` でも `po`", () => {
      assert.equal(
        resolveReviewStage(task({ governance: true }), config({ defaultPolicy: "auto" })),
        "po"
      );
    });

    it("`governance: true` はタスクが `auto` を名乗っても `po`", () => {
      assert.equal(
        resolveReviewStage(task({ governance: true, review: { policy: "auto" } }), config({ defaultPolicy: "auto" })),
        "po"
      );
    });

    it("PO 必須の面に触るタスクは既定が `auto` でも `po`", () => {
      assert.equal(
        resolveReviewStage(
          task({ scope: { paths: ["packages/banto-web/src/App.tsx"] } }),
          config({ poRequiredPaths: ["packages/banto-web/**"], defaultPolicy: "auto" })
        ),
        "po"
      );
    });

    it("PO 必須の面に触るタスクは `manual` を名乗っても `po`", () => {
      assert.equal(
        resolveReviewStage(
          task({ review: { policy: "manual" }, scope: { paths: ["packages/banto-web/**"] } }),
          config({ poRequiredPaths: ["packages/banto-web/**"], defaultPolicy: "auto" })
        ),
        "po"
      );
    });
  });
});

/**
 * **2026-08-16、PO の恒久指示を機械で守る**（ADR-0013 決定66 の同日追記）。
 *
 * > 私が明示的にお願いするとき以外、banto の開発でもユーザのレビューは
 * > 省略してくれないかな。あんまり意味ないし。
 *
 * これを受けて `meta/config.yaml` の `review.po_required_paths` を空にした
 * （task-0183）。空にしても PO へ上がる道（判定1の `governance: true`・判定3の
 * 宣言 `po`）は残ることは下の「一覧が空でも」で確かめる——ここで確かめるのは
 * **設定ファイル側**、実リポジトリの `meta/config.yaml` が実際に空であることだけ。
 *
 * **パスを戻すときはこの試験も一緒に直すこと**——それが「恒久指示を上書きする」
 * という意思表示になる（`meta/config.yaml` 側のコメントにも同じ趣旨が書いてある）。
 */
describe("[task-0238] PO 必須の面（実リポジトリ設定）", () => {
  it("meta/config.yaml の review.poRequiredPaths は空である", () => {
    const loaded = loadProjectConfig(repoRoot);
    assert.deepEqual(loaded.review.poRequiredPaths, []);
  });
});

/**
 * **一覧が空でも、PO へ上がる残り2つの道は塞がっていないこと**（純関数）。
 *
 * `po_required_paths` を空にしたのは「差分を見て通す」形式のレビューだけを
 * 省く判断であって、`governance: true` や宣言 `po` まで巻き込んで自動着地に
 * 倒すものではない。ここが崩れると、空にした瞬間に PO への道そのものが
 * 無くなっていたことになる。
 */
describe("[task-0238] 一覧が空でも残る道（純関数）", () => {
  it("一覧が空なら scope が PO 必須のパスに触れても宣言 `banto` はそのまま", () => {
    assert.equal(
      resolveReviewStage(
        task({
          review: { policy: "banto" },
          scope: { paths: ["packages/banto-web/src/views/ui.tsx"] },
        }),
        config({ poRequiredPaths: [] })
      ),
      "banto"
    );
  });

  it("一覧が空でも宣言 `po` は `po` のまま", () => {
    assert.equal(
      resolveReviewStage(task({ review: { policy: "po" } }), config({ poRequiredPaths: [] })),
      "po"
    );
  });

  it("一覧が空でも `governance: true` は `po`", () => {
    assert.equal(
      resolveReviewStage(task({ governance: true }), config({ poRequiredPaths: [] })),
      "po"
    );
  });
});

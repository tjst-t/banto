/**
 * **`deploy/*.service` の再起動方針を固定する**（inc-0072 / task-0154）。
 *
 * `system.restart` は自分を落として systemd に拾わせる道具で、その終わり方は
 * `exit(0)`＝**正常終了**である（`packages/banto-host/src/restart-tool.ts`）。
 * `Restart=on-failure` は正常終了では起動し直さないので、`deploy/banto.service` が
 * `on-failure` のままだと**撃った瞬間に番頭ホストが上がってこない**。
 * 2026-08-16 の裁定は「稼働の実態＝`always` を正とし、リポジトリを合わせる」。
 * 終了コードの側は触らない。
 *
 * ## この試験の限界（隠さない・I1）
 *
 * 見ているのは**リポジトリの `deploy/*.service`** であって、稼働機にインストール済みの
 * ユニット（`/etc/systemd/system/**`）ではない。ここが緑でも「稼働機がそうなっている」
 * 証拠にはならない——固定しているのは**変更の意図**だけである。稼働機を見る試験は、
 * この器（コンテナ）からは systemd に届かないので書けない
 * （`tests/acceptance/restart-blast-radius.spec.ts` と同じ限界）。
 *
 * もうひとつ：稼働機の実効値は**ドロップイン**（`/etc/systemd/system/<unit>.d/*.conf`）を
 * 重ねた結果であり、ここで読む本体ファイルだけでは決まらない。下の期待値は
 * **2026-08-16 に稼働機と突き合わせて確定した実効値**で、突き合わせの全表は
 * `work/inbox/incident/inc-0072-deployed-unit-differs-from-repo.md` にある。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

/** `Key=` の値を全部拾う（同じ鍵が複数行あってもよい）。 */
function values(unit: string, key: string): string[] {
  return unit
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1).trim())
    .filter((value) => value.length > 0);
}

/**
 * **2026-08-16 に稼働機（`systemctl show -p Restart` と
 * `/etc/systemd/system/<unit>{,.d/*.conf}`）と突き合わせて確定した `Restart=`。**
 *
 * - `banto.service` は稼働機の実効値が `always`（本体は `on-failure` だが
 *   `banto.service.d/override.conf` が上書きしている）。上の理由でこれを正とし、
 *   リポジトリ本体を `always` に合わせた。
 * - 残り3ユニットは稼働機・リポジトリとも `on-failure` で**食い違い無し**。
 *   これらは自分で自分を `exit(0)` で落とす道具を持たないので、`on-failure` のままでよい。
 */
/** 記録（Markdown）の front matter から `key:` の値を1つ取る。無ければ undefined。 */
function frontMatterValue(document: string, key: string): string | undefined {
  const lines = document.split("\n");
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end < 0) return undefined;
  return lines
    .slice(1, end)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${key}:`))
    .map((line) => line.slice(key.length + 1).trim())[0];
}

const EXPECTED_RESTART: ReadonlyArray<readonly [string, string]> = [
  ["deploy/banto.service", "always"],
  ["deploy/banto-worker-pool.service", "on-failure"],
  ["deploy/banto-environment-pool.service", "on-failure"],
  ["deploy/banto-daemon.service", "on-failure"],
];

const INCIDENT = "work/inbox/incident/inc-0072-deployed-unit-differs-from-repo.md";

describe("[inc-0072] deploy のユニットの再起動方針が、突き合わせた実効値と揃っている", () => {
  it("deploy/banto.service は Restart=always（exit(0) の自己再起動が前提だから）", () => {
    assert.deepEqual(values(read("deploy/banto.service"), "Restart"), ["always"]);
  });

  it("deploy/banto.service に、なぜ always なのかが exit(0) に触れて書いてある", () => {
    const text = read("deploy/banto.service");
    assert.ok(
      text.includes("exit(0)"),
      "deploy/banto.service に exit(0) の理由コメントがありません" +
        "——理由が消えると、次の人が『安全側』のつもりで on-failure に戻します"
    );
  });

  it("4ユニットの Restart= が、確定した値のままである", () => {
    for (const [unit, expected] of EXPECTED_RESTART) {
      assert.deepEqual(
        values(read(unit), "Restart"),
        [expected],
        `${unit} の Restart= が ${expected} から変わっています` +
          "（変えるなら稼働機と突き合わせ直して inc-0072 を更新すること）"
      );
    }
  });
});

describe("[inc-0072] 突き合わせの結果が記録に残っている", () => {
  it("4ユニットぶんの名前が揃っている（見ていないのか無かったのかが読めるように）", () => {
    const text = read(INCIDENT);
    for (const unit of [
      "banto.service",
      "banto-worker-pool.service",
      "banto-environment-pool.service",
      "banto-daemon.service",
    ]) {
      assert.ok(text.includes(unit), `${INCIDENT} に ${unit} の突き合わせ結果がありません`);
    }
  });

  it("front matter の status が resolved になっている", () => {
    assert.equal(frontMatterValue(read(INCIDENT), "status"), "resolved");
  });
});

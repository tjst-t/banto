/**
 * **再起動で落ちる範囲を、説明文と構成の両側から固定する**（imp-0062）。
 *
 * `system.restart` の説明文は「稼働中の職人は中断される」「検証環境は cgroup の巻き添えで
 * 落ちる」と言っていたが、どちらも嘘だった（2026-08-15 実測）。職人は
 * `banto-worker-pool.service`、検証環境のコンテナは `docker-<id>.scope` に居り、
 * `banto.service` は `BindsTo` も `PartOf` も持たない——シグナルは自分の cgroup の外へ
 * 出ない。落ちるのは**走行中のターン**だけである。
 *
 * 嘘には実害が出た：番頭が「職人5件・検証環境2件を巻き込む」と要らない PO 判断を上げ、
 * いちばん危ない走行中のターンには触れなかった。**危険の在り処が入れ替わっていた。**
 *
 * ここで見るのは2つ:
 *
 * 1. **構成**（`deploy/*.service`）が、いまも「別ユニットで、縛られていない」こと
 *    ——`PartOf`／`BindsTo`／`Requires` で結ぶと、番頭ホストの再起動が本当に職人や
 *    環境を巻き込むようになる。そのときは説明文も SKILL も書き換えないと嘘に戻る
 * 2. **説明の側**（道具の `description` と SKILL `safe-restart`）が、その事実を
 *    言っていること
 *
 * ## この試験の限界（隠さない・I1）
 *
 * 見ているのは**リポジトリの `deploy/*.service`** であって、稼働機にインストール済みの
 * ユニット（`/etc/systemd/system/`）ではない。**ここが緑でも「稼働機がそうなっている」
 * 証拠にはならない**——固定できるのは**変更の意図**だけである。稼働機を見る試験は、この
 * 器（コンテナ）からは systemd に届かないので書けない。
 *
 * かつてここに書いていた `Restart=` の食い違い（稼働機は `always`、リポジトリは
 * `on-failure`）は inc-0072 / task-0154 で決着し、`deploy/banto.service` も `always` に
 * 揃っている（`Restart=` の値そのものを固定するのは `deploy-unit-restart-policy.spec.ts`、
 * 突き合わせの全表は `work/inbox/incident/inc-0072-deployed-unit-differs-from-repo.md`）。
 * ただし**限界は消えていない**：稼働機の実効値はドロップイン
 * （`/etc/systemd/system/<unit>.d/*.conf`）を重ねた結果で、本体ファイルだけでは決まらない。
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

const UNITS = [
  "deploy/banto.service",
  "deploy/banto-worker-pool.service",
  "deploy/banto-environment-pool.service",
] as const;

describe("[imp-0062] 番頭ホストの再起動は、職人と検証環境を巻き込まない", () => {
  it("どのユニットも BindsTo / PartOf を持たない（持てば巻き添えが本当になる）", () => {
    for (const unit of UNITS) {
      const text = read(unit);
      assert.deepEqual(values(text, "BindsTo"), [], `${unit} に BindsTo が増えています`);
      assert.deepEqual(values(text, "PartOf"), [], `${unit} に PartOf が増えています`);
    }
  });

  it("職人と検証環境は、番頭ホストのユニットに縛られていない", () => {
    for (const unit of UNITS.slice(1)) {
      const text = read(unit);
      const bound = [...values(text, "Requires"), ...values(text, "Requisite")];
      assert.deepEqual(
        bound.filter((v) => v.includes("banto.service")),
        [],
        `${unit} が banto.service に縛られています`
      );
    }
  });

  it("道具の説明文が、落ちるものと落ちないものを事実どおりに言う", () => {
    const source = read("packages/banto-host/src/restart-tool.ts");
    // 説明文の本体（description: の並び）だけを見る——注記のコメントには昔の嘘も引用してある
    const description = source.slice(
      source.indexOf("    description:"),
      source.indexOf("    parameters:")
    );
    assert.match(description, /走行中のターン/u, "何が切れるのかを言っていません");
    assert.match(description, /別ユニットなので\*\*落ちない\*\*|別ユニットなので落ちない/u);
    // 昔の嘘が戻っていないこと
    assert.doesNotMatch(description, /巻き添え/u);
    assert.doesNotMatch(description, /職人は中断/u);
  });

  it("SKILL safe-restart も同じ向きで、PO の承認の手順は残っている", () => {
    const skill = read("packages/banto-host/skills/safe-restart/SKILL.md");
    assert.match(skill, /走行中のターン/u);
    assert.match(skill, /banto-worker-pool\.service/u, "職人の所属を名指ししていません");
    assert.match(skill, /docker-<id>\.scope/u, "検証環境の所属を名指ししていません");
    // 手順3（PO の承認）は残す——落ちる範囲が狭くなっても、反映の可否は PO の裁定
    assert.match(skill, /\*\*PO の承認を得る\*\*/u, "PO の承認の手順が消えています");
  });

  /**
   * **落ちない＝反映もされない**（imp-0062 の追記ぶん・inc-0073）。
   *
   * 3つの常駐サービスはどれも `--import tsx` で main のチェックアウトを直に読むので、
   * 番頭本体を起こし直しても職人・検証環境のコードは古いまま残る。上の it 群が
   * 「巻き込まない」を固定するのと対で、ここは**届かない**ことを固定する。
   */
  it("道具の説明文が、起こし直すのは banto.service だけだと言う", () => {
    const source = read("packages/banto-host/src/restart-tool.ts");
    const description = source.slice(
      source.indexOf("    description:"),
      source.indexOf("    parameters:")
    );
    assert.match(description, /banto-environment-pool/u, "検証環境が別サービスだと言っていません");
    assert.match(description, /banto\.service/u, "起こし直す先を名指ししていません");
    assert.match(
      description,
      /反映されない/u,
      "別サービスの変更が反映されないことを言っていません"
    );
    // 切れた会話が自動で起こし直されること（imp-0037・imp-0061）は残す
    assert.match(description, /起こし直す/u);
    // 昔の嘘は戻さない（上の it と同じ二重の網）
    assert.doesNotMatch(description, /巻き添え/u);
  });

  it("SKILL safe-restart に3つの unit と kill -9 の手順が揃っている", () => {
    const skill = read("packages/banto-host/skills/safe-restart/SKILL.md");
    for (const unit of ["banto.service", "banto-worker-pool.service", "banto-environment-pool.service"]) {
      assert.ok(skill.includes(unit), `SKILL に ${unit} がありません`);
    }
    // 直した package → unit の対応が引けること
    for (const pkg of ["packages/banto-host", "packages/banto-worker-pool", "packages/banto-environment-pool"]) {
      assert.ok(skill.includes(pkg), `SKILL に ${pkg} の対応がありません`);
    }
    assert.match(skill, /kill -9/u, "kill -9 の手順がありません");
    assert.match(skill, /Restart=on-failure/u, "自動復帰の根拠（Restart=on-failure）がありません");
    assert.match(skill, /inc-0073/u, "反映されなかった実例（inc-0073）がありません");
  });
});

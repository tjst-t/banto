/**
 * SKILL `safe-restart` は「画面（packages/banto-web）は再起動では反映されない」ことと、
 * その確かめ方を持つ（task-0304 a2）。
 *
 * ## 背景
 *
 * 2026-08-20、task-0279 が main へ着地し4ユニット全部を起こし直したのに、PO の画面には
 * 変更が出なかった。banto.service は `packages/banto-web/dist`（ビルド成果物）を配信して
 * いるが、`system.restart` / `system.deploy` はそのプロセスを起こし直すだけで dist を
 * 作り直さない——`npm run build:web` を誰かが手で打つまで、画面側の変更は沈む。
 * SKILL がこの事実と確かめ方を持っていなければ、次の web 変更も同じ形で見落とされる。
 *
 * ## この試験の限界（隠さない・I1）
 *
 * SKILL.md の文面に必要な事実（何が反映されないか・確かめ方）が書かれていることだけを
 * 固定する。実際に curl でアセットを取得して grep する手順そのものはこの器では回せない
 * ——`tests/acceptance/deploy-unit-restart-policy.spec.ts` と同じ限界。
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

describe("[task-0304 a2] SKILL safe-restart は画面が再起動では反映されないことを持つ", () => {
  const skill = read("packages/banto-host/skills/safe-restart/SKILL.md");

  it("packages/banto-web の変更は再起動では反映されず、dist の作り直しが要ると書かれている", () => {
    assert.match(skill, /banto-web/u, "banto-web への言及がありません");
    assert.match(
      skill,
      /(再起動では反映されない|再起動だけでは反映されない)/u,
      "「再起動では反映されない」という事実が書かれていません"
    );
    assert.match(skill, /npm run build:web/u, "dist を作り直すコマンドが書かれていません");
  });

  it("正式な口（system.deploy）が画面ビルドも自動で行うことに触れている", () => {
    assert.match(skill, /system\.deploy/u);
    assert.match(skill, /画面ビルド/u, "system.deploy が画面ビルドを行うことへの言及がありません");
  });

  it("手で確かめる方法（配信中のアセットを取得して変更が入っているか見る）が書かれている", () => {
    assert.match(skill, /curl/u, "配信中のアセットを取得する手順（curl）がありません");
    assert.match(skill, /grep/u, "変更が入っているか確かめる手順（grep）がありません");
  });

  it("ビルド後はページ再読み込みで切り替わる（banto.service の再起動は不要）と書かれている", () => {
    assert.match(
      skill,
      /(再起動は要らない|再起動不要|再起動は不要)/u,
      "ビルド後の反映に banto.service の再起動が要らないことが書かれていません"
    );
  });
});

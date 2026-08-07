/**
 * **番頭と PO が使う操作は、必ず Tool 契約に在る**（ADR-0010 決定9・25、ADR-0013 決定58）。
 *
 * Kobo は2つの口を持つ（spec-daemon-core §6）：
 *
 *   - モジュールの口（`{baseUrl}/tools/*`）— **番頭と UI が使う**
 *   - REST（`/api/v1/*`）— CLI と職人の pi 拡張が使う
 *
 * REST が先に在り、モジュールの口は後から足した（task-0048/0064）。そのとき**番頭が使う
 * ものを漏らす**と、番頭にはできない操作が REST にだけ残る——実際に「プロジェクトの登録」で
 * それが起きた（SKILL に `POST /api/v1/projects` と書いたが、**番頭は任意の HTTP を叩く道具を
 * 持っていない**ので実行できなかった。PO報告 2026-08-07）。
 *
 * 見つけたのが PO だったのが問題で、**次は機械が見つける**（P4）。REST の面を読み取り、
 * 「番頭・PO が使うもの」に分類されるものが Tool にも在ることを確かめる。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { createKoboModule } from "../../packages/banto-daemon/src/kobo-module.js";

/**
 * REST の面のうち、**番頭・PO が使うもの**と、その相棒の Tool。
 *
 * 相棒が `null` のものは「番頭も PO も使わない」＝ Tool に無くてよい理由が要る。
 * ここに1行足すのは、REST を1本足したときだけ——**足し忘れると下の試験が落ちる**。
 */
const REST_SURFACE: ReadonlyArray<{
  route: string;
  tool: string | null;
  why?: string;
}> = [
  { route: "GET /api/v1/health", tool: null, why: "生死確認。番頭は Tool の失敗で気づく" },
  { route: "GET /api/v1/events", tool: "kobo.events" },
  { route: "GET /api/v1/ready", tool: "kobo.list", why: "kobo.list は state で絞れる" },
  { route: "GET /api/v1/projects", tool: "kobo.projects" },
  { route: "POST /api/v1/projects", tool: "kobo.register_project" },
  { route: "GET /api/v1/projects/:proj/tasks", tool: "kobo.list" },
  { route: "GET /api/v1/projects/:proj/tasks/:id", tool: "kobo.task" },
  { route: "GET /api/v1/projects/:proj/events", tool: "kobo.events" },
  { route: "GET /api/v1/projects/:proj/tasks/:id/events", tool: "kobo.task" },
  { route: "POST /api/v1/projects/:proj/tasks", tool: "kobo.enqueue", why: "定義はファイル（D4）" },
  {
    route: "POST /api/v1/projects/:proj/tasks/:id/transition",
    tool: "kobo.approve",
    why: "番頭が進められるのは承認だけ。任意の遷移は持たせない（決定62c：飛ばせない）",
  },
  {
    route: "POST /api/v1/projects/:proj/tasks/:id/audit-report",
    tool: null,
    why: "監査人（職人の pi 拡張）が叩く口。番頭が判定を書けてはいけない（決定57）",
  },
  { route: "GET /api/v1/tasks/:proj/:id", tool: "kobo.task" },
];

/**
 * Kobo の REST が実際に持っている面（ソースの route 定義から導く。D3）。
 *
 * **正規表現を正規表現で読まない。** 最初そう書いて、14 本あるうち 6 本しか拾えていなかった
 * ——`([^/]+)` の中の `/` に引っかかっていた。**空振りしている検査は、無い検査より悪い**
 * （通っているので直ったと読める）。いまは行ごとに拾って、素直に置き換える。
 */
function actualRestRoutes(): string[] {
  const source = fs.readFileSync(
    new URL("../../packages/banto-daemon/src/http-server.ts", import.meta.url).pathname,
    "utf-8"
  );
  const routes: string[] = [];
  let method: string | undefined;
  for (const line of source.split("\n")) {
    const methodLine = line.match(/^\s*method:\s*"(\w+)"/);
    if (methodLine) {
      method = methodLine[1];
      continue;
    }
    const patternLine = line.match(/^\s*pattern:\s*(.+?),\s*$/);
    if (!patternLine || !method) continue;
    const raw = patternLine[1]!;
    // モジュールの口（`new RegExp(...)`）は Tool そのものなので、この表の対象外
    if (!raw.startsWith("/")) {
      method = undefined;
      continue;
    }
    const path = raw
      .replace(/^\/\^/, "")
      .replace(/\$\/$/, "")
      .replace(/\(\[\^\/\]\+\)/g, ":param")
      .replace(/\\\//g, "/")
      .replace(/\\/g, "");
    routes.push(`${method} ${path}`);
    method = undefined;
  }
  return routes;
}

/** 表の書き方（`:proj` 等）を、ソースから導いた形（`:param`）に揃える。 */
function normalize(route: string): string {
  return route.replace(/:[a-zA-Z]+/g, ":param");
}

describe("[決定9・25] Kobo の REST と Tool の突き合わせ", () => {
  const tools: string[] = createKoboModule("http://127.0.0.1:1/api/kobo").tools.map(
    (t) => t.name as string
  );
  const actual = actualRestRoutes().map(normalize);
  const declared = REST_SURFACE.map((r) => normalize(r.route));

  it("**抽出が空振りしていない**（拾えた面が表と同じ数だけある）", () => {
    // 最初にこの試験を書いたとき、抽出が 14 本中 6 本しか拾えておらず、
    // **通っているのに何も見ていなかった**。数で歯止めを掛ける
    assert.ok(
      actual.length >= declared.length,
      `REST の面を ${actual.length} 本しか拾えていない（表には ${declared.length} 本）` +
        "——抽出が壊れている可能性がある"
    );
  });

  it("REST の面が表に載っている（足したら分類する）", () => {
    const missing = actual.filter((r) => !declared.includes(r));
    assert.deepEqual(
      missing,
      [],
      "REST を足したら、番頭・PO が使うかを分類してこの表に書くこと" +
        "——書かないと、番頭にはできない操作が黙って増える"
    );
  });

  it("**番頭・PO が使う面は Tool にも在る**（これが今回抜けた検査）", () => {
    const gaps = REST_SURFACE.filter((r) => r.tool !== null && !tools.includes(r.tool));
    assert.deepEqual(
      gaps.map((g) => `${g.route} → ${String(g.tool)}`),
      [],
      "REST にだけ在る操作は、番頭が実行できない（任意の HTTP を叩く道具を持たない）"
    );
  });

  it("Tool に無くてよいものには、理由が書いてある", () => {
    const unexplained = REST_SURFACE.filter((r) => r.tool === null && !r.why);
    assert.deepEqual(
      unexplained.map((r) => r.route),
      [],
      "「番頭に持たせない」は判断なので、理由を残す（後から穴と誤読される）"
    );
  });

  it("番頭に任意の状態遷移を持たせない（飛ばせない・決定62c）", () => {
    for (const forbidden of ["kobo.transition", "kobo.merge", "kobo.audit_report", "kobo.force"]) {
      assert.ok(
        !tools.includes(forbidden),
        `${forbidden} があってはいけない——番頭は進められるが飛ばせない`
      );
    }
  });
});

describe("[決定36g] 受け持たせる口も砦に通す", () => {
  it("番頭が渡すパス引数が、Tool を束ねる層で検査されている", () => {
    const bin = fs.readFileSync(
      new URL("../../packages/banto-host/src/bin.ts", import.meta.url).pathname,
      "utf-8"
    );
    // `worker.delegate` の worktreePath と同じ扱いであること
    assert.match(
      bin,
      /kobo\.register_project[\s\S]{0,200}guardPathArg\(tool, places, "repoPath"\)/,
      "登録すると工場がそこで職人を動かし、ブランチを切ってマージする——砦の外を受け持たせない"
    );
  });
});

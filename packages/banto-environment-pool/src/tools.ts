/**
 * `env.*` Tool（ADR-0010 決定34a・task-0034）。
 *
 * **高位1本と低位動詞の両立て。** `env.verify` は使い捨ての検証を一息で回して畳みまで持ち、
 * 低位動詞はレビュー用 dev server のように**居座らせたい**環境のために残す。
 * `worker.delegate`（高位）と `worker.steer` / `worker.close`（低位）と同じ形で、
 * **畳むのが主で安全弁が従**という関係も同じ（決定30b）。
 *
 * **職人には渡さない**（決定32c）。番頭が機構の返す事実として検証結果を受け取るための道具で、
 * 職人が自分の作業を自分で検証して「通りました」と言えてしまうと、決定29a
 * 「報告は主張であって完了の証明ではない」が崩れる。
 *
 * このファイルは banto-host に依存しない（Worker Pool の module.ts と同じ扱い）。
 */

import { Type } from "typebox";
import { defineNamespacedTool, type NamespacedToolDefinition } from "@banto/core";
import type { EnvironmentPool, ProvisionRequest } from "./pool.js";

/** プロファイル経由・アドホックの共通引数。どちらか一方を使う（決定34c・e）。 */
const targetFields = {
  repoPath: Type.Optional(
    Type.String({
      description:
        "プロファイルの在り処（リポジトリのルート。meta/environments.yaml を読む）。profile を使うなら必須",
    })
  ),
  profile: Type.Optional(
    Type.String({ description: "使うプロファイル名。env.list_profiles で分かる" })
  ),
  driver: Type.Optional(
    Type.String({
      description:
        "プロファイルを使わず直接指定する場合のドライバ（process / docker）。profile とは同時に使えない",
    })
  ),
  config: Type.Optional(
    Type.Object({}, { additionalProperties: true, description: "driver 指定時の設定ブロック" })
  ),
  workdir: Type.Optional(
    Type.String({
      description:
        "どこで動かすか（絶対パス）。職人が作った worktree を指せば、そこで検証できる。省略時は既定の場所",
    })
  ),
  taskId: Type.Optional(
    Type.String({ description: "何の検証かを台帳とログに残すラベル（Koboのタスクidでも自分で付けた名でもよい）" })
  ),
};

/**
 * Tool の引数を `ProvisionRequest` に写す。
 *
 * typebox の `Type.Object({}, { additionalProperties: true })` は `object` として型付くが、
 * `config` は中身を解釈しない不透明なブロック（spec-environment §2）なので、
 * ここで1回だけ形を合わせる。
 */
function asRequest(params: {
  repoPath?: string;
  profile?: string;
  driver?: string;
  config?: object;
  workdir?: string;
  taskId?: string;
}): ProvisionRequest {
  const { config, ...rest } = params;
  return {
    ...rest,
    ...(config ? { config: config as Record<string, unknown> } : {}),
  };
}

export function createEnvTools(pool: EnvironmentPool): NamespacedToolDefinition[] {
  const verify = defineNamespacedTool({
    name: "env.verify",
    label: "Env: Verify",
    description:
      "使い捨ての検証環境を立てて、コマンドを走らせて、**必ず畳む**。" +
      "「このブランチでテストが通るか確かめて」に対する道具で、結果は機構が返した事実として受け取れる" +
      "（職人の報告は主張であって完了の証明ではない）。" +
      "途中で失敗しても畳むところまで面倒を見る。畳めなかった場合は tornDown: false で返るので、" +
      "そのときは env.list で残骸を確認すること。" +
      "環境を残したい（レビュー用のdev serverを立てておく等）ときは、これではなく env.provision を使う。",
    parameters: Type.Object({
      ...targetFields,
      cmd: Type.Optional(
        Type.String({ description: "環境の中で走らせるコマンド。省略すると起動確認までで判定する" })
      ),
      artifactPath: Type.Optional(Type.String({ description: "配る成果物の絶対パス（省略可）" })),
      collectTo: Type.Optional(Type.String({ description: "成果物の回収先ディレクトリ（省略可）" })),
    }),
    async execute(params) {
      const result = await pool.verify(asRequest(params));
      const lines = [
        `${result.ok ? "通りました" : "通りませんでした"}（${result.profileName} / ${result.envId}）`,
      ];
      if (result.failure) lines.push(`理由: ${result.failure}`);
      if (result.run) {
        lines.push(`コマンドの終了コード: ${result.run.exit}`);
        if (result.run.logTail) {
          lines.push(result.run.truncated ? "ログ（末尾のみ）:" : "ログ:", result.run.logTail);
        }
      }
      // I3: 畳めなかったことを本文に出す。details だけだと番頭が気づかない
      lines.push(
        result.tornDown
          ? "環境は畳みました。"
          : `**環境が畳めていません**（${result.teardownError ?? "理由不明"}）。env.list で確認してください。`
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: result };
    },
  });

  const provision = defineNamespacedTool({
    name: "env.provision",
    label: "Env: Provision",
    description:
      "検証環境を1つ立てて**そのまま残す**。返る envId で以降の操作を指す。" +
      "レビュー用に立てておきたい場合に使う。使い捨ての検証なら env.verify の方がよい" +
      "（畳み忘れが起きない）。立てたものは必ず env.teardown で畳むこと。",
    parameters: Type.Object(targetFields),
    async execute(params) {
      const summary = await pool.provision(asRequest(params));
      return {
        content: [
          {
            type: "text" as const,
            text:
              `環境を立てました: ${summary.envId}（${summary.profileName}）\n` +
              `期限: ${summary.ttlDeadline}（過ぎると自動で畳まれます）\n` +
              "使い終わったら env.teardown で畳んでください。",
          },
        ],
        details: summary,
      };
    },
  });

  const deploy = defineNamespacedTool({
    name: "env.deploy",
    label: "Env: Deploy",
    description: "立てた環境へ成果物を配る。ドライバによっては何もしない（立てた時点で動いている）。",
    parameters: Type.Object({
      envId: Type.String({ description: "対象の環境 id" }),
      artifactPath: Type.String({ description: "配る成果物の絶対パス" }),
    }),
    async execute(params) {
      await pool.deploy(params.envId, params.artifactPath);
      return {
        content: [{ type: "text" as const, text: `配りました: ${params.envId}` }],
        details: { envId: params.envId, artifactPath: params.artifactPath },
      };
    },
  });

  const healthcheck = defineNamespacedTool({
    name: "env.healthcheck",
    label: "Env: Healthcheck",
    description: "環境が使える状態か確かめる。ここが通らないうちに走らせた結果は当てにならない。",
    parameters: Type.Object({ envId: Type.String({ description: "対象の環境 id" }) }),
    async execute(params) {
      const health = await pool.healthcheck(params.envId);
      return {
        content: [
          {
            type: "text" as const,
            text: `${params.envId}: ${health.ok ? "使えます" : "使えません"}${health.detail ? `（${health.detail}）` : ""}`,
          },
        ],
        details: { envId: params.envId, ...health },
      };
    },
  });

  const run = defineNamespacedTool({
    name: "env.run",
    label: "Env: Run",
    description:
      "環境の中でコマンドを走らせ、終了コードとログの末尾を返す。" +
      "ログは末尾だけ返る（全文はログのパスにある）。",
    parameters: Type.Object({
      envId: Type.String({ description: "対象の環境 id" }),
      cmd: Type.String({ description: "走らせるコマンド" }),
      logTailLines: Type.Optional(Type.Number({ description: "返すログの行数（既定 40）" })),
    }),
    async execute(params) {
      const result = await pool.run(params.envId, params.cmd, params.logTailLines);
      const head = `終了コード ${result.exit}${result.truncated ? "（ログは末尾のみ）" : ""}`;
      return {
        content: [{ type: "text" as const, text: [head, result.logTail].filter(Boolean).join("\n") }],
        details: result,
      };
    },
  });

  const collect = defineNamespacedTool({
    name: "env.collect",
    label: "Env: Collect",
    description: "環境から成果物（ログ・カバレッジ等）を回収する。",
    parameters: Type.Object({
      envId: Type.String({ description: "対象の環境 id" }),
      dest: Type.String({ description: "回収先ディレクトリの絶対パス" }),
    }),
    async execute(params) {
      await pool.collect(params.envId, params.dest);
      return {
        content: [{ type: "text" as const, text: `回収しました: ${params.envId} → ${params.dest}` }],
        details: { envId: params.envId, dest: params.dest },
      };
    },
  });

  const teardown = defineNamespacedTool({
    name: "env.teardown",
    label: "Env: Teardown",
    description:
      "環境を畳む。既に畳んであるものへ呼んでも問題ない。" +
      "立てた環境は使い終わったら必ず畳むこと——外に残ると費用がかかり続ける。",
    parameters: Type.Object({ envId: Type.String({ description: "対象の環境 id" }) }),
    async execute(params) {
      const result = await pool.teardown(params.envId);
      return {
        content: [
          {
            type: "text" as const,
            text: result.alreadyDone ? `${params.envId} は既に畳まれています。` : `畳みました: ${params.envId}`,
          },
        ],
        details: { envId: params.envId, ...result },
      };
    },
  });

  const list = defineNamespacedTool({
    name: "env.list",
    label: "Env: List",
    description:
      "いま立っている検証環境の一覧。畳み忘れがないかを確かめるときに引く。" +
      "同時に立てられる数には上限があるので、立てられなくなったらここを見る。",
    parameters: Type.Object({
      includeTornDown: Type.Optional(
        Type.Boolean({ description: "畳んだものも含める（既定 false）" })
      ),
      taskId: Type.Optional(Type.String({ description: "このラベルの環境だけに絞る" })),
    }),
    async execute(params) {
      const environments = pool.list(params);
      const limits = pool.currentLimits();
      const text =
        environments.length === 0
          ? "立っている環境はありません"
          : environments
              .map(
                (e) =>
                  `${e.envId} — ${e.profileName}${e.live ? "" : "（畳み済み）"} / ${e.taskId}` +
                  `${e.workdir ? ` @ ${e.workdir}` : ""} / 期限 ${e.ttlDeadline}`
              )
              .join("\n");
      return {
        content: [
          {
            type: "text" as const,
            text: `${text}\n（同時上限: 全体 ${limits.maxInstancesTotal} / プロファイルごと ${limits.maxInstancesPerProfile}）`,
          },
        ],
        details: { environments, limits },
      };
    },
  });

  const listProfilesTool = defineNamespacedTool({
    name: "env.list_profiles",
    label: "Env: List Profiles",
    description:
      "そのリポジトリで使える検証プロファイルの一覧。" +
      "上限を超えていて使えないものは、なぜ使えないかと一緒に返る。",
    parameters: Type.Object({
      repoPath: Type.String({ description: "リポジトリのルート（meta/environments.yaml を読む）" }),
    }),
    async execute(params) {
      const { usable, rejected } = pool.profiles(params.repoPath);
      const lines = usable.map((p) => `${p.name} — ${p.driver} / ttl ${Math.round(p.ttlMs / 60000)}分`);
      // I2: 弾いたものを黙って隠さない。書いた人が直せるように理由ごと出す
      for (const r of rejected) lines.push(`${r.name} — 使えません: ${r.reason}`);
      return {
        content: [
          { type: "text" as const, text: lines.length > 0 ? lines.join("\n") : "プロファイルの定義がありません" },
        ],
        details: { usable, rejected, limits: pool.currentLimits() },
      };
    },
  });

  return [verify, provision, deploy, healthcheck, run, collect, teardown, list, listProfilesTool];
}

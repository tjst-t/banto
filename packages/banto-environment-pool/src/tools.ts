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
import { COLLECTED_PLACE_ID } from "./collected-place.js";

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
  expose: Type.Optional(
    Type.Number({
      description:
        "このポートを外から見えるようにする。POがブラウザで開いて自分の目で確かめたいときに指定する" +
        "（返り値の url を伝えること）。機械が確かめるだけなら要らない",
    })
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
  expose?: number;
}): ProvisionRequest {
  const { config, ...rest } = params;
  return {
    ...rest,
    ...(config ? { config: config as Record<string, unknown> } : {}),
  };
}

/** 人が読む大きさ。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 一覧に出す状態の表示。畳み損ねを「畳み済み」と同じに見せない。 */
const STATE_LABEL: Record<string, string> = {
  live: "",
  "torn-down": "（畳み済み）",
  "teardown-failed": "（**畳み損ね**）",
};

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
      cmd: Type.String({ description: "環境の中で走らせる検証コマンド" }),
      artifactPath: Type.Optional(Type.String({ description: "配る成果物の絶対パス（省略可）" })),
      collect: Type.Optional(
        Type.Boolean({
          description:
            "成果物を取り出すか（既定 false）。置き場所は機構が決め、返り値の collected に入る",
        })
      ),
      timeoutMs: Type.Optional(
        Type.Number({ description: "検証コマンドの制限時間（ミリ秒）。省略すると既定" })
      ),
    }),
    async execute(params) {
      const result = await pool.verify({
        ...asRequest(params),
        cmd: params.cmd,
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        ...(params.collect ? { collect: true } : {}),
      });
      const passed = result.exit === 0 && result.failure === undefined;
      const lines = [
        `${passed ? "通りました" : "通りませんでした"}（${result.profile} / ${result.envId}）`,
      ];
      // I2: 走らせるところまで行かなかったことを「テストが落ちた」と読ませない
      if (result.failure) lines.push(`検証まで到達しませんでした: ${result.failure}`);
      else {
        lines.push(`コマンドの終了コード: ${result.exit}`);
        if (result.logTail) {
          lines.push(result.truncated ? "ログ（末尾のみ）:" : "ログ:", result.logTail);
        }
      }
      // I3: 畳めなかったことを本文に出す。details だけだと番頭が気づかない
      if (result.collected) {
        lines.push(`成果物: ${result.collected}（場所「${COLLECTED_PLACE_ID}」で読めます）`);
      }
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
              `環境を立てました: ${summary.envId}（${summary.profile}）\n` +
              (summary.url ? `外から見られます: ${summary.url}\n` : "") +
              `いま使えるか: ${summary.healthcheck.ok ? "使えます" : `使えません（${summary.healthcheck.detail ?? "理由不明"}）`}\n` +
              // I2: 執行が回っていないのに「自動で畳まれます」と言わない。
              // 期限だけ記録して誰も畳まない状態を「畳まれる」と読ませるのが一番危ない
              `期限: ${summary.ttlDeadline}` +
              (pool.isMaintaining()
                ? "（過ぎると自動で畳まれます）\n"
                : "（**自動では畳まれません**。期限の執行が動いていないので、必ず自分で畳んでください）\n") +
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
      timeoutMs: Type.Optional(
        Type.Number({
          description:
            "コマンドの制限時間（ミリ秒）。省略すると既定。**短くはできるが長くはできない**" +
            "（能力側の上限まで）。env.list_profiles の limits で今の値が分かる",
        })
      ),
    }),
    async execute(params) {
      const result = await pool.run(params.envId, params.cmd, params.logTailLines, params.timeoutMs);
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
    description:
      "環境から成果物（ログ・カバレッジ等）を取り出す。環境を畳むと中身は消えるので、" +
      "残したいものは畳む前に取り出す。**置き場所は指定しない**——機構が決めて返す。" +
      "返ってきた場所は読み取り専用の場所として登録されているので、file.* でそのまま読める。",
    parameters: Type.Object({
      envId: Type.String({ description: "対象の環境 id" }),
    }),
    async execute(params) {
      const { dest } = await pool.collect(params.envId);
      return {
        content: [
          {
            type: "text" as const,
            text: `取り出しました: ${dest}\n（場所「${COLLECTED_PLACE_ID}」として file.* で読めます）`,
          },
        ],
        details: { envId: params.envId, dest, place: COLLECTED_PLACE_ID },
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
      projectTag: Type.Optional(Type.String({ description: "このプロジェクトの環境だけに絞る" })),
      taskId: Type.Optional(Type.String({ description: "このラベルの環境だけに絞る" })),
    }),
    async execute(params) {
      const environments = pool.list(params);
      const limits = pool.currentLimits();
      const orphans = pool.orphans();
      const artifacts = pool.artifactUsage();
      const text =
        environments.length === 0
          ? "立っている環境はありません"
          : environments
              .map(
                (e) =>
                  `${e.envId} — ${e.profile}${STATE_LABEL[e.state]} / ${e.taskId}` +
                  `${e.url ? ` / ${e.url}` : ""}` +
                  `${e.workdir ? ` @ ${e.workdir}` : ""} / 期限 ${e.ttlDeadline}`
              )
              .join("\n");
      return {
        content: [
          {
            type: "text" as const,
            text:
              `${text}\n（同時上限: 全体 ${limits.maxInstancesTotal} / プロファイルごと ${limits.maxInstancesPerProfile}` +
              `${pool.isMaintaining() ? "" : " ・**期限の執行が動いていません**"}` +
              ` ・コマンドの制限時間 ${Math.round(limits.defaultRunTimeoutMs / 60000)}分）` +
              // spec §5: 台帳に無い実リソースは黙って隠さない。消し忘れの元
              (orphans.length > 0 ? `\n台帳に無い実リソースが ${orphans.length} 件あります（照合）` : "") +
              (artifacts.count > 0
                ? `\n回収した成果物: ${artifacts.count} 件（${formatBytes(artifacts.bytes)}）。要らなければ env.cleanup で捨てられます`
                : ""),
          },
        ],
        details: { environments, limits, orphans, artifacts, maintaining: pool.isMaintaining() },
      };
    },
  });

  const cleanup = defineNamespacedTool({
    name: "env.cleanup",
    label: "Env: Cleanup",
    description:
      "回収した成果物を捨てる。もう要らないと判断したときに使う（期限が来れば機構も捨てるが、" +
      "先に判断できるならその方が溜まらない）。" +
      "**環境の記録（台帳）は消えない**——何を立てたかの記録は残る。" +
      "どれを捨てるかは必ず指定する。全部捨てるなら olderThanDays: 0。" +
      "いまどれくらい溜まっているかは env.list の artifacts で分かる。",
    parameters: Type.Object({
      envId: Type.Optional(
        Type.String({ description: "この環境の成果物だけ捨てる" })
      ),
      olderThanDays: Type.Optional(
        Type.Number({ description: "この日数より古い成果物を捨てる（0 なら全部）" })
      ),
    }),
    async execute(params) {
      const result = pool.cleanupArtifacts(params);
      const text =
        result.removed.length === 0
          ? "捨てるものはありませんでした"
          : `${result.removed.length} 件の成果物を捨てました（${formatBytes(result.bytesFreed)} 分）\n` +
            result.removed.map((r) => `${r.envId}（${formatBytes(r.bytes)}）`).join("\n");
      return { content: [{ type: "text" as const, text }], details: result };
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

  return [verify, provision, deploy, healthcheck, run, collect, teardown, cleanup, list, listProfilesTool];
}

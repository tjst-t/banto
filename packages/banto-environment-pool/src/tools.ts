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
import { OpenObject, StringEnum, defineNamespacedTool, type NamespacedToolDefinition } from "@banto/core";
import type { EnvironmentPool, ProvisionRequest } from "./pool.js";
import { COLLECTED_PLACE_ID } from "./collected-place.js";

/**
 * プロファイル経由・アドホックの共通引数。どちらか一方を使う（決定34c・e）。
 *
 * **説明は1行ずつ**（ADR-0019 決定84-2）。`env.verify` と `env.provision` の2本に
 * 丸ごと写るので、ここが長いと定義の量が2倍で効いてくる。手順は SKILL 側へ逃がす。
 */
const targetFields = {
  repoPath: Type.Optional(Type.String({ description: "profile を使うなら必須" })),
  profile: Type.Optional(Type.String()),
  driver: Type.Optional(Type.String({ description: "process / docker。profile と併用不可" })),
  config: Type.Optional(OpenObject()),
  workdir: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.String()),
  projectTag: Type.Optional(Type.String()),
  expose: Type.Optional(Type.Number()),
  exposeProfilePort: Type.Optional(Type.Boolean()),
  exposeMode: Type.Optional(StringEnum(["auto", "proxy", "caddy"] as const)),
};

/**
 * 値の言語を明示する一行（ADR-0019 決定84-2）。
 *
 * arXiv:2601.05366 の最多の故障は `parameter value language mismatch`。`envId` の欄に
 * 「検証環境」のような日本語が入ると、機構は無い環境を指されたことしか分からない。
 */
const ENV_ID_HINT = "\nenvId は英語の識別子（env.list の値）で埋める。";

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
  projectTag?: string;
  expose?: number;
  exposeProfilePort?: boolean;
  exposeMode?: "auto" | "proxy" | "caddy";
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

/** 公開方式の表示。exp は `banto-proxy` / `caddy`（G9 (b) では proxy / caddy と呼ぶ）。 */
function exposeModeLabel(exposer: string | undefined): string {
  if (exposer === "caddy") return "caddy";
  if (exposer) return "proxy";
  return "";
}

/** `env.events` が一度に返す上限。 */
const MAX_EVENTS = 100;

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
      "使い捨ての環境を立て、コマンドを走らせ、**必ず畳む**。結果は機構が返した事実。\n例: {repoPath: \"/home/ubuntu/ghq/github.com/tjst-t/banto\", profile: \"test\", cmd: \"npm test\"} → 通ったか＋終了コード＋ログの場所（落ちたときだけ末尾）\n値は英語（パス・プロファイル名・コマンド）で埋める。",
    parameters: Type.Object({
      ...targetFields,
      cmd: Type.String(),
      artifactPath: Type.Optional(Type.String()),
      collect: Type.Optional(
        Type.Boolean()
      ),
      logTailLines: Type.Optional(Type.Number()),
      timeoutMs: Type.Optional(Type.Number())
    }),
    async execute(params) {
      const result = await pool.verify({
        ...asRequest(params),
        cmd: params.cmd,
        ...(params.logTailLines !== undefined ? { logTailLines: params.logTailLines } : {}),
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        ...(params.collect ? { collect: true } : {}),
      });
      const passed = result.exit === 0 && result.failure === undefined;
      const lines = [
        `${passed ? "通りました" : "通りませんでした"}（${result.profile} / ${result.envId}）`,
      ];
      // I2: 走らせるところまで行かなかったことを「テストが落ちた」と読ませない
      if (result.failure) lines.push(`検証まで到達しませんでした: ${result.failure}`);
      else lines.push(`コマンドの終了コード: ${result.exit}`);
      if (result.logPath) {
        lines.push(
          passed
            ? `ログの場所: ${result.logPath}（通ったので末尾は載せていません。要るときだけ読んでください）`
            : `ログの場所: ${result.logPath}`
        );
      }
      if (!passed && result.logTail) {
        lines.push(result.truncated ? "ログ（末尾のみ）:" : "ログ:", result.logTail);
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
      "環境を1つ立てて**そのまま残す**（レビュー用の dev server 等）。\n例: {repoPath: \"/home/ubuntu/ghq/github.com/tjst-t/banto\", profile: \"web\", exposeProfilePort: true} → envId と url\n値は英語で埋める。使い終わったら env.teardown。",
    parameters: Type.Object(targetFields),
    async execute(params) {
      const summary = await pool.provision(asRequest(params));
      return {
        content: [
          {
            type: "text" as const,
            text:
              `環境を立てました: ${summary.envId}（${summary.profile}）\n` +
              (summary.url
                ? `外から見られます: ${summary.url}（公開方式: ${exposeModeLabel(summary.exposer)}）\n`
                : "") +
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
    description:
      "立てた環境へ成果物を配る。ドライバによっては何もしない。\n例: {envId: \"env-04479785fc\", artifactPath: \"/home/ubuntu/build/app.tar.gz\"} → 配った旨\n値は英語（識別子・絶対パス）で埋める。",
    parameters: Type.Object({
      envId: Type.String(),
      artifactPath: Type.String()
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
    description:
      "環境が使える状態か確かめる（通らないうちの結果は当てにならない）。\n例: {envId: \"env-04479785fc\"} → \"env-04479785fc: 使えます\"" + ENV_ID_HINT,
    parameters: Type.Object({
      envId: Type.String()
    }),
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
      "立てた環境の中でコマンドを走らせ、終了コードとログの末尾を返す。\n例: {envId: \"env-04479785fc\", cmd: \"npm run typecheck\"} → \"終了コード 0\" ＋末尾40行\ncmd は英語で埋める（シェルにそのまま渡る）。",
    parameters: Type.Object({
      envId: Type.String(),
      cmd: Type.String(),
      logTailLines: Type.Optional(Type.Number()),
      timeoutMs: Type.Optional(
        Type.Number({
          description:
            "**短くはできるが長くはできない**（env.list_profiles の limits まで）"
        })
      )
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
      "環境から成果物（ログ・カバレッジ等）を取り出す。畳むと消えるので、残すなら先に。\n例: {envId: \"env-04479785fc\"} → 取り出した先のパス（file.* で読める）" + ENV_ID_HINT,
    parameters: Type.Object({ envId: Type.String() }),
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
      "環境を畳む（既に畳んであるものへ呼んでも問題ない）。外に残ると費用がかかり続ける。\n例: {envId: \"env-04479785fc\"} → \"畳みました: env-04479785fc\"" + ENV_ID_HINT,
    parameters: Type.Object({ envId: Type.String() }),
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
      "いま立っている環境の一覧（畳み忘れ・同時上限・孤児・成果物の量）。\n例: {} → \"env-04479785fc — test / task-0042 / 期限 2026-08-13T12:00:00Z\"\nprojectTag・taskId は英語の識別子で埋める。",
    parameters: Type.Object({
      includeTornDown: Type.Optional(Type.Boolean()),
      projectTag: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String())
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
                  `${e.url ? ` / ${e.url}${exposeModeLabel(e.exposer) ? `（${exposeModeLabel(e.exposer)}）` : ""}` : ""}` +
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
      "回収した成果物を捨てる（**台帳は消えない**）。溜まり具合は env.list の artifacts。\n例: {olderThanDays: 7} → 7日より古い分／{envId: \"env-04479785fc\"} → その環境の分" + ENV_ID_HINT,
    parameters: Type.Object({
      envId: Type.Optional(Type.String()),
      olderThanDays: Type.Optional(Type.Number())
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

  /**
   * 孤児を名指しで1件だけ畳む（PO裁定 2026-08-08）。
   *
   * **一括の口は用意しない。** 孤児かどうかはドライバの自己申告に依っていて、そこが
   * 間違うと他人の作業を壊す（docker ドライバが名前の綴りで所有を推測しており、無関係な
   * `myapp-docker` を孤児として挙げていた——実測で確認）。判定を記録ベースに直した後でも、
   * **誤報の代償は雑音・誤削除の代償は取り返しがつかない**という非対称は残る。
   */
  const teardownOrphanTool = defineNamespacedTool({
    name: "env.teardown_orphan",
    label: "Env: Teardown orphan",
    description:
      "台帳に無い実リソース（孤児）を**名指しで1件だけ**畳む。名前は env.list の orphans（英語の識別子）。\n例: {name: \"banto-env-9f2c1a\"} → 畳んだ旨。まとめて畳む口は無い。",
    parameters: Type.Object({ name: Type.String() }),
    async execute(params) {
      const done = await pool.teardownOrphan(params.name);
      return {
        content: [
          { type: "text" as const, text: `孤児 "${done.name}"（${done.driver}）を畳みました` },
        ],
        details: done,
      };
    },
  });

  const listProfilesTool = defineNamespacedTool({
    name: "env.list_profiles",
    label: "Env: List Profiles",
    description:
      "そのリポジトリで使える検証プロファイルの一覧（使えないものは理由つき）。\n例: {repoPath: \"/home/ubuntu/ghq/github.com/tjst-t/banto\"} → \"test — process / ttl 30分\"\nrepoPath は英語の絶対パスで埋める。",
    parameters: Type.Object({ repoPath: Type.String() }),
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

  const events = defineNamespacedTool({
    name: "env.events",
    label: "Env: Events",
    description:
      "環境の衛生に関わる出来事（期限切れ・畳み損ね・孤児）を古い順に返す。\n例: {afterEventId: 40, limit: 20} → #41 以降の20件。いま何が立っているかは env.list。",
    parameters: Type.Object({
      afterEventId: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number())
    }),
    async execute(params) {
      const limit = Math.max(1, Math.min(params.limit ?? MAX_EVENTS, MAX_EVENTS));
      const found = pool.events(params.afterEventId ?? 0, limit);
      const text =
        found.length === 0
          ? "新しい出来事はありません"
          : found
              .map((e) => `#${e.id} ${e.at} ${e.type} ${String(e.data["message"] ?? "")}`)
              .join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { events: found, lastEventId: pool.lastEventId },
      };
    },
  });

  return [
    verify,
    provision,
    deploy,
    healthcheck,
    run,
    collect,
    teardown,
    teardownOrphanTool,
    cleanup,
    list,
    listProfilesTool,
    events,
  ];
}

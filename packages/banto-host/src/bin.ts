#!/usr/bin/env node
/**
 * `banto` CLI（task-0009）。
 *
 *   banto serve            番頭ホストを常駐起動する（WS APIを開く）
 *   banto chat [--url ..]  起動中のホストへ接続し、端末から会話する
 *
 * CLI は WS APIの一クライアントに過ぎない——WebUI も同じAPIにぶら下がる
 * （Kobo と同じ形。CLAUDE.md・ADR-0010 決定6）。
 *
 * D5: 判断ロジックを持たない。組み立ては host-session.ts、配信は server.ts。
 * I2: 失敗は握りつぶさず、終了コードとメッセージで返す。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { getModel, getModels } from "@mariozechner/pi-ai";
import { AuthStorage, getAgentDir, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";
import {
  JsonlMemoryStore,
  LlmCatalog,
  ScopedMemory,
  resolveProjects,
  type Place,
  type PlaceProvider,
  type ResolvedModel,
} from "@banto/core";

import {
  PiRpcDriver,
  WorkerPool,
  createWorkerPoolModule,
  type WorkerInfo,
} from "@banto/worker-pool";
import { createKoboModule, defaultKoboUrl } from "@banto/daemon";
import {
  BANTO_ORIGIN,
  isBantoOrigin,
  renderWorkerNotice,
  threadIdOfOrigin,
  threadOrigin,
} from "./worker-notice.js";
import { guardWorkerOrigin } from "./worker-guard.js";
import { startKoboNotices } from "./kobo-notice.js";

import { Canvas, createCanvasCatalog } from "./canvas.js";
import { createCanvasTools } from "./canvas-tools.js";
import { Inbox } from "./inbox.js";
import { createInboxTools } from "./inbox-tools.js";
import { UserThemes } from "./user-themes.js";
import { createBantoHostSession } from "./host-session.js";
import { resumeInterruptedTurn, withEmptyResponseGuard } from "./turn-guard.js";
import { BantoHostClient } from "./client.js";
import { BANTO_DEFAULT_PORT, type ServerEvent } from "./protocol.js";
import { BantoHostServer } from "./server.js";
import { createArtifactTools } from "./artifact-tools.js";
import { ArtifactStore } from "./artifacts.js";
import { createLlmChapterSummarizer } from "./chapter-summarizer.js";
import { ChapterKeeper } from "./chapters.js";
import { createHandoffTools } from "./handoff-tools.js";
import { HandoffStore } from "./handoffs.js";
import { applyMemoryDeltas, createLlmMemoryExtractor } from "./memory-extraction.js";
import { createMemoryTools } from "./memory-tools.js";
import {
  LEARNED_ORIGIN,
  LearnedSkillStore,
  detectStaleOverrides,
  renderStaleOverrides,
  type StaleOverride,
} from "./skill-learning.js";
import { CORE_ORIGIN, createModuleRegistry, resolveSkills, type SkillEntry } from "./module.js";
import { createStudioModule } from "./modules/studio.js";
import { createPiAgentModule } from "./modules/pi-agent.js";
import { createLlmTools } from "./llm-tools.js";
import { createWorkspaceModule } from "./modules/workspace.js";
import { PlaceGrantStore } from "./place-grants.js";
import { ThreadStore } from "./thread-store.js";
import { SettingsStore } from "./settings-store.js";
import { createCoreSettingsSections } from "./core-settings.js";
import { createSettingsModule, settingsSection } from "./settings-module.js";
import { createRepoManagerModule, createRepoManagerPlaceProvider } from "@banto/repo-manager";
import {
  EnvironmentPool,
  ENVIRONMENT_POOL_BASE_URL,
  createCaddyExposer,
  createCollectedPlaceProvider,
  createEnvironmentPoolModule,
  createEnvProxyExposer,
} from "@banto/environment-pool";
import { workspaceRoot } from "./workspace.js";
import {
  PlaceRegistry,
  broadlyWritable,
  createStaticPlaceProvider,
  ensureDeskDir,
  withDefaultDesk,
  type StaticPlaceConfig,
} from "./places.js";
import { guardPathArg } from "./place-scoped.js";
import { createSkillTools } from "./skill-tools.js";
import { bindToolArgs, createThreadTools } from "./thread-tools.js";
import { defineNamespacedTool } from "./tool-registry.js";
import { Type } from "typebox";
import { ThreadRegistry, type ThreadFactory } from "./threads.js";
import { loadBantoSkills } from "./skills.js";

/**
 * 番頭が作業してよい場所の設定（決定36d・38b）。
 *
 * **番頭が書けない場所に置く**のが要点——リポジトリ内の設定に置くと、番頭がそれ自体を
 * 書き換えて自分の権限を広げられる（I1：ずるは不可能にする）。
 *
 * 形式：`BANTO_PLACES=<id>:<path>[:<書ける範囲をカンマ区切り>];...`
 * 例：`banto:/home/me/ghq/github.com/me/banto:docs/**,work/**`
 * 未設定なら、従来どおりワークスペース1つ（読み取り専用）。
 */
function readPlaceConfig(fallbackRoot: string): StaticPlaceConfig[] {
  const raw = process.env["BANTO_PLACES"];
  if (!raw || raw.trim().length === 0) {
    return [{ id: "workspace", label: "ワークスペース", path: fallbackRoot }];
  }
  const places: StaticPlaceConfig[] = [];
  for (const entry of raw.split(";").map((e) => e.trim()).filter((e) => e.length > 0)) {
    const [id, place, writable] = entry.split(":");
    // I2: 壊れた設定を黙って飛ばさない。場所を1つ失うと番頭が黙って別の場所を触りうる
    if (!id || !place) throw new Error(`BANTO_PLACES の項目が不正です: "${entry}"`);
    places.push({
      id,
      label: id,
      path: place,
      ...(writable ? { writable: writable.split(",").map((w) => w.trim()).filter(Boolean) } : {}),
    });
  }
  return places;
}

/**
 * いま効いている静的な場所（設定 > 環境変数）に、既定の書斎を足したもの。
 *
 * **「どれが効いているか」の判断はここ1箇所**。設定画面もこれを映すので、画面と実態が
 * 食い違わない（以前は core-settings 側にも同じ分岐があった）。
 */
function effectiveStaticPlaces(settings: SettingsStore, fallbackRoot: string): StaticPlaceConfig[] {
  const configured = settings.all().places;
  const source = configured && configured.length > 0 ? configured : readPlaceConfig(fallbackRoot);
  return withDefaultDesk(source);
}

/** 書斎の実体が無ければ作る。I2: 作ったときだけ、どこに作ったかを言う。 */
function ensureDesk(settings: SettingsStore, fallbackRoot: string): void {
  const created = ensureDeskDir(effectiveStaticPlaces(settings, fallbackRoot));
  if (created !== undefined) {
    console.log(`[banto] 書斎（成果物の置き場所）を作りました: ${created}`);
  }
}

/** データの置き場所。BANTO_DATA_DIR で差し替えられる。 */
function dataDir(): string {
  return process.env["BANTO_DATA_DIR"] ?? path.join(process.cwd(), ".banto");
}

/**
 * Kobo の帳簿の置き場所（決定63）。番頭には**どの設定でも書かせない**。
 *
 * 別プロセスなので、ここから導けない——Kobo 自身は `BANTO_DATA_DIR` を見るが、既定が
 * 違う（番頭は `./.banto`、Kobo は `./data`）ため当てにすると外す。教えてもらう。
 */
function koboDataDir(): string | undefined {
  const configured = process.env["BANTO_KOBO_DATA_DIR"];
  return configured && configured.trim().length > 0 ? path.resolve(configured) : undefined;
}

/** 人の記憶の置き場所（ADR-0003 第一層。全プロジェクト横断）。 */
function memoryPath(): string {
  return path.join(dataDir(), "memory.jsonl");
}

/**
 * プロジェクトの記憶の置き場所（ADR-0003 第二層。**横断させない**）。
 *
 * 場所ごとに別ファイルにする——同じファイルに `scope` で同居させると、絞り込みを
 * 1箇所書き忘れた時点で混ざる。ここでは混ぜようとしても混ざらない。
 *
 * 場所IDはスラッシュを含む（`github.com/tjst-t/banto`）ので、そのままではファイル名に
 * できない。`encodeURIComponent` で1階層に潰す——可逆なので、ファイルを見れば
 * どの場所のものか分かる。
 *
 * 置き場は**リポジトリの中ではなくホストのデータ置き場**。リポジトリに置くと、
 * 番頭が自分の記憶を書き換えられてしまう（決定38b と同じ理由）。
 */
function projectMemoryPath(placeId: string): string {
  return path.join(dataDir(), "projects", encodeURIComponent(placeId), "memory.jsonl");
}

/**
 * 場所の同一性を見るための実パス（PO裁定 2026-08-05：同じ場所は1プロジェクト）。
 *
 * リンクを解決してから比べる——`BANTO_PLACES` の静的な場所と repo-manager が出す
 * 同じリポジトリが、片方だけリンク越しだと別物に見える。
 *
 * 解決できないパス（まだ無い等）はそのまま返す。**畳まないだけ**で害は無い。
 */
function realPathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * 章を閉じる閾値（文脈長に対する割合）。`BANTO_CHAPTER_THRESHOLD` で変えられる。
 *
 * 既定は `DEFAULT_CHAPTER_THRESHOLD_RATIO`（0.6）。低すぎると章が増えて資料のコストが
 * 嵩み、高すぎると閉じる余力が無くなる——そこがコンパクションの失敗そのもの（提案§6 論点2）。
 *
 * I2: 読めない値・範囲外は黙って既定に落とさず知らせる。
 */
function chapterThresholdRatio(): number | undefined {
  const raw = process.env["BANTO_CHAPTER_THRESHOLD"];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    console.warn(
      `[banto] BANTO_CHAPTER_THRESHOLD は 0 と 1 の間の割合です（${raw}）。既定を使います`
    );
    return undefined;
  }
  return parsed;
}

/**
 * 章の引き継ぎ資料を書くモデル（決定28：抽出には安いモデルを使う）。
 *
 * `BANTO_CHAPTER_MODEL="provider/model-id"` で会話とは別のモデルを指定できる。
 * **指定が無ければ undefined**——呼び出し側が会話のモデルへ落とす。カタログの
 * 職人向け標準は tier（具体モデルではない）なので、ここでは当てにしない。
 *
 * I2: 指定したのに解決できないときは、黙って会話のモデルへ落とさず知らせる。
 */
function chapterSummarizerModelSpec(): { provider: string; id: string } | undefined {
  const raw = process.env["BANTO_CHAPTER_MODEL"];
  if (raw === undefined || raw.trim() === "") return undefined;
  const at = raw.indexOf("/");
  if (at <= 0 || at === raw.length - 1) {
    console.warn(`[banto] BANTO_CHAPTER_MODEL は "provider/model-id" の形です（${raw}）`);
    return undefined;
  }
  return { provider: raw.slice(0, at), id: raw.slice(at + 1) };
}

/**
 * 陳腐化した学習層について incident を積む（P3・決定26・task-0017 a4）。
 *
 * **ホストのデータ置き場に書く。** リポジトリの `work/inbox/incident/` に書きたくなるが、
 * 番頭はそこへ書けない（決定38b：自分の統制下のファイルを書き換えられないため）。
 * PO が取り込むまでの置き場としてここに残し、ログにパスを出す。
 */
function writeStaleSkillIncident(stale: readonly StaleOverride[]): string {
  const dir = path.join(dataDir(), "incidents");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `stale-skill-overrides-${stale.length}.md`);
  const body = [
    "---",
    "type: incident",
    "kind: incident",
    "origin: agent",
    "class: bug",
    "status: open",
    "refs: [adr-0010, task-0017]",
    "---",
    "",
    "## 内容",
    "",
    "番頭の学習層（SKILL）が、元にした既定より古くなっている。",
    "このまま使うと、既定側の改良が番頭に届かない（決定26 が名指しした事故）。",
    "",
    renderStaleOverrides(stale),
    "",
    "## どうするか",
    "",
    "既定の変更を読み、学習層を書き直す（`skill.learn`）か、学びが不要になっていれば",
    "捨てる（`skill.unlearn`）。**放置すると静かに劣化し続ける。**",
    "",
  ].join("\n");
  fs.writeFileSync(file, body, "utf-8");
  return file;
}

/**
 * ツール出力を退避に回す大きさ（文字数）。`BANTO_ARTIFACT_THRESHOLD` で変えられる。
 *
 * 小さすぎると番頭が毎回 `artifact.read` を叩いて往復が増え、大きすぎると退避が効かない。
 * 既定は banto-host の `DEFAULT_ARTIFACT_THRESHOLD_CHARS`（提案§6 論点4）。
 *
 * I2: 数として読めない値が入っていたら黙って既定に落とさず知らせる。
 */
function artifactThresholdChars(): number | undefined {
  const raw = process.env["BANTO_ARTIFACT_THRESHOLD"];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[banto] BANTO_ARTIFACT_THRESHOLD が読めません（${raw}）。既定を使います`);
    return undefined;
  }
  return parsed;
}

/**
 * ユーザーに見せる出力の言語。
 *
 * プロンプト本文は英語で固定し、**言語だけをここで可変にする**。マルチ言語対応は
 * この定数の差し替えで届く範囲から始められる（PO裁定 2026-08-05）。
 */
const RESPONSE_LANGUAGE = "Japanese";

/**
 * 番頭のシステムプロンプト。
 *
 * **本文は英語、出力は RESPONSE_LANGUAGE。** LLMプロバイダ層はプラガブル＝モデル非依存
 * （CLAUDE.md）なので、日本語の指示追従が弱いモデルでも役割が崩れないほうを採る。
 * 出力言語は独立した指示にしてあるので、英語で書いても応答は日本語のままになる。
 *
 * 商家の比喩（店・番頭・職人）は banto の世界観だが、**プロンプトでは比喩に寄りかからない**。
 * vision.md「番頭を『もう一人の人格』として演出することは目的ではない」とも整合する。
 * 役割語は Terms で一度定義してから使い、以降は機構の名前（worker / place / canvas）で書く。
 *
 * 依頼主は "user" と呼ぶ。"PO"（product owner）は本人の心持ちであって製品として定義する
 * ものではない、というPO裁定（2026-08-05）。略語のまま渡すと purchase order とも読める。
 *
 * 会話の名付け（PO要望 2026-08-05）：機構は thread.rename、いつ呼ぶかの判断はここ。
 */
const SYSTEM_PROMPT = `# Role

You are banto, an agent that runs software development work on behalf of the user.
You are not the one who writes the code. Delegate hands-on work — investigation, implementation, review — to workers, and spend your own context on remembering how things got here and on deciding what to do next (D10).

# Language

Write everything the user sees in ${RESPONSE_LANGUAGE}: chat replies, thread names, and any notes or records you write to files.

# Terms

- **user** — the person you are talking to. They own this product and hold final decision authority.
- **worker** — a separate agent process you start with worker.delegate. A worker has no memory, so every piece of context it needs must be written into the instruction you give it.
- **place** — a directory you can work against: a repository, a worktree, or a scratch area. List them with place.list; tools take a \`place\` argument saying which one you mean.
- **canvas** — a display area you can open on the user's screen, for things that are hard to convey in text.

# Memory and conversation

- When something worth remembering across conversations comes up — the user's preferences, habits, standing decisions — save it with memory.save.
- To show the user something, open it with canvas.open (canvas.list_catalog tells you what can be opened).
- Once you know what this conversation is about, name it with thread.rename. Rename it again whenever the topic moves on: the user picks conversations by tab name, so a stale first-topic name — or "会話 3" — tells them nothing about the contents. Keep the name short, around 15 characters. Do not rename for a brief digression or for a continuation of the same topic.

# Delegating to workers

- Delegate hands-on work — investigation, implementation — with worker.delegate (D10). skill.read gives you worker-delegation, which covers how to write the instruction.
- Reports and questions from workers reach you automatically. **A report is the worker's own claim, not proof that the work is done.** Verify the result yourself when it matters. Answer questions with worker.steer.
- Once you are satisfied, end the worker with worker.close. A worker waiting for an answer stays alive as a process. Closing keeps the record, and worker.wake resumes the original session if you want to continue.

# Files and git

- file.* and git.* let you read the contents and history of a place.
- file.write lets you write your own output — decision records, tickets, notes — but **only within the scope the user has granted for that place**, and every place is read-only by default. If a write is refused, ask for the scope with place.request_write, and open place.permissions with canvas.open so the user can grant it on the spot. Asking alone does not grant it.
- Work that changes code goes to a worker. Do not write it yourself (D10).
- You do not have git write operations (commit, push, branch). Delegate them to a worker — what gets written stays uncommitted and goes through the user's review.

# Verification

- Run verification with env.verify. The mechanism brings the environment up, runs the command, and always tears it down, so the result counts as **a verified fact** rather than a worker's claim.
- When you want the user to see something with their own eyes, pass ports to env.provision's expose and it returns a url. You do not need this when only a machine has to check. Use env.provision only when the environment must stay up for review, and tear it down with env.teardown when you are done.`;
/**
 * 再起動後に中断していた職人を自動で起こす（task-0050）。
 *
 * banto が `system.restart` や SIGTERM で終了したとき、職人のセッション JSONL は
 * Worker Pool のデータディレクトリに残っている。`WorkerPool.wake()` は元のセッションを
 * 再開し、pi に `--session` を渡して同じ会話から続けられる。
 *
 * 一覧（`WorkerPool.list({ includeClosed: true })`）から `state` が `"closed"` の職人を
 * 全て探し、`wake()` で起こし直す。
 *
 * unsafe な worker（`system.restart` / `reboot` / `systemctl` / 検証用 worktree）を
 * 除外して再有効化（task-0057）。
 */


/**
 * 台帳に無いモデルを、実体のプロバイダ/モデルへ紐付ける最小の定義（D6）。
 *
 * pi は API リクエストに `model.id` をそのまま使うため、id は API が受け付ける値で
 * なければならない。`Mimo V2.5 Free` という名前で動く実体は opencode-go の `mimo-v2.5`
 * （input に image を含む）——指定文字列のまま解決すると opencode が 401 を返す
 * （実際に踏んだ）。表示用の id/name は設定で選んだ文字列のままにする
 * （bin.ts で ModelInfo へは modelId を渡す）。台帳に登録されたらここから外すこと。
 */
const MODEL_ALIASES: Record<string, { provider: string; id: string }> = {
  "Mimo V2.5 Free": { provider: "opencode-go", id: "mimo-v2.5" },
};

/**
 * LlmCatalog 用のモデル解決器を作る。
 * pi の ModelRegistry / getModel / getModels を LlmCatalog に渡す。
 */
function createModelResolver(registry: ModelRegistry) {
  return {
    find(provider: string, modelId: string): ResolvedModel | undefined {
      const alias = MODEL_ALIASES[modelId];
      const actualProvider = alias?.provider ?? provider;
      const actualId = alias?.id ?? modelId;

      const custom = registry.find(actualProvider, actualId);
      if (custom) {
        const m = custom as { provider: string; id: string; name?: string; input?: string[] };
        return { provider: m.provider, id: m.id, name: m.name ?? m.id, input: m.input ?? [] };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const known = getModel(actualProvider as any, actualId as any);
      if (known) {
        return { provider: known.provider, id: known.id, name: known.name ?? known.id, input: known.input ?? [] };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const siblings = getModels(actualProvider as any);
      if (!siblings || siblings.length === 0) return undefined;

      return { ...siblings[0]!, id: actualId, name: modelId };
    },
    getKnownModels(provider: string): Array<{ id: string; name?: string; input?: string[] }> | undefined {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const models = getModels(provider as any);
      return models;
    },
  };
}

interface ServeOptions {
  port: number;
  /** 待ち受けるアドレス。既定は localhost のみ（決定40）。 */
  host?: string;
}

async function serve(options: ServeOptions): Promise<void> {
  /**
   * 起動が終わるまでイベントループを掴んでおく（inc-0020）。
   *
   * ドライバ側の根の原因（unref した handle からの応答を待つ）は直したが、
   * ここは**起動中の非同期処理すべて**に効く一般の守り。ref された handle が
   * 何も無い瞬間があると、Node は「やることが無い」と判断して **await の途中で
   * 黙って exit 0 する**——ログにもエラーにも何も残らない。
   *
   * 起動が終わるまでホストが抜けないことを、呼ぶ側の都合に依らず保証する。
   * 待ち受け始めればサーバのソケットがループを保つので、そこで放す。
   */
  const startupKeepAlive = setInterval(() => {}, 1 << 30);

  // task-0047: 保存された設定。**番頭が書けない場所**に置く（決定38b）
  const settings = new SettingsStore(path.join(dataDir(), "settings.json"));

  // 提案§3.2: 章の引き継ぎ資料。会話データとして置く（リポジトリは汚さない）
  const handoffs = new HandoffStore(path.join(dataDir(), "handoffs"));

  /**
   * 場所ID → プロジェクトID の写し（PO裁定 2026-08-05）。
   *
   * ワークツリーの記憶は親リポジトリのものとして扱う。**写しで持つ**のは、
   * 記憶のストアを開くのが同期の経路（`ScopedMemory.forProject`）で、場所の導出は
   * 非同期（`gwq` を叩く）だから。場所を一覧するたびに更新する（`rememberProjectIds`）。
   */
  const projectIds = new Map<string, string>();
  /** 別名で同じ場所を指していた組（警告を1度だけ出すために覚える）。 */
  const warnedAliases = new Set<string>();
  const rememberProjectIds = (list: readonly Place[]): { scopes: Array<{ id: string; label: string }> } => {
    // シンボリックリンクを解決してから同一性を見る（リンク越しの別名も同じ場所）
    const resolved = resolveProjects(list, (place) => realPathOrSelf(place.path));
    for (const [placeId, projectId] of resolved.idByPlace) projectIds.set(placeId, projectId);
    // I2: 別名を畳んだことは黙っていない——別名側のファイルに記憶が残っていると、
    //     覚えたはずのことが消えて見える
    for (const [canonical, others] of resolved.aliases) {
      const stranded = others.filter((id) => fs.existsSync(projectMemoryPath(id)));
      if (stranded.length === 0) continue;
      const key = `${canonical}:${stranded.join(",")}`;
      if (warnedAliases.has(key)) continue;
      warnedAliases.add(key);
      console.warn(
        `[banto] 場所 ${stranded.join(" / ")} は ${canonical} と同じ場所です。` +
          `プロジェクトの記憶は ${canonical} に一本化されますが、` +
          `${stranded.map((id) => projectMemoryPath(id)).join(" / ")} に古い記憶が残っています`
      );
    }
    return { scopes: resolved.scopes };
  };
  /** 写しに無ければ自分自身を返す。**推測で親を作らない**（別プロジェクトに混ぜない） */
  const projectIdFor = (placeId: string): string => projectIds.get(placeId) ?? placeId;

  // ADR-0003 の二層。人の記憶は1つ、プロジェクトの記憶は**プロジェクトごと**（横断させない）
  const memory = new ScopedMemory(
    new JsonlMemoryStore(memoryPath()),
    (placeId) => new JsonlMemoryStore(projectMemoryPath(projectIdFor(placeId)))
  );
  const skills = loadBantoSkills();
  // 決定26・task-0017: SKILL の学習層。番頭が書けない場所に置く（決定38b と同じ理由）
  const learnedSkills = new LearnedSkillStore(path.join(dataDir(), "skills"));
  const workspace = workspaceRoot();

  // 決定36：番頭が作業してよい場所。既定は BANTO_WORKSPACE（従来どおり1つ）。
  // BANTO_PLACES で複数を与えられる（決定36d：静的な場所はホスト設定。モジュールにしない）。
  //
  // **設定を先に登録する。** 同じ場所が両方から出たとき先勝ちなので、書き込みを許した
  // 設定側が、repo-manager が返す読み取り専用の同じリポジトリに負けないようにする（決定38a）。
  // 決定38c: POが後から許した範囲。保存先はホストのデータ置き場——リポジトリの中に置くと
  // 番頭が宣言を書き換えて自分の権限を広げられる（決定38b。file.write の砦がここを守っている）
  const grants = new PlaceGrantStore(path.join(dataDir(), "place-grants.json"));
  // 設定に場所が入っていればそれが真実、無ければ環境変数（決定41）。
  // **毎回読み直す**ので、設定画面で変えるとその場で効く（D3：ファイルは意図）
  const staticPlaces: PlaceProvider = {
    name: "static",
    list: async () => createStaticPlaceProvider(effectiveStaticPlaces(settings, workspace)).list(),
  };
  const places = new PlaceRegistry([staticPlaces, createRepoManagerPlaceProvider()], grants);
  ensureDesk(settings, workspace);
  for (const place of broadlyWritable(await places.list())) {
    // 決定38e：広く許したことを黙って通さない
    console.warn(
      `[banto] 場所 "${place.id}" は広い書き込み範囲（${(place.writable ?? []).join(", ")}）を許しています`
    );
  }

  // 決定25・27: モジュールを1箇所で登録する。Tool・GUI・SKILL はここから束ねて配る。
  // Kobo は接続後に、同じ口から登録される。
  //
  // Worker Pool は**必須の組み込みモジュール**（決定27c）。無いと番頭は職人へ委譲できず
  // D10 が構造的に満たせない。Banto に同居させる形で立て、到達先は相対パスにする
  // （独立サービスとして別に立てる場合は BANTO_WORKER_POOL_URL で絶対URLを指す）。
  //
  // 決定29: 職人が報告・質問を返す先。職人は別プロセスなので絶対URLが要る
  // （UI 向けの相対パスとは別物——UI は自分のオリジンに解決できるが、子プロセスはできない）。
  // 決定39: 検証環境を外から見えるようにする口。既定は番頭ホスト自身が中継する
  // ——どこでも動き、banto を守っている認証をそのまま継承する。Caddy を持つ配置では
  // BANTO_CADDY_ADMIN + BANTO_ENV_DOMAIN でサブドメイン公開へ差し替える
  const caddyAdmin = settings.all().network?.caddyAdmin ?? process.env["BANTO_CADDY_ADMIN"];
  const envDomain = settings.all().network?.envDomain ?? process.env["BANTO_ENV_DOMAIN"];
  const envProxy = createEnvProxyExposer({
    baseUrl: ENVIRONMENT_POOL_BASE_URL,
    ...(settings.all().network?.publicUrl ?? process.env["BANTO_PUBLIC_URL"]
      ? { publicBaseUrl: (settings.all().network?.publicUrl ?? process.env["BANTO_PUBLIC_URL"])! }
      : {}),
  });
  // G9 (b): 公開方式は env.provision の exposeMode で選べる。auto は
  // 「caddy の口が設定されていれば caddy、無ければ proxy」——設定はここで分かっている
  const caddy = caddyAdmin && envDomain ? createCaddyExposer({ adminUrl: caddyAdmin, baseDomain: envDomain }) : undefined;
  if (caddyAdmin && !envDomain) {
    // I2: 半端な設定を黙って既定へ落とさない（Caddy のつもりで中継されると気づけない）
    throw new Error("BANTO_CADDY_ADMIN を設定するなら BANTO_ENV_DOMAIN も要ります。");
  }
  const environmentPool = new EnvironmentPool({
    dataDir: path.join(dataDir(), "environment-pool"),
    exposers: { proxy: envProxy, ...(caddy ? { caddy } : {}) },
    // 決定32d: 復号鍵は Environment Pool が持つ。sops の標準の環境変数から取る
    // ——これを渡さないと credentials 付きのプロファイルが使えない
    ...(process.env["SOPS_AGE_KEY_FILE"]
      ? { sopsAgeKeyFile: process.env["SOPS_AGE_KEY_FILE"] }
      : {}),
    // spec §5: 畳み損ね・孤児はPOへ知らせる。Kobo のケイデンスはまだ配線されていないので
    // 番頭の会話へ流す——ログと画面だけでは、開くまで気づけない（I3）
    onAttention: (message) => {
      void server?.notify(`【検証環境】${message}`, { source: "system" }).catch((err: unknown) => {
        console.error(`[env] 知らせを届けられませんでした: ${String(err)}`);
      });
    },
  });
  // spec-environment §5: 執行は Environment Pool の台帳が行う。**ここで回さないと
  // 番頭が立てた環境を誰も片付けない**——Kobo 側の tick は台帳が別で対象外（I3）
  // 保存された上限を起動時に効かせる（設定画面で変えた値が次の起動でも生きる）
  environmentPool.applyLimits(
    (settings.all().modules?.["environment-pool"] ?? {}) as Partial<
      ReturnType<typeof environmentPool.currentLimits>
    >
  );
  environmentPool.startMaintenance();
  // imp-0007 の裁定: 回収した成果物を**読める場所**として出す。置き場所を Pool が決める
  // だけだと、番頭は取り出したものを読めない（砦の外なので file.read が弾く）
  places.add(createCollectedPlaceProvider(environmentPool.collectedRoot()));

  // task-0048: 常駐時は UI も自分で配る。既定は packages/banto-web/dist（ビルドしていれば）
  const webDir =
    process.env["BANTO_WEB_DIST"] ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "banto-web", "dist");

  // 決定40: 既定は localhost。広げるのは明示的な指定だけ
  const bindHost =
    options.host ?? settings.all().network?.bind ?? process.env["BANTO_HOST_BIND"] ?? "127.0.0.1";
  if (bindHost !== "127.0.0.1" && bindHost !== "localhost") {
    // 黙って広い口を開けない（決定36d の場所の警告と同じ考え方）
    console.warn(
      `[banto] ${bindHost} で待ち受けます。**Banto は認証を持ちません**——` +
        "前段（Caddy 等）で守られていない経路から、記憶・書き込み・検証環境の" +
        "credentials 経路に直接届きます"
    );
  }

  const workerPoolUrl = process.env["BANTO_WORKER_POOL_URL"] ?? "/api/worker-pool";
  const reportUrl = workerPoolUrl.startsWith("/")
    ? `http://localhost:${options.port}${workerPoolUrl}`
    : workerPoolUrl;

  // LLM Catalog の初期化（ADR-0004）。pi の設定を読み、banto のオーバーレイと統合する
  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
  modelRegistry.refresh();

  const workerPoolSettings = (settings.all().modules?.["worker-pool"] ?? {}) as Record<string, unknown>;
  const llmCatalog = new LlmCatalog({
    authJsonPath: path.join(agentDir, "auth.json"),
    modelsJsonPath: path.join(agentDir, "models.json"),
    overlayPath: path.join(dataDir(), "llm-registry.json"),
    resolver: createModelResolver(modelRegistry),
    migration: {
      workerProvider: workerPoolSettings["provider"] as string | undefined,
      workerModel: workerPoolSettings["model"] as string | undefined,
    },
  });

  // 職人の既定は tier で持つ（ADR-0004）。具体モデルは catalog が解決する。
  // driver の defaultProvider/defaultModel は catalog が解決できないときの最後の受け皿。
  const workerFallback = llmCatalog.resolveForWorker();
  const workerDriver = new PiRpcDriver({
    sessionBaseDir: path.join(dataDir(), "worker-sessions"),
    catalog: llmCatalog,
    ...(workerFallback
      ? {
          defaultProvider: workerFallback.model.provider,
          defaultModel: workerFallback.model.id,
        }
      : {}),
  });
  const workerPool = new WorkerPool({
    driver: workerDriver,
    dataDir: path.join(dataDir(), "worker-pool"),
    defaultProjectTag: "banto",
    defaultOrigin: BANTO_ORIGIN,
    reportUrl,
    ...(typeof settings.all().modules?.["worker-pool"]?.["idleTimeoutMs"] === "number"
      ? { idleTimeoutMs: settings.all().modules!["worker-pool"]!["idleTimeoutMs"] as number }
      : {}),
  });
  // 職人の復帰は Worker Pool 自身が起動時にやる（決定44）。前回の起動時刻の置き場を渡す
  const workerPoolModule = createWorkerPoolModule(
    workerPool,
    workerPoolUrl,
    path.join(dataDir(), "worker-pool")
  );

  // 決定26 の層を解いた SKILL（番頭核＋モジュール）。studio はこれをそのまま見せる
  const coreSkills: SkillEntry[] = skills.map((skill) => ({ skill, origin: CORE_ORIGIN }));

  // ADR-0011 決定42: LLM は中核のドメイン。モジュールではなく中核の Tool として持つ
  const llmTools = createLlmTools({
    catalog: llmCatalog,
    onWorkerTierChanged: () => {
      // 既定 tier が変われば、解決の受け皿も新しい tier のものに揃える
      const next = llmCatalog.resolveForWorker();
      if (next) {
        workerDriver.setDefaults({ provider: next.model.provider, model: next.model.id });
      }
    },
  });

  // 決定38b・63: どの設定でも書かせない置き場。**自分の分だけでは足りない**——
  // Kobo の帳簿（イベントログ・登録簿）も番頭には触れないことが機構で担保されている
  // 必要がある。いまは「場所として登録していないから書けない」という配置任せだった。
  // Kobo は別プロセスで置き場所は配置の問題なので、教えてもらう（`BANTO_KOBO_DATA_DIR`）。
  // **守れているかは起動ログに出す**——設定し忘れが黙って穴になるのを避ける
  const protectedPaths = [dataDir(), ...(koboDataDir() ? [koboDataDir()!] : [])];
  console.log(`[banto] 書き込み禁止の置き場: ${protectedPaths.join(", ")}`);
  if (!koboDataDir()) {
    console.warn(
      "[banto] Kobo の帳簿の置き場が分かりません（BANTO_KOBO_DATA_DIR 未設定）。" +
        "その置き場が「場所」として登録されると、番頭が帳簿を書き換えられます（決定63）"
    );
  }

  // 決定25・27b: Kobo は**独立プロセス**なので、載るのは実装ではなく到達先。
  // 立っていなくても登録はする——`kobo.*` が消えると番頭は「工場が無い」ではなく
  // 「積み方を知らない」状態になり、自分で実装を始めてしまう（D10 が崩れる）。
  // 立っているかは起動時に一度だけ確かめてログに出す（黙って届かない状態を作らない）
  const koboUrl = defaultKoboUrl();
  const koboModule = createKoboModule(koboUrl);

  const modules = createModuleRegistry([
    createWorkspaceModule(places, { protectedPaths }, grants),
    workerPoolModule,
    koboModule,
    createRepoManagerModule(),
    // 決定32c・34: 番頭は Kobo 無しでも検証を回せる。「テストが通った」を職人の主張ではなく
    // 機構の返す事実として受け取るための実行能力（決定29a）
    // 中継はこのモジュールが自分の到達先の下で捌く（決定27・39）
    createEnvironmentPoolModule(
      environmentPool,
      ENVIRONMENT_POOL_BASE_URL,
      envProxy,
      settingsSection(settings, "environment-pool")
    ),
    // task-0050: pi coding agent の接続情報表示（LLM 管理は llm-registry が担当）
    createPiAgentModule(),
  ]);

  // 設定モジュールは他モジュールの宣言を集めるので、レジストリが揃ってから登録する（決定41）
  modules.register(
    createSettingsModule({
      core: createCoreSettingsSections(settings, {
        llmCatalog,
        // いま効いている場所をそのまま映す（画面と実態を食い違わせない）。
        // 保存が無いときの起動時指定も、既定の書斎も、ここに含まれる
        effectivePlaces: () =>
          effectiveStaticPlaces(settings, workspace).map((c) => ({
            id: c.id,
            path: c.path,
            ...(c.writable ? { writable: [...c.writable] } : {}),
          })),
        onPlacesChanged: () => ensureDesk(settings, workspace),
      }),
      modules,
      store: settings,
    })
  );

  // studio は他モジュールの SKILL も見せるので、レジストリが揃ってから登録する
  modules.register(
    createStudioModule({
      memory,
      // **毎回解き直す**（学習層を含む3層。決定26）。起動時に1回解いた配列を渡すと、
      // 番頭が `skill.learn` で学んだ手順が再起動まで画面に出ず、番頭と PO で見え方が割れる
      skills: () =>
        resolveSkills([
          learnedSkills.list().map((e) => ({ skill: e.skill, origin: LEARNED_ORIGIN })),
          coreSkills,
          modules.skills(),
        ]),
      // ADR-0003 の第二層をビューアが切り替えられるようにする。
      // **プロジェクト単位に畳む**——ワークツリーごとにチップが並ぶと、同じリポジトリの
      // 記憶が5つに分かれているように見えてしまう（実際には1つ）
      places: async () => rememberProjectIds(await places.list()).scopes,
    })
  );

  // 決定44: モジュールの起動時処理。レジストリが揃ってから、待ち受ける前に一度だけ。
  // 中核は「何をするか」を知らない——職人の復帰も Worker Pool が自分で決める
  const initFailures = await modules.init();
  for (const f of initFailures) {
    console.error(`[banto] モジュール "${f.module}" の起動処理が失敗しました: ${f.error}`);
  }

  // 決定26・task-0017 a4: 既定が変わったオーバーライドを見つける。
  //
  // **黙って古いまま使わない**（P3）。学習層が既定の改良を隠したまま効き続けると、
  // モジュールを直しても番頭には永久に届かない——層A資産が「静かに劣化する」典型。
  // 起動時に一度だけ検査し、見つかったら incident を積む。
  const staleOverrides = detectStaleOverrides(learnedSkills.list(), skills);
  if (staleOverrides.length > 0) {
    const incident = writeStaleSkillIncident(staleOverrides);
    console.error(
      `[banto] 学習層の SKILL が既定より古くなっています（${staleOverrides.length} 件）:\n` +
        `${renderStaleOverrides(staleOverrides)}\n` +
        `[banto] incident を積みました: ${incident}`
    );
  }

  const catalog = createCanvasCatalog(modules.views());

  /**
   * 取次（受け口）。**会話に紐づかない**——どの会話を見ていても、POを待たせている
   * ものは同じ1つの列にある。記録は追記だけのイベントログで、起動時に読み直す。
   */
  const inbox = new Inbox(path.join(dataDir(), "inbox.jsonl"));

  /** 持ち込みのテーマ。置くだけで足せる（作り直しが要らない）。 */
  const userThemes = new UserThemes(path.join(dataDir(), "themes"));

  /**
   * モデルの出どころは**「番頭の標準」ひとつだけ**（PO裁定 2026-08-04）。
   *
   * 以前は起動時の指定（`--model` / `BANTO_MODEL` / 設定ファイル）が標準より優先していた。
   * 設定画面で標準を変えても起動のたびに元へ戻り、画面の表示と実際が食い違う——
   * 置き場所を1つにして、設定画面が唯一の入口になるようにした（D3）。
   */
  const hostDefault = llmCatalog.defaults().host;
  const provider = hostDefault?.provider;
  const modelId = hostDefault?.model;
  const resolvedModel = llmCatalog.resolveHostDefault();
  // createBantoHostSession は pi-ai の Model 型を要求するため、modelRegistry から取得
  const model = resolvedModel
    ? modelRegistry.find(resolvedModel.provider, resolvedModel.id) ?? getModel(resolvedModel.provider as any, resolvedModel.id as any)
    : undefined;
  const currentModelId = modelId;
  const currentProvider = provider;

  /**
   * プロバイダ／モデル名からハーネスのモデル実体へ。使えない組み合わせは undefined。
   * 戻り値は pi の `Model`（セッションの組み立てと差し替えにそのまま渡す）。
   */
  function resolveModel(wantProvider: string, wantId: string): typeof model {
    const found = llmCatalog.resolveExact(wantProvider, wantId);
    if (!found) return undefined;
    return (
      modelRegistry.find(found.provider, found.id) ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getModel(found.provider as any, found.id as any)
    );
  }

  /**
   * 新しい会話が使うモデル。**毎回カタログの「番頭の標準」を引き直す**——
   * 設定画面で標準を変えたら、次に開く会話からその場で効く（PO報告 2026-08-04：
   * 以前は起動時に解決した1つを使い回していて、設定が配線されていなかった）。
   */
  function defaultModelForNewThread(): { provider: string; id: string } | undefined {
    const fromCatalog = llmCatalog.defaults().host;
    if (fromCatalog) return { provider: fromCatalog.provider, id: fromCatalog.model };
    // カタログに標準が無ければ、起動時に解決したもので始める
    if (currentProvider && currentModelId) return { provider: currentProvider, id: currentModelId };
    return undefined;
  }

  // スレッド1本分の器を作る（決定2・task-0035）。**キャンバスはスレッドごと**——
  // ここを共有すると、ある会話で GUI を開いたときに別の会話の表示まで変わる。
  //
  // 記憶は全スレッドで共有する（D11：番頭は記憶を持つ。分裂させない）。
  let threads: ThreadRegistry;
  let server: BantoHostServer;
  const threadFactory: ThreadFactory = async (threadId, resumeFrom, wantedModel) => {
    const canvas = new Canvas(catalog);
    // 記憶・SKILLのToolは createBantoHostSession が内部で足すので、ここでは渡さない。
    // canvas.* / thread.* / llm.* は Banto 中核自身のドメイン（決定27a・ADR-0011 決定42）で
    // モジュールではない。番頭は常にこれらを持つ。
    const ownTools = [
      ...createCanvasTools(canvas, catalog),
      // 取次は会話に紐づかないが、積むのは会話の中の番頭なので Tool は各会話に配る
      ...createInboxTools(inbox),
      ...llmTools,
      ...createThreadTools({
        threads,
        // 名前を付け直す宛先は**この会話**に固定する（番頭に threadId を書かせない）
        threadId,
        // 出所は「別の会話」。職人の報告と同じ札で出さない（PO報告 2026-07-31）
        seed: (threadId, message) => server.notify(message, { threadId, source: "thread" }),
      }),
      // レベル1（PO裁定）: banto 自身の再起動。exit(0) で終わり、systemd の Restart=always が
      // 起動し直す。職人・検証環境の始末は KillMode=control-group の cgroup 巻き添えで成立する
      // （ユニットの Restart=always への変更は PO が実施する——ここでは exit(0) するだけでよい）
      defineNamespacedTool({
        name: "system.restart",
        label: "System: Restart",
        description:
          "banto ホスト自身を再起動する。全クライアントに通知してから graceful に終了し、" +
          "systemd（Restart=always）が起動し直す。会話は保存済みで、再起動後に続きから話せる。" +
          "稼働中の職人は中断されるが、記録は残り worker.wake で再開できる。" +
          "検証環境は cgroup の巻き添えで落ちるので、事前に env.list で確認すること",
        parameters: Type.Object({}),
        async execute() {
          // 通知を必ず届けてから終わる——送信が終わる前に死なない（I2）
          await server.notify(
            "これから再起動します。会話は保存済みで、再起動後に続きから話せます。",
            { source: "system" }
          );
          // notify は broadcast を直ちに流すが、クライアントに届く猶予を少し残す
          await new Promise((resolve) => setTimeout(resolve, 300));
          // graceful に閉じる（全スレッドの後始末＋WS/HTTPのclose。SIGTERM の shutdown と同じ）
          await server.close();
          // Restart=always なら systemd が起動し直す。テスト環境では単に終了する
          process.exit(0);
        },
      }),
      // 決定35a: 職人の報告は**起こしたスレッド**へ返る。番頭に自分の threadId を
      // 書かせず、ここで固定して渡す（番頭は自分がどのスレッドかを知らない）
      ...modules.tools().map((tool) => {
        if (tool.name === "worker.delegate") {
          const bound = bindToolArgs(tool, { origin: threadOrigin(threadId) });
          // 決定36g：職人の作業場所を砦に通す。いままで無検査で、番頭が任意の
          // ディレクトリを職人に書き換えさせられた
          return guardPathArg(bound, places, "worktreePath");
        }
        // 決定63：**自分が起こしていない職人は畳めない。** Kobo の職人を番頭が畳むと、
        // Kobo は動いているつもりのまま実体が消える（Worker Pool 側には置けない——
        // 呼び出し元を区別できるのは束ねているこの層だけ）
        if (tool.name === "worker.close" || tool.name === "worker.stop") {
          return guardWorkerOrigin(tool, threadOrigin(threadId), async (sessionId) =>
            workerPool.get(sessionId)
          );
        }
        // 決定58: 工場に積んだ仕事の知らせも**積んだスレッド**へ返る。職人と同じ機構で、
        // 宛先は番頭に書かせずここで固定する（番頭は自分がどのスレッドかを知らない）
        if (tool.name === "kobo.enqueue") {
          return bindToolArgs(tool, { origin: threadOrigin(threadId) });
        }
        // 決定36g：**番頭が任意のパスを渡せる口は砦に通す。** 受け持たせるリポジトリも同じ
        // ——登録すると工場がそこで職人を動かし、ブランチを切ってマージする
        if (tool.name === "kobo.register_project") {
          return guardPathArg(tool, places, "repoPath");
        }
        return tool;
      }),
    ];
    // task-0036: 番頭の文脈をディスクへ書く。**ここが inMemory だと再起動で全部消える**
    // ——画面の記録（ThreadStore）を戻しても、番頭は何も覚えていない状態になる。
    // 復元のときは元のファイルを開き直し、続きから話せるようにする
    const sessionDir = path.join(dataDir(), "threads", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionManager =
      resumeFrom && fs.existsSync(resumeFrom)
        ? SessionManager.open(resumeFrom, sessionDir, process.cwd())
        : SessionManager.create(process.cwd(), sessionDir);

    /**
     * この会話のモデル。**保存されていたもの > 番頭の標準**の順で決める。
     * 標準はカタログから毎回引き直すので、設定を変えれば次の会話から効く。
     */
    const wanted = wantedModel ?? defaultModelForNewThread();
    const threadModel = wanted ? resolveModel(wanted.provider, wanted.id) : undefined;
    // I2: 保存されていたモデルが使えなくなっていたら黙って別のモデルで開かない
    if (wanted && !threadModel) {
      console.warn(
        `[banto] ${threadId}: ${wanted.provider}/${wanted.id} を解決できないため、` +
          "起動時のモデルで開きます"
      );
    }
    const sessionModel = threadModel ?? model;

    // ADR-0003: この会話で効くプロジェクト。登録されている場所の記憶だけが注入され、
    // それぞれ見出しの下に分かれて載る（どのプロジェクトの話かが混ざらない）。
    //
    // **ワークツリーは親リポジトリに畳む**（PO裁定 2026-08-05）。畳まないと、同じ
    // リポジトリのブランチの数だけ見出しが増え、記憶もその数だけ分かれる
    const registered = await places.list();
    const memoryPlaces = rememberProjectIds(registered).scopes;

    // 提案§3.1: ツール出力の退避先。**会話ごと**——別の会話の観測を引けると、
    // スレッドごとに文脈を分けている意味（決定35a）が崩れる
    const artifacts = new ArtifactStore(path.join(dataDir(), "artifacts", threadId));

    const { session } = await createBantoHostSession({
      systemPrompt: SYSTEM_PROMPT,
      tools: ownTools,
      memory,
      memoryPlaces,
      // ワークツリーのIDで指されても断らない——記憶は親に畳まれる（projectIdFor）
      knownPlaceIds: () => [...memoryPlaces.map((p) => p.id), ...registered.map((p) => p.id)],
      artifacts,
      ...(artifactThresholdChars() !== undefined
        ? { artifactThresholdChars: artifactThresholdChars()! }
        : {}),
      moduleSkills: modules.skills(),
      learnedSkills,
      sessionManager,
      modelRegistry,
      ...(sessionModel ? { model: sessionModel } : {}),
    });
    // imp-0016: ツールコール（git status / file.read など）の後、次の LLM 応答が空
    // （text/toolCall なし・stopReason "stop"）だと pi が正常終了としてターンを閉じ、
    // 応答が止まる。withEmptyResponseGuard が空応答を continue() で再試行する。
    // 再試行はガードの中で完結するので、server は HostSession 契約のまま無変更（決定3）
    const guardedSession = withEmptyResponseGuard(session);

    // 提案§3.2: pi の自動コンパクションを切り、章立てに置き換える。
    //
    // **要約器は本セッションと別の呼び出し**（決定28）。安いモデルがカタログにあれば
    // それを使い、無ければこの会話のモデルで書く。要約器を用意できないときは
    // 章立てを始めない——引き継ぎ無しで文脈だけ畳むのが最悪だから（I2）。
    const wantedSummarizer = chapterSummarizerModelSpec();
    const summarizerModel = wantedSummarizer
      ? resolveModel(wantedSummarizer.provider, wantedSummarizer.id)
      : undefined;
    // I2: 指定したのに解決できないときは黙って落とさず知らせる
    if (wantedSummarizer && !summarizerModel) {
      console.warn(
        `[banto] BANTO_CHAPTER_MODEL（${wantedSummarizer.provider}/${wantedSummarizer.id}）を` +
          "解決できません。会話のモデルで引き継ぎ資料を書きます"
      );
    }
    const writerModel = summarizerModel ?? sessionModel;
    let chapters: ChapterKeeper | undefined;
    if (writerModel) {
      chapters = new ChapterKeeper({
        session,
        store: handoffs,
        threadId,
        summarize: createLlmChapterSummarizer({
          model: writerModel,
          auth: (m) => modelRegistry.getApiKeyAndHeaders(m),
        }),
        // 閾値は**会話のモデル**の文脈長で測る（要約器の文脈長ではない）
        ...(sessionModel?.contextWindow ? { contextWindow: sessionModel.contextWindow } : {}),
        // PO指摘 2026-08-05: 退避した観測の索引を引き継ぎ資料へ書く。
        // 渡さないと、畳んだ番頭は栞（artifact のID）を見失う
        artifacts,
        // 決定28: 記憶の抽出は章の境界だけで走る（explicit gate）。人の記憶へ入れる
        // ——プロジェクト固有の話は場所が特定できないので、ここでは横断層に入れない
        extractMemories: async (transcript) => {
          const person = memory.forPerson();
          const deltas = await createLlmMemoryExtractor({
            model: writerModel,
            auth: (m) => modelRegistry.getApiKeyAndHeaders(m),
          })({ transcript, existing: person.list() });
          const applied = applyMemoryDeltas(person, deltas);
          for (const { delta, reason } of applied.skipped) {
            console.warn(`[banto] 記憶を足しませんでした（${reason}）: ${JSON.stringify(delta)}`);
          }
          if (applied.added.length + applied.corrected.length > 0) {
            console.log(
              `[banto] ${threadId}: 記憶を ${applied.added.length} 件追加・` +
                `${applied.corrected.length} 件訂正しました（次の章から効きます）`
            );
          }
        },
        ...(chapterThresholdRatio() !== undefined
          ? { thresholdRatio: chapterThresholdRatio()! }
          : {}),
        onChapterClosed: (record) => {
          // 畳んだことは隠さない。番頭が細部を覚えていないときに PO が気づける
          server.notify(
            `ここまでを第${record.chapter}章として畳みました（${record.summary.topic}）。` +
              "前のやり取りは失われていません——詳細が要るときは番頭が引き継ぎ資料を読みます。",
            { threadId, source: "system" }
          );
        },
      });
      chapters.start();
    } else {
      console.warn(
        `[banto] ${threadId}: 要約に使えるモデルが無いため章立てを始めません` +
          "（文脈は pi の自動コンパクションのままです）"
      );
    }

    // server はイベントの wire名→論理名 逆引きに、登録した論理名のToolを必要とする
      const tools = [
        ...ownTools,
        ...createMemoryTools(memory, {
          knownPlaceIds: () => [...memoryPlaces.map((p) => p.id), ...registered.map((p) => p.id)],
        }),
        ...createSkillTools(skills, { learned: learnedSkills, defaults: skills }),
        ...createArtifactTools(artifacts),
        ...createHandoffTools(handoffs, threadId),
      ];
    return {
      session: guardedSession,
      canvas,
      tools,
      // この会話が実際に使っているモデル。画面と索引へ出す（会話ごとに持つ）
      ...(threadModel && wanted
        ? {
            model: {
              provider: wanted.provider,
              id: wanted.id,
              vision: threadModel.input.includes("image"),
              ...(threadModel.contextWindow ? { contextWindow: threadModel.contextWindow } : {}),
            },
          }
        : {}),
      getLastError: () => session.agent.state.errorMessage,
      ...(sessionManager.getSessionFile() ? { sessionFile: sessionManager.getSessionFile()! } : {}),
      // imp-0016 主対策: 再起動で進行中ターンが失われたスレッド（最後が toolResult）を
      // 復元時に再開する。resumeInterruptedTurn は「最後が toolResult のときだけ continue()
      // する」ので、新規スレッド（履歴なし）では何もしない
      resumePendingTurn: async () => {
        void resumeInterruptedTurn(session);
      },
      dispose: () => {
        chapters?.stop();
        session.dispose();
      },
    };
  };

  // task-0036: 会話はホストの再起動を越えて残る
  const threadStore = new ThreadStore(path.join(dataDir(), "threads"));
  threads = new ThreadRegistry(threadFactory, threadStore);
  await threads.restore();
  // 残っていた会話が1本も無ければ新しく開く。宛先が無いと threadId 省略のメッセージを捌けない
  const restored = threads.list({ state: "open" });
  const defaultThread = restored[0] ?? (await threads.open());
  if (restored.length > 0) {
    console.log(`[banto] 会話を ${threads.list().length} 本読み戻しました`);
  }

  server = await BantoHostServer.start({
    threads,
    inbox,
    userThemes,
    port: settings.all().network?.port ?? options.port,
    catalog,
    modules,
    // ADR-0011 決定42: 中核の Tool も HTTP に出す（中核由来のGUIの到達先）
    coreTools: llmTools,
    // task-0048: ビルド済み UI があれば同じポートで配る（常駐させるときの形）
    ...(webDir ? { webDir } : {}),
    // 画像添付の可否判定（/api/model）。id は指定されたモデル名のまま
    // （解決で API 送信用 id に変わる場合があるため——MODEL_ALIASES）。vision は
    // 解決されたモデルの能力（input に image があるか）から求める
    ...(model && currentModelId
      ? {
          model: {
            id: currentModelId,
            vision: model.input.includes("image"),
            ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
          },
        }
      : {}),
    ...(currentProvider ? { modelProvider: currentProvider } : {}),
    /**
     * 画面からモデルを変える口（決定：番頭は具体モデルを持つ／ADR-0004）。
     *
     * **開いている会話すべてに効かせて、既定としても保存する**——番頭は連続した一人で、
     * 会話ごとに別の頭になったりしないし、再起動で選び直させるのも筋が悪い。
     * I2: 解決できない・ハーネスが対応していないときは throw して、画面を前のままにする。
     */
    onSelectModel: async (thread, nextProvider: string, nextId: string) => {
      const next = resolveModel(nextProvider, nextId);
      if (!next) throw new Error(`${nextProvider}/${nextId} は使えるモデルの一覧にありません`);
      if (!thread.session.setModel) {
        throw new Error("このハーネスは動作中のモデル切替に対応していません");
      }
      // **その会話だけ**に効かせる。他の会話は自分のモデルのまま（PO裁定 2026-08-04）
      await thread.session.setModel(next);
      console.log(`[banto] model(${thread.id}): ${nextProvider}/${nextId}`);
      return {
        id: nextId,
        vision: next.input.includes("image"),
        ...(next.contextWindow ? { contextWindow: next.contextWindow } : {}),
      };
    },
    // 決定40: 既定は localhost のみ。Banto は認証を持たず、守るのは前段の役目——
    // 全インターフェースで待つと前段を素通りできてしまい、その裁定が成り立たない
    host: bindHost,
  });

  // 待ち受け始めた＝サーバのソケットがイベントループを保つので、掴みを放す（inc-0020）
  clearInterval(startupKeepAlive);

  // 決定36g: 再起動で中断したターンを復元——server.start() 後に配信が始まるので、
  // 購読を張る前に resumePendingTurn を済ませておく
  for (const thread of threads.list()) {
    await thread.resumePendingTurn?.();
  }

  // 決定29: 番頭が起こした職人のイベントだけを受ける。他の起動元（Kobo 等）の分は届かない。
  // lastEventId から始めるので、起動前に溜まっていた古い報告を今さら会話へ流し込まない。
  //
  // 決定35a: 宛先は**起こしたスレッド**。origin を見て振り分ける（Worker Pool 側の
  // 絞り込みは1つの origin しか取れないため、ここで前置きの一致を見る）。
  const unsubscribeWorkers = workerPool.subscribe(
    (event) => {
      if (!isBantoOrigin(event.origin)) return;
      const notice = renderWorkerNotice(event);
      if (!notice) return;
      const threadId = threadIdOfOrigin(event.origin);
      void server.notify(notice, { ...(threadId ? { threadId } : {}), source: "worker" }).catch((err: unknown) => {
        // 決定35b: 宛先スレッドが畳まれていたら起こし直して届ける——のが本筋だが、
        // 起こし直せるのは会話が残っている場合（task-0036 の永続化）。いまは既定スレッドへ
        // 逃がし、消えたことにしない（I2：答え手のいない質問を黙って捨てない）
        console.error(`[banto] 知らせの宛先 ${String(threadId)} が見つかりません: ${String(err)}`);
        void server.notify(notice, { source: "worker" });
      });
    },
    { afterEventId: workerPool.lastEventId }
  );

  // 決定58: 工場の判断待ちは**積んだスレッド**へ返る。別プロセスなので引きに行く形
  // （`afterEventId` で、落ちている間に起きたことも取りこぼさない）
  const stopKoboNotices = startKoboNotices({
    tools: koboModule.tools,
    notify: (message, target) =>
      server.notify(message, { ...target, source: "kobo" }),
    cursorPath: path.join(dataDir(), "kobo-cursor.json"),
  });
  // 立っているかを一度だけ確かめる。I2: 届かない相手を「何も無い」と混同しない
  void fetch(`${koboUrl.replace(/\/api\/kobo$/, "")}/api/v1/health`)
    .then((res) => {
      console.log(`[banto] kobo: ${koboUrl}（${res.ok ? "応答あり" : `応答 ${res.status}`}）`);
    })
    .catch(() => {
      console.warn(
        `[banto] kobo: ${koboUrl} へ届きません。積む・読む（kobo.*）は失敗します——` +
          "工場を使うなら banto-daemon を起動してください"
      );
    });

  console.log(`[banto] listening on ws://localhost:${server.port}/ws`);
  console.log(
    `[banto] model: ${model ? `${model.provider}/${model.id}` : "(pi の既定解決)"}`
  );
  console.log(`[banto] memory: ${memoryPath()}`);
  console.log(`[banto] skills: ${skills.map((s) => s.name).join(", ") || "(none)"}`);
  console.log(`[banto] canvas: ${catalog.list().map((c) => c.kind).join(", ") || "(none)"}`);
  console.log(`[banto] workspace: ${workspace}`);
  console.log(`[banto] worker report url: ${reportUrl}`);
  console.log(`[banto] default thread: ${defaultThread.title} (${defaultThread.id})`);
  console.log(
    `[banto] modules: ${modules.list().map((m) => `${m.name}(${m.endpoint.baseUrl})`).join(", ") || "(none)"}`
  );

  const shutdown = (): void => {
    void (async () => {
      unsubscribeWorkers();
      stopKoboNotices();
      workerPool.dispose();
      // server.close() が全スレッドの後始末（購読解除＋対話ループの dispose）まで行う
      await server.close();
      threads.dispose();
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function chat(url: string): Promise<void> {
  let resolveTurn: (() => void) | undefined;

  const onEvent = (event: ServerEvent): void => {
    switch (event.type) {
      case "welcome":
        console.log(`[banto] connected (session ${event.sessionId})`);
        console.log(`[banto] tools: ${event.tools.join(", ") || "(none)"}\n`);
        break;
      case "text_delta":
        process.stdout.write(event.delta);
        break;
      case "tool_start":
        console.log(`\n[tool] ${event.name} ...`);
        break;
      case "tool_end":
        console.log(`[tool] ${event.name} ${event.isError ? "failed" : "ok"}`);
        break;
      case "turn_end":
        if (event.errorMessage) console.error(`\n[banto] error: ${event.errorMessage}`);
        console.log("\n");
        resolveTurn?.();
        break;
      case "error":
        console.error(`[banto] ${event.message}`);
        resolveTurn?.();
        break;
    }
  };

  const client = await BantoHostClient.connect(url, onEvent);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on("close", () => {
    client.close();
    process.exit(0);
  });

  const ask = (): void => {
    rl.question("> ", (line) => {
      const text = line.trim();
      if (text.length === 0) {
        ask();
        return;
      }
      const turn = new Promise<void>((resolve) => {
        resolveTurn = resolve;
      });
      client.send({ type: "prompt", text });
      void turn.then(ask);
    });
  };
  ask();
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  switch (command) {
    case "serve": {
      const host = flag("host") ?? process.env["BANTO_HOST_BIND"];
      await serve({
        port: Number(flag("port") ?? process.env["BANTO_PORT"] ?? BANTO_DEFAULT_PORT),
        ...(host ? { host } : {}),
      });
      break;
    }
    case "chat":
      await chat(flag("url") ?? `ws://localhost:${BANTO_DEFAULT_PORT}`);
      break;
    default:
      console.error(
        "usage: banto <serve|chat> [--port N] [--host ADDR] [--url ws://host:port]\n" +
          "  モデルは設定画面（LLM・モデル）で選ぶ。起動時には指定しない。\n" +
          "  --host は待ち受けるアドレス（既定 127.0.0.1）。Banto は認証を持たないので、\n" +
          "  外に出すなら前段（Caddy 等）で守ること"
      );
      process.exit(2);
  }
}

// I2: 起動時の失敗は静かに終わらせず、原因を出して非ゼロ終了する
main().catch((err: unknown) => {
  console.error(`[banto] ${String(err)}`);
  process.exit(1);
});

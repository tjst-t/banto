/**
 * タスクの**記録ファイル**（`work/tasks/task-NNNN.md`）を Kobo が書く（第4便）。
 *
 * ## 何が変わったか
 *
 * 以前このファイルは**入力**だった——番頭が md を書き、watcher が読んで積んだ。
 * いまは**記録**である。契約は `kobo.enqueue` の引数から凍り（決定62c）、Kobo が
 * 採番して、その契約をここに書き出す。**読み戻して契約を作り直す経路は無い**。
 *
 * ## なぜ書くのか（読まないのに）
 *
 * 帳簿（イベントログ）は JSON の並びで、人が追うものではない。PO と番頭が
 * 「何を頼んだか」を後から読む先はこの md であり、git の履歴に残る形で
 * リポジトリに置いておく必要がある。**状態は書かない**——状態の真実は帳簿だけ
 * （D3）。ここに載るのは積んだ時点の契約と依頼の本文である。
 *
 * D3: 積んだ後は**更新しない**。実行時状態（いまどの状態か）は一切書かない
 * D6: YAML ライブラリを足さない。書き手は `@banto/core` の手書きパーサが
 *     読み戻せる部分集合だけを使い、書いた直後に読み戻して確かめる
 * I2: 書けない・読み戻せないときは黙って成功にしない（呼び手が積むのをやめる）
 * P1: 触るのは登録済みリポジトリの `work/tasks/` だけ
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { validateTaskFrontmatter } from "@banto/core";

/** 記録ファイルの置き場（リポジトリからの相対）。 */
export const TASKS_DIR = path.join("work", "tasks");

/**
 * 番頭が `kobo.enqueue` で渡す契約（＝道具の入力そのもの）。
 *
 * `id` が無いのは**採番が Kobo の責務**だから（第4便 4-3）。`status` が無いのは
 * 積んだ時点で `queued` に決まっているから。`origin` は契約ではなく宛先なので
 * ここには入らない。
 */
export interface TaskContractInput {
  title: string;
  kind: string;
  /** 依頼の本文。職人への指示にそのまま書き切られる（task-0060） */
  body: string;
  scope: { paths: string[] };
  /** `id` は Kobo が a1, a2… と振る（番頭は書かない） */
  acceptance: Array<{ text: string; verify?: string }>;
  parent?: string;
  depends?: string[];
  refs?: string[];
  environment?: string;
  governance?: boolean;
  model_tier?: "reasoning" | "standard" | "fast";
  hypothesis?: { expect: string; metric: string; horizon?: string };
  review?: { policy: "auto" | "banto" | "po" | "manual" };
}

/** 記録に落ちた契約（`id` が振られた後）。 */
export interface TaskContract extends Omit<TaskContractInput, "acceptance"> {
  acceptance: Array<{ id: string; text: string; verify?: string }>;
}

/**
 * 改訂で**差し替えられる項目**（`kobo.amend` の入力）。渡した項目だけが変わる。
 *
 * `kind` / `parent` / `depends` / `refs` / `governance` / `hypothesis` は入っていない
 * ——**タスクの正体が変わる**ものは改訂ではなく別のタスク（`kobo.supersede`）である。
 * `acceptance` は**全件**を id つきで渡す（一部だけだと、消したのか触っていないのか
 * 読めない）。
 */
export interface TaskContractAmendment {
  title?: string;
  body?: string;
  scope?: { paths: string[] };
  acceptance?: Array<{ id: string; text: string; verify?: string }>;
  environment?: string;
  model_tier?: "reasoning" | "standard" | "fast";
  review?: { policy: "auto" | "banto" | "po" | "manual" };
}

/** タスク定義（記録）ファイルの場所。**パスは規約で決まる**（番頭から受け取らない）。 */
export function taskFilePath(repoPath: string, taskId: string): string {
  return path.join(repoPath, TASKS_DIR, `${taskId}.md`);
}

// ── 採番 ──────────────────────────────────────────────────────────────────────

/** `task-NNNN` の NNNN だけを取る。合わないものは数えない。 */
function taskNumberOf(name: string): number | null {
  const m = /^task-(\d{4,})/.exec(name);
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 次の `task-NNNN` を払い出す（4桁ゼロ埋め）。
 *
 * **ファイル名の最大と帳簿の最大の両方**を見て +1 する（PO 指示）。片方だけだと
 * ずれる：記録ファイルを消せば番号が再利用され（帳簿と衝突する）、逆に帳簿だけを
 * 見ると、過去に slug 付きで置かれた md（`task-0062-amendment-path.md`）を追い越せない。
 *
 * `ledgerTaskIds` は**そのプロジェクトの**タスク id を渡すこと（帳簿は全プロジェクト
 * 横断で、id はプロジェクトごとの名前空間・spec-multi-project §2）。`task-NNNN` の形を
 * していない id（試験の `task-A` など）は数えない。
 *
 * I2: 読めないディレクトリは投げる（呼び手が「積めなかった理由」にする）。
 * D6: fs のみ。
 */
export function nextTaskNumber(tasksDir: string, ledgerTaskIds: readonly string[]): string {
  let max = 0;

  if (fs.existsSync(tasksDir)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(tasksDir);
    } catch (err) {
      throw new Error(`採番できません（${tasksDir} を読めない）: ${String(err)}`);
    }
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      const n = taskNumberOf(name);
      if (n !== null && n > max) max = n;
    }
  }

  for (const id of ledgerTaskIds) {
    const n = taskNumberOf(id);
    if (n !== null && n > max) max = n;
  }

  return String(max + 1).padStart(4, "0");
}

/** 番頭が渡した受け入れ基準に `a1, a2…` を振る。 */
export function assignAcceptanceIds(
  acceptance: ReadonlyArray<{ text: string; verify?: string }>
): Array<{ id: string; text: string; verify?: string }> {
  return acceptance.map((a, i) => ({
    id: `a${i + 1}`,
    text: a.text,
    ...(a.verify !== undefined ? { verify: a.verify } : {}),
  }));
}

// ── 書き出し ──────────────────────────────────────────────────────────────────

/**
 * 手書きパーサが読み戻せる形のスカラー。
 *
 * **引用符で囲まない。** `@banto/core` の `stripQuotes` は入れ子の引用符を戻せないので、
 * `verify: npm test -- --grep "x"` は**囲わずそのまま**書くのが正しい——block 形式なら
 * 値は行末まで取られるので、囲う必要が無い。囲うと、値の末尾が `"` のときだけ
 * 外側と誤認されて1文字欠ける。
 *
 * I2: 行を割る文字（改行）は書けない。呼び手が先に弾く（`checkWritable`）。
 */
function scalar(value: string): string {
  return value;
}

/** `["a", "b"]`。**要素に `"` や `,` を含めない**ことは `checkWritable` が保証する。 */
function inlineArray(values: readonly string[]): string {
  return `[${values.map((v) => `"${v}"`).join(", ")}]`;
}

/**
 * 契約を記録ファイルの中身（frontmatter＋本文）にする。
 *
 * 受け入れ基準は **block 形式**で書く（inline object `{...}` は値の中の引用符で
 * 壊れる。`parseBlockSequence` の注を参照）。
 */
export function renderTaskRecord(taskId: string, contract: TaskContract): string {
  const lines: string[] = ["---", `id: ${taskId}`, "type: task", `kind: ${scalar(contract.kind)}`];
  lines.push(`title: ${scalar(contract.title)}`);
  // **積んだ時点の意図**。状態の真実は帳簿（D3）——ここは後から書き換えない
  lines.push("status: queued");
  // この md を書いたのは Kobo であって番頭ではない、と読み手に分かるようにしておく
  // （検証も payload も無視する任意キー）
  lines.push("written_by: kobo");

  if (contract.parent !== undefined) lines.push(`parent: ${scalar(contract.parent)}`);
  if (contract.depends !== undefined && contract.depends.length > 0) {
    lines.push(`depends: ${inlineArray(contract.depends)}`);
  }
  if (contract.refs !== undefined && contract.refs.length > 0) {
    lines.push(`refs: ${inlineArray(contract.refs)}`);
  }
  if (contract.environment !== undefined) lines.push(`environment: ${scalar(contract.environment)}`);
  if (contract.governance !== undefined) lines.push(`governance: ${contract.governance ? "true" : "false"}`);
  if (contract.model_tier !== undefined) lines.push(`model_tier: ${contract.model_tier}`);

  lines.push("scope:");
  lines.push(`  paths: ${inlineArray(contract.scope.paths)}`);

  lines.push("acceptance:");
  for (const a of contract.acceptance) {
    lines.push(`  - id: ${a.id}`);
    lines.push(`    text: ${scalar(a.text)}`);
    if (a.verify !== undefined) lines.push(`    verify: ${scalar(a.verify)}`);
  }

  if (contract.hypothesis !== undefined) {
    lines.push("hypothesis:");
    lines.push(`  expect: ${scalar(contract.hypothesis.expect)}`);
    lines.push(`  metric: ${scalar(contract.hypothesis.metric)}`);
    if (contract.hypothesis.horizon !== undefined) {
      lines.push(`  horizon: ${scalar(contract.hypothesis.horizon)}`);
    }
  }

  if (contract.review !== undefined) {
    lines.push("review:");
    lines.push(`  policy: ${contract.review.policy}`);
  }

  lines.push("---", "");
  return `${lines.join("\n")}${contract.body.trim()}\n`;
}

// ── 書ける形か・書いたものが読み戻せるか ───────────────────────────────────────

/**
 * 手書き YAML（D6）で**書けない値**を先に弾く。
 *
 * 黙って書いて壊れた記録を残すより、積む前に断る（I2）。制約は3つだけ：
 *   - frontmatter に載る値に**改行を入れない**（1行1値のパーサなので割れる）
 *   - inline array の要素（`scope.paths` / `depends` / `refs`）に `"` と `,` を入れない
 *   - 単独の値を `[` `{` `---` で始めない（配列・オブジェクト・frontmatter の閉じと
 *     見分けがつかない）
 *
 * 本文（body）は制約なし——frontmatter の後ろは行単位で読まないので何でも書ける。
 */
export function checkWritable(contract: TaskContract): { ok: true } | { ok: false; reason: string } {
  const oneLine = (label: string, value: string): string | null =>
    /[\r\n]/.test(value) ? `${label} に改行は書けません（1行で書いてください）: ${JSON.stringify(value.slice(0, 40))}…` : null;
  /** frontmatter の**単独の値**として書けるか（block 形式の text / verify は対象外） */
  const plainScalar = (label: string, value: string): string | null => {
    const nl = oneLine(label, value);
    if (nl) return nl;
    const head = value.trimStart();
    if (head.startsWith("[") || head.startsWith("{")) {
      return `${label} を \`[\` や \`{\` で始めることはできません（配列・オブジェクトと読まれます）`;
    }
    if (head.startsWith("---")) return `${label} を \`---\` で始めることはできません`;
    return null;
  };

  const problems: Array<string | null> = [
    plainScalar("title", contract.title),
    plainScalar("kind", contract.kind),
    contract.parent !== undefined ? plainScalar("parent", contract.parent) : null,
    contract.environment !== undefined ? plainScalar("environment", contract.environment) : null,
  ];

  for (const [label, values] of [
    ["scope.paths", contract.scope.paths],
    ["depends", contract.depends ?? []],
    ["refs", contract.refs ?? []],
  ] as const) {
    for (const v of values) {
      problems.push(oneLine(label, v));
      if (v.includes('"') || v.includes(",")) {
        problems.push(`${label} の要素に " と , は使えません: ${JSON.stringify(v)}`);
      }
    }
  }

  for (const a of contract.acceptance) {
    problems.push(oneLine(`受け入れ条件 ${a.id} の text`, a.text));
    if (a.verify !== undefined) problems.push(oneLine(`受け入れ条件 ${a.id} の verify`, a.verify));
  }

  if (contract.hypothesis) {
    problems.push(plainScalar("hypothesis.expect", contract.hypothesis.expect));
    problems.push(plainScalar("hypothesis.metric", contract.hypothesis.metric));
    if (contract.hypothesis.horizon !== undefined) {
      problems.push(plainScalar("hypothesis.horizon", contract.hypothesis.horizon));
    }
  }

  const found = problems.filter((p): p is string => p !== null);
  return found.length > 0 ? { ok: false, reason: found.join(" / ") } : { ok: true };
}

/**
 * 書いた記録が**そのまま読み戻せるか**を確かめる（第4便・PO 採用）。
 *
 * 契約は道具の入力から凍る（決定62c）ので、読み戻しが多少ずれても契約自体は壊れない。
 * それでも確かめるのは、**読めない記録は記録ではない**から——PO と番頭が後から
 * 読む先がこの md で、そこに書いたつもりの受け入れ条件が欠けていたら、
 * 帳簿と実物が食い違ったまま誰も気づかない（D3）。
 *
 * I2: 食い違ったら「書けた」と言わない。呼び手は積むのをやめる。
 */
export function verifyRoundTrip(
  taskId: string,
  contract: TaskContract,
  content: string
): { ok: true } | { ok: false; reason: string } {
  const validation = validateTaskFrontmatter(content);
  if (!validation.ok) {
    return { ok: false, reason: `書いた記録を読み戻せません: ${validation.reason}` };
  }
  const fm = validation.frontmatter;

  const mismatches: string[] = [];
  const eq = (label: string, a: unknown, b: unknown): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      mismatches.push(`${label}（書いた: ${JSON.stringify(a)} / 読めた: ${JSON.stringify(b)}）`);
    }
  };

  eq("id", taskId, fm.id);
  eq("title", contract.title, fm.title);
  eq("kind", contract.kind, fm.kind);
  eq("scope.paths", contract.scope.paths, fm.scope.paths);
  eq("acceptance", contract.acceptance, fm.acceptance);
  eq("parent", contract.parent, fm.parent);
  eq("depends", contract.depends, fm.depends);
  eq("refs", contract.refs, fm.refs);
  eq("environment", contract.environment, fm.environment);
  eq("governance", contract.governance, fm.governance);
  eq("model_tier", contract.model_tier, fm.model_tier);
  eq("hypothesis", contract.hypothesis, fm.hypothesis);
  eq("review", contract.review, fm.review);

  // 本文（＝依頼）が落ちていないこと。職人に届くのはここなので、欠けると仕事が変わる
  eq("body", contract.body.trim(), extractTaskBody(content));

  if (mismatches.length > 0) {
    return { ok: false, reason: `書いた記録と読み戻した中身が違います: ${mismatches.join(" / ")}` };
  }
  return { ok: true };
}

/**
 * frontmatter の後ろの本文を取り出す。
 *
 * `verifyRoundTrip` が使う。契約の本文は入力から凍っているので、これは
 * 「書いたものが読み戻せるか」の確認にだけ使う（**契約を作る経路ではない**）。
 */
export function extractTaskBody(content: string): string {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return "";
  const afterFirst = trimmed.slice(3);
  const closeIdx = afterFirst.search(/^---\s*$/m);
  if (closeIdx === -1) return "";
  return afterFirst.slice(closeIdx).replace(/^---\s*/, "").trim();
}

/**
 * 記録ファイルを書く。**書けなかったら理由を返す**（呼び手は積まない・PO 指示）。
 *
 * 手順は 検査 → 組み立て → 読み戻し → 書き出し。**読み戻しは書く前に**やる
 * ——ディスクに壊れたものを置いてから気づくのでは遅い。
 */
export function writeTaskRecord(
  repoPath: string,
  taskId: string,
  contract: TaskContract
): { ok: true; path: string; content: string } | { ok: false; reason: string } {
  const writable = checkWritable(contract);
  if (!writable.ok) return writable;

  const content = renderTaskRecord(taskId, contract);
  const roundTrip = verifyRoundTrip(taskId, contract, content);
  if (!roundTrip.ok) return roundTrip;

  const filePath = taskFilePath(repoPath, taskId);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
  } catch (err) {
    return { ok: false, reason: `記録ファイルを書けません（${filePath}）: ${String(err)}` };
  }
  return { ok: true, path: filePath, content };
}

/**
 * 契約から、帳簿に載せる payload を組み立てる（旧 `taskPayload`）。
 *
 * **入力から組む**のが第4便の要点（決定62c）。以前は frontmatter から組んでいたので、
 * ファイルを直せば契約が変わりうる形だった——いまはファイルを読む経路が無い。
 *
 * `title` は入れない：`createTask` が別引数で受け、payload からは落とされる。
 * 足すと、中身が同じでも改訂の比較で毎回「タイトルを変更」が出る（実際に踏んだ）。
 */
export function contractPayload(contract: TaskContract): Record<string, unknown> {
  return {
    kind: contract.kind,
    ...(contract.body.length > 0 ? { body: contract.body } : {}),
    scope: contract.scope,
    acceptance: contract.acceptance,
    ...(contract.parent !== undefined ? { parent: contract.parent } : {}),
    ...(contract.depends !== undefined ? { depends: contract.depends } : {}),
    ...(contract.refs !== undefined ? { refs: contract.refs } : {}),
    ...(contract.environment !== undefined ? { environment: contract.environment } : {}),
    ...(contract.governance !== undefined ? { governance: contract.governance } : {}),
    ...(contract.model_tier !== undefined ? { model_tier: contract.model_tier } : {}),
    ...(contract.hypothesis !== undefined ? { hypothesis: contract.hypothesis } : {}),
    ...(contract.review !== undefined ? { review: contract.review } : {}),
  };
}

/** 帳簿に載っている契約を、書き出せる形へ戻す（改訂で使う）。 */
export function contractFromRecord(
  record: Record<string, unknown>
): TaskContract {
  const scope = (record["scope"] as { paths?: unknown } | undefined) ?? {};
  const paths = Array.isArray(scope.paths) ? scope.paths.map(String) : [];
  const acceptance = Array.isArray(record["acceptance"])
    ? (record["acceptance"] as Array<Record<string, unknown>>).map((a) => ({
        id: String(a["id"] ?? ""),
        text: String(a["text"] ?? ""),
        ...(a["verify"] !== undefined ? { verify: String(a["verify"]) } : {}),
      }))
    : [];
  const tier = record["model_tier"];
  const hypothesis = record["hypothesis"] as
    | { expect?: unknown; metric?: unknown; horizon?: unknown }
    | undefined;
  const review = record["review"] as { policy?: unknown } | undefined;

  return {
    title: String(record["title"] ?? ""),
    kind: String(record["kind"] ?? ""),
    body: String(record["body"] ?? ""),
    scope: { paths },
    acceptance,
    ...(record["parent"] !== undefined ? { parent: String(record["parent"]) } : {}),
    ...(Array.isArray(record["depends"]) ? { depends: (record["depends"] as unknown[]).map(String) } : {}),
    ...(Array.isArray(record["refs"]) ? { refs: (record["refs"] as unknown[]).map(String) } : {}),
    ...(record["environment"] !== undefined ? { environment: String(record["environment"]) } : {}),
    ...(typeof record["governance"] === "boolean" ? { governance: record["governance"] } : {}),
    ...(tier === "reasoning" || tier === "standard" || tier === "fast" ? { model_tier: tier } : {}),
    ...(hypothesis
      ? {
          hypothesis: {
            expect: String(hypothesis.expect ?? ""),
            metric: String(hypothesis.metric ?? ""),
            ...(hypothesis.horizon !== undefined ? { horizon: String(hypothesis.horizon) } : {}),
          },
        }
      : {}),
    ...(review?.policy === "auto" || review?.policy === "banto" || review?.policy === "po" || review?.policy === "manual"
      ? { review: { policy: review.policy } }
      : {}),
  };
}

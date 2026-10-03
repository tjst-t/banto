#!/usr/bin/env node
// 古い docs/tasks.json（`tasks` の配列・phase・pending/undecided）を `banto-backlog/1` に**機械的に**読み替える
// （docs/specs/v4-modules.md §4.4「いまの docs/tasks.json の移し方」）。
//
//   node scripts/convert-tasks-json.mjs <古い tasks.json> <書き出す先>
//
// - 読み替え：pending → ready、undecided → backlog＋ラベル「未決」、phase → milestone、completedAt → closedAt、
//   dependencies → dependsOn、why・decision・scope・done・result・howFixed・verifiedBy・open・notes・note → body の節、
//   spec → refs の末尾。ここに無い欄は extra に運ぶ（落とさない）
// - kind は全部 task。ストーリーへの組み直しは後で人と AI がやる（機械には「どれが見出しか」が決められない）
// - いちばん外側の phaseN・$comment など（項目でないもの）は、いちばん外側の extra に運ぶ。
//   phaseN に closedAt があれば、そのマイルストーンは closed
// - **入力と同じ場所には書かない**——中身を確かめてから人が置き換える
//
// 欄の順と検証は Module と同じもの（dist/model.js）を使う——形の真実を2箇所に持たない（規則3）。

import { readFileSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const modelUrl = new URL("../dist/model.js", import.meta.url);

/** status の読み替え。知らないものは断る（黙って backlog にしない） */
const STATUS_MAP = {
  pending: { status: "ready" },
  ready: { status: "ready" },
  undecided: { status: "backlog", label: "未決" },
  backlog: { status: "backlog" },
  in_progress: { status: "in-progress" },
  "in-progress": { status: "in-progress" },
  done: { status: "done" },
};

/** body に寄せる欄と、その見出し（この順に並べる） */
const BODY_SECTIONS = [
  ["why", "なぜ"],
  ["decision", "決めたこと"],
  ["scope", "範囲"],
  ["done", "やったこと"],
  ["result", "結果"],
  ["howFixed", "直し方"],
  ["verifiedBy", "確かめ方"],
  ["open", "残っていること"],
  ["notes", "メモ"],
  ["note", "メモ"],
];

/** 読み替え先がある欄（これ以外は extra へ） */
const MAPPED = new Set(["id", "title", "status", "phase", "dependencies", "doneWhen", "refs", "spec", "completedAt", ...BODY_SECTIONS.map(([k]) => k)]);

function sectionText(value) {
  if (Array.isArray(value)) return value.map((v) => `- ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

/** phase の値 → マイルストーン。数字なら phase-N、それ以外は出てきた順に milestone-N */
function milestoneFor(phase, table, topLevel) {
  const raw = String(phase).trim();
  const digits = raw.replace(/^phase\s*/i, "").trim();
  const numeric = /^\d+$/.test(digits);
  // "Phase 0" と "0" は同じ Phase（書き方の揺れ）
  const key = numeric ? digits : raw;
  const found = table.get(key);
  if (found) return found.id;
  const id = numeric ? `phase-${digits}` : `milestone-${table.size + 1}`;
  const closed = numeric && typeof topLevel[`phase${digits}`]?.closedAt === "string";
  const m = { id, title: numeric ? `Phase ${digits}` : `Phase ${raw}`, status: closed ? "closed" : "open" };
  table.set(key, m);
  return id;
}

/**
 * 古い形の JSON の値 → `banto-backlog/1` の文書（まだ文字列にしない）。
 * 読み替えられないもの（知らない status・tasks が無い）は例外にする
 */
export function convertLegacy(legacy) {
  if (typeof legacy !== "object" || legacy === null || !Array.isArray(legacy.tasks)) {
    throw new Error('古い形ではありません（いちばん外側に "tasks" の配列がありません）');
  }
  if (legacy.format !== undefined) throw new Error(`format が既にあります（${JSON.stringify(legacy.format)}）——変換は要りません`);
  const milestones = new Map();
  const items = legacy.tasks.map((t, index) => {
    const where = `tasks[${index}]${typeof t?.id === "string" ? `（${t.id}）` : ""}`;
    if (typeof t !== "object" || t === null || typeof t.id !== "string" || typeof t.title !== "string") {
      throw new Error(`${where} に id か title がありません`);
    }
    const mapped = STATUS_MAP[t.status];
    if (!mapped) throw new Error(`${where} の status ${JSON.stringify(t.status)} を読み替えられません`);
    const labels = mapped.label ? [mapped.label] : [];
    const body = [];
    const seenHeadings = new Set();
    for (const [key, heading] of BODY_SECTIONS) {
      if (t[key] === undefined || t[key] === null || t[key] === "") continue;
      // notes と note は同じ見出しにまとめる
      const head = seenHeadings.has(heading) ? null : `## ${heading}`;
      seenHeadings.add(heading);
      body.push(head ? `${head}\n\n${sectionText(t[key])}` : sectionText(t[key]));
    }
    const refs = Array.isArray(t.refs) ? t.refs.map(String) : typeof t.refs === "string" ? [t.refs] : [];
    if (typeof t.spec === "string") refs.push(t.spec);
    else if (Array.isArray(t.spec)) refs.push(...t.spec.map(String));
    const extra = {};
    for (const [k, v] of Object.entries(t)) if (!MAPPED.has(k)) extra[k] = v;
    const closed = mapped.status === "done";
    return {
      id: t.id,
      kind: "task",
      title: t.title,
      status: mapped.status,
      parent: null,
      dependsOn: Array.isArray(t.dependencies) ? t.dependencies.map(String) : [],
      milestone: t.phase === undefined || t.phase === null || t.phase === "" ? null : milestoneFor(t.phase, milestones, legacy),
      priority: "normal",
      labels,
      body: body.join("\n\n"),
      doneWhen: typeof t.doneWhen === "string" ? t.doneWhen : t.doneWhen === undefined ? "" : sectionText(t.doneWhen),
      resolution: null,
      refs,
      threads: [],
      // 古い形には作った・変えた日が無い——分からないものは作らない
      createdAt: null,
      updatedAt: null,
      closedAt: closed && typeof t.completedAt === "string" ? t.completedAt : null,
      extra,
    };
  });
  const topExtra = {};
  for (const [k, v] of Object.entries(legacy)) if (k !== "tasks") topExtra[k] = v;
  return {
    format: "banto-backlog/1",
    milestones: [...milestones.values()],
    items,
    ...(Object.keys(topExtra).length > 0 ? { extra: topExtra } : {}),
  };
}

async function main(argv) {
  const [input, output] = argv;
  if (!input || !output) {
    console.error("使い方：node convert-tasks-json.mjs <古い tasks.json> <書き出す先>");
    return 2;
  }
  if (existsSync(output) && realpathSync(output) === realpathSync(input)) {
    console.error("入力と同じ場所には書きません。別の場所に書き出し、中身を確かめてから置き換えてください");
    return 2;
  }
  if (!existsSync(fileURLToPath(modelUrl))) {
    console.error("dist/model.js がありません。先に npm run build してください");
    return 2;
  }
  const { parseDocument, serializeDocument, validateDocument } = await import(modelUrl.href);
  const converted = convertLegacy(JSON.parse(readFileSync(input, "utf8")));
  // Module が読む形で読めることを、ここで確かめる（読めないものを書き出さない）
  const parsed = parseDocument(converted);
  if (!parsed.ok) throw new Error(`変換した結果が読めません：${parsed.reason}`);
  writeFileSync(resolve(output), serializeDocument(parsed.doc));
  const problems = validateDocument(parsed.doc);
  const count = (s) => parsed.doc.items.filter((i) => i.status === s).length;
  console.error(
    `${parsed.doc.items.length} 件を書き出しました（${output}）：` +
      `ready ${count("ready")}・backlog ${count("backlog")}・in-progress ${count("in-progress")}・done ${count("done")}。` +
      `マイルストーン ${parsed.doc.milestones.map((m) => `${m.id}(${m.status})`).join(", ") || "なし"}`,
  );
  if (problems.length > 0) console.error(`直すところ（Module は読めるが、画面に出す）：\n- ${problems.join("\n- ")}`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}

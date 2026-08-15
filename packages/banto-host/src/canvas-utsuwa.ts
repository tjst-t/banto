/**
 * 器 — 中核が持つ有限の語彙（ADR-0017 決定78・81）。
 *
 * ## なぜ中核が持つか
 *
 * 番頭に画面を組ませると、**同じ話が毎回違う見た目になる**（`prototype/redesign/11-zen.html`）。
 * `spec-canvas-ui` の第一原理「POから見ればどれも番頭が出した面でひと続き」が崩れる。
 * だから**器は中核が有限の語彙として持ち、番頭は選ぶだけ**——生成UIではなく選択UI。
 *
 * ## ここが持つのは「形を確かめる」ことだけ
 *
 * D5: 判断は無い。どの器で出すかを決めるのは番頭（決定81(a)）、描くのは画面。
 *     ここは**退避済みの結果を器の形に合わせられるか**だけを見る。
 * I2: 合わなければ黙って落とさず、**描けなかったことを器として返す**（決定81(d)）——
 *     どのモジュールの・どの Tool の・どの器で・何が足りないかまで書く。
 * D6: 依存なし。
 */

import type { UtsuwaBase, UtsuwaKind, UtsuwaState, UtsuwaView } from "./protocol.js";
import { UTSUWA_KINDS } from "./protocol.js";

/** 器の役は5つだけ（決定78）。モジュールの独自の状態名は落とす。 */
const STATES: readonly UtsuwaState[] = ["run", "turn", "stop", "warn", "done"];

/**
 * `canvas.show` から出せない器。
 *
 * `choice`（選択肢）は**判断を求めるもの**なので、取次1本を通る（ADR-0015 決定73）。
 * 押されたときに効く口（`InboxEffect`）を持てるのは取次だけで、そこを迂回する経路を
 * 作ると「承認を番頭から機構で分けた」意味が無くなる。画面はこの名前で取次の一通を
 * 描くので、**語彙としては13種のまま**。
 */
export const UTSUWA_NOT_SHOWABLE: readonly UtsuwaKind[] = ["choice"];

/** `canvas.show` が受ける器の名。 */
export const SHOWABLE_UTSUWA_KINDS = UTSUWA_KINDS.filter(
  (k) => !UTSUWA_NOT_SHOWABLE.includes(k)
);

/** 器を組むときの素性（どこから来たか・いつの記録か）。 */
export interface UtsuwaOrigin {
  module: string;
  tool: string;
  artifact: string;
  /** いつの記録か（決定81(c)）。器は凍るので必ず出す。 */
  at: string;
}

/** 番頭が添えられる文言。データではないので `canvas.show` の引数から来る。 */
export interface UtsuwaLabels {
  title?: string;
  meta?: string;
  note?: string;
  /** `open` の器だけが使う（面への口はデータを要らない）。 */
  view?: string;
  label?: string;
  args?: Record<string, unknown>;
}

/**
 * 面を開いた1行（ADR-0017 決定78「面への口」）。
 *
 * **開いた面は会話に残る。** 見本（`13-tsuzukima-kai.html` の幹）が `face` の行として
 * 持っているもので、これがあるから面を畳んでも**あとから遡って開き直せる**。
 * 器なので凍る——「いつ開いたか」の記録であって、面のいまの姿ではない。
 */
export function openUtsuwa(params: {
  view: string;
  label: string;
  meta?: string;
  args?: Record<string, unknown>;
  at?: string;
}): UtsuwaView {
  return {
    kind: "open",
    at: params.at ?? new Date().toISOString(),
    // 面への口は番頭（中核）が出すもので、モジュールの戻り値ではない
    from: { module: "core", tool: "canvas.open", artifact: "-" },
    view: params.view,
    label: params.label,
    ...(params.meta ? { meta: params.meta } : {}),
    ...(params.args && Object.keys(params.args).length > 0 ? { args: params.args } : {}),
  };
}

/** 描けなかったことを器として返す（決定81(d)）。 */
export function brokenUtsuwa(params: {
  origin: UtsuwaOrigin;
  wanted: string;
  missing: string;
  raw?: unknown;
}): UtsuwaView {
  return {
    kind: "broken",
    at: params.origin.at,
    from: {
      module: params.origin.module,
      tool: params.origin.tool,
      artifact: params.origin.artifact,
    },
    wanted: params.wanted,
    missing: params.missing,
    // 素の値は**畳んで置く**。黙って素の JSON を出すと、壊れた見た目が既定になる
    ...(params.raw !== undefined ? { raw: truncate(safeJson(params.raw), 1200) } : {}),
  };
}

/** 器が描けなかったことを表す（`buildUtsuwa` の戻り値）。 */
export interface UtsuwaBuildFailure {
  ok: false;
  /** 何が足りないか。番頭にも同じ文言が返る（決定81(d)）。 */
  missing: string;
  utsuwa: UtsuwaView;
}

export type UtsuwaBuildResult = { ok: true; utsuwa: UtsuwaView } | UtsuwaBuildFailure;

/**
 * 退避済みの結果を器に載せる。
 *
 * **データは再送させない**（決定81(a)）——番頭は「どのツール結果を・どの器で・どこを」
 * だけを言い、`data` は呼び出し側がホストの退避先から引いてくる。
 */
export function buildUtsuwa(
  kind: string,
  data: unknown,
  origin: UtsuwaOrigin,
  labels: UtsuwaLabels = {}
): UtsuwaBuildResult {
  const base: UtsuwaBase = {
    at: origin.at,
    from: { module: origin.module, tool: origin.tool, artifact: origin.artifact },
    ...(labels.title ? { title: labels.title } : {}),
    ...(labels.meta ? { meta: labels.meta } : {}),
    ...(labels.note ? { note: labels.note } : {}),
  };
  const fail = (missing: string): UtsuwaBuildFailure => ({
    ok: false,
    missing,
    utsuwa: brokenUtsuwa({ origin, wanted: kind, missing, raw: data }),
  });
  /**
   * 形が合わなかったときの断り。**次に何を書けばよいかが分かる形で返す**（決定81(d)）。
   *
   * 「描けません」だけでは番頭は直せない——**在る鍵を名指しする**。これは PO が見る
   * 観測ではなく番頭への案内なので、件数のような具体を書いてよい。
   */
  const failShape = (missing: string): UtsuwaBuildFailure => {
    const keys = describeKeys(data);
    return fail(keys ? `${missing}。この観測の鍵は ${keys}` : missing);
  };

  if (!UTSUWA_KINDS.includes(kind as UtsuwaKind)) {
    return fail(`器「${kind}」はありません（使えるのは ${UTSUWA_KINDS.join(" / ")}）`);
  }
  if (UTSUWA_NOT_SHOWABLE.includes(kind as UtsuwaKind)) {
    return fail(
      "選択肢の器は取次から出ます（決定73）。判断を求めるなら inbox.post を使ってください"
    );
  }

  switch (kind as UtsuwaKind) {
    // 面への口。**データは要らない**——これがあるから他の器が小さいままでいられる
    case "open": {
      if (!labels.view) return fail("`view`（開く面の kind）がありません");
      return {
        ok: true,
        utsuwa: {
          ...base,
          kind: "open",
          view: labels.view,
          label: labels.label ?? labels.title ?? labels.view,
          ...(labels.args ? { args: labels.args } : {}),
        },
      };
    }

    case "list": {
      const found = findRows(data, ["items", "entries", "rows", "list"], "`items`（行の配列）");
      if ("missing" in found) return failShape(found.missing);
      const raw = found.rows;
      const items = raw.slice(0, LIST_MAX).map((row) => {
        const o = asRecord(row);
        return {
          label: rowLabel(row) ?? "—",
          ...(state(o?.["state"]) ? { state: state(o?.["state"])! } : {}),
          ...(text(o?.["meta"]) ? { meta: text(o?.["meta"])! } : {}),
        };
      });
      const total = num(asRecord(data)?.["total"]) ?? raw.length;
      return {
        ok: true,
        utsuwa: {
          ...base,
          kind: "list",
          items,
          total,
          // I1: 切ったことは隠さない
          ...withNote(base, raw.length > LIST_MAX ? `${total} 件のうち先頭 ${LIST_MAX} 件` : undefined),
        },
      };
    }

    case "facts": {
      const o = asRecord(data);
      const raw = (o?.["facts"] ?? data) as unknown;
      // **入れ子があるなら描かない。** 平たい値だけを拾って「成功」にすると、中身の
      // 入っている鍵が消えたまま器が出る——**中身が無いのに成功して見える**のが
      // いちばん質が悪い（I1）。数えて畳むのも器がデータを作ることになるので採らない
      const nested = nestedEntries(raw);
      if (nested.length > 0) {
        return failShape(
          `入れ子の鍵（${nested.map(([k, what]) => `\`${k}\`（${what}）`).join(" / ")}）を` +
            "落とすことになるので描けません。行の一覧なら list / table を、" +
            "この階層の平たい値だけでよければ path で下の階層を指してください"
        );
      }
      const facts = toPairs(raw);
      if (!facts) return failShape("`facts`（[鍵, 値] の配列か、平たいオブジェクト）がありません");
      return {
        ok: true,
        utsuwa: {
          ...base,
          kind: "facts",
          facts: facts.slice(0, FACTS_MAX),
          ...withNote(
            base,
            facts.length > FACTS_MAX ? `${facts.length} 件のうち先頭 ${FACTS_MAX} 件` : undefined
          ),
        },
      };
    }

    case "table": {
      const o = asRecord(data);
      const givenCols = Array.isArray(o?.["cols"]) ? (o["cols"] as unknown[]) : undefined;
      // モジュールが列を持たせてくれているなら、それをそのまま使う
      if (givenCols) {
        const rows = Array.isArray(o?.["rows"]) ? (o["rows"] as unknown[]) : undefined;
        if (!rows) return failShape("`rows` がありません（`cols` はあります）");
        return {
          ok: true,
          utsuwa: {
            ...base,
            kind: "table",
            cols: givenCols.slice(0, TABLE_COLS).map((c) => {
              const co = asRecord(c);
              return {
                label: text(co?.["label"] ?? c) ?? "—",
                ...(co?.["align"] === "num" ? { align: "num" as const } : {}),
              };
            }),
            rows: rows.slice(0, TABLE_ROWS).map((r) =>
              (Array.isArray(r) ? r : [r]).slice(0, TABLE_COLS).map((cell) => toCell(cell))
            ),
            ...withNote(
              base,
              rows.length > TABLE_ROWS ? `${rows.length} 行のうち先頭 ${TABLE_ROWS} 行` : undefined
            ),
          },
        };
      }

      // 列が無いとき：**オブジェクトの配列なら鍵がそのまま列**。道具は器を知らないので
      // `cols`/`rows` を持って返してくる道具のほうが稀（決定81(a)：道具は書き換えない）
      const found = findRows(data, ["rows", "items", "entries", "list"], "`rows`（行の配列）");
      if ("missing" in found) return failShape(found.missing);
      const records = found.rows.map((r) => asRecord(r));
      if (records.length === 0) {
        return failShape(
          `${found.key ? `\`${found.key}\`` : "行の配列"} が空です。行が無いので列も作れません`
        );
      }
      if (records.some((r) => r === undefined)) {
        return failShape(
          "`cols` がありません（`rows` はあります）。行がオブジェクトではないので" +
            "列の名前を導けません——`cols` を持つ形にするか、見出しだけでよければ list で出してください"
        );
      }
      const filled = records as Array<Record<string, unknown>>;
      const columns = deriveColumns(filled);
      if (columns.keys.length === 0) {
        return failShape(
          `行の値がすべて入れ子で、列にできる鍵がありません（${columns.nested.join(" / ")}）。` +
            "path でもう一段下を指してください"
        );
      }
      const keys = columns.keys.slice(0, TABLE_COLS);
      return {
        ok: true,
        utsuwa: {
          ...base,
          kind: "table",
          cols: keys.map((key) => ({
            label: key,
            // 数だけの列は右寄せ。**値を書き換えてはいない**（並べ方だけ）
            ...(filled.every((r) => r[key] === undefined || r[key] === null || num(r[key]) !== undefined) &&
            filled.some((r) => num(r[key]) !== undefined)
              ? { align: "num" as const }
              : {}),
          })),
          rows: filled.slice(0, TABLE_ROWS).map((r) => keys.map((key) => toCell(r[key]))),
          // I1: 落とした列・切った行は必ず書く（黙って落とさない）
          ...withNote(
            base,
            [
              filled.length > TABLE_ROWS ? `${filled.length} 行のうち先頭 ${TABLE_ROWS} 行` : "",
              columns.keys.length > TABLE_COLS
                ? `列は ${columns.keys.length} 個のうち先頭 ${TABLE_COLS} 個`
                : "",
              columns.nested.length > 0 ? `入れ子の ${columns.nested.join(" / ")} は載せていません` : "",
            ]
              .filter((s) => s.length > 0)
              .join("・") || undefined
          ),
        },
      };
    }

    case "diff": {
      const o = asRecord(data);
      const path = text(o?.["path"] ?? o?.["file"]);
      if (!path) return failShape("`path`（どのファイルの差分か）がありません");
      const hunks = parseHunks(o);
      if (!hunks) return failShape("`hunks`（差分のかたまり）も `diff`（unified 形式の文字列）もありません");
      return {
        ok: true,
        utsuwa: {
          ...base,
          kind: "diff",
          path,
          ...(num(o?.["added"]) !== undefined ? { added: num(o?.["added"])! } : {}),
          ...(num(o?.["removed"]) !== undefined ? { removed: num(o?.["removed"])! } : {}),
          hunks: hunks.hunks,
          ...(hunks.truncated || o?.["truncated"] === true ? { truncated: true } : {}),
        },
      };
    }

    case "stats": {
      const raw = pickArray(data, ["stats", "items"]);
      if (!raw) return failShape("`stats`（数の札の配列）がありません");
      const stats = raw.slice(0, STATS_MAX).map((s) => {
        const o = asRecord(s);
        return {
          // 数は**人の単位に落としてから**渡す（器で整形しない）
          value: text(o?.["value"]) ?? "—",
          label: text(o?.["label"]) ?? "—",
          ...(state(o?.["state"]) ? { state: state(o?.["state"])! } : {}),
        };
      });
      if (stats.length === 0) return failShape("`stats` が空です");
      return { ok: true, utsuwa: { ...base, kind: "stats", stats } };
    }

    case "meter": {
      const o = asRecord(data);
      const value = num(o?.["value"]);
      const max = num(o?.["max"]);
      if (value === undefined) return failShape("`value` がありません");
      // 上限の分からない割合は嘘になる（I1）
      if (max === undefined || max <= 0) {
        return failShape("`max`（上限）がありません。分母の無い割合は出せません（I1）");
      }
      return {
        ok: true,
        utsuwa: {
          ...base,
          kind: "meter",
          label: text(o?.["label"]) ?? labels.title ?? "—",
          value,
          max,
          ...(text(o?.["unit"]) ? { unit: text(o?.["unit"])! } : {}),
          ...(state(o?.["state"]) ? { state: state(o?.["state"])! } : {}),
        },
      };
    }

    case "spark": {
      const o = asRecord(data);
      const raw = pickArray(data, ["points", "values", "series"]);
      const points = raw?.map((p) => num(p)).filter((p): p is number => p !== undefined);
      if (!points || points.length < 2) {
        return failShape("`points`（2点以上の数の配列）がありません。1点では向きが言えません");
      }
      return {
        ok: true,
        utsuwa: {
          ...base,
          kind: "spark",
          label: text(o?.["label"]) ?? labels.title ?? "—",
          points: points.slice(-SPARK_MAX),
          ...(text(o?.["unit"]) ? { unit: text(o?.["unit"])! } : {}),
          ...(text(o?.["span"]) ? { span: text(o?.["span"])! } : {}),
          ...(o?.["good"] === "up" || o?.["good"] === "down"
            ? { good: o["good"] as "up" | "down" }
            : {}),
        },
      };
    }

    case "timeline": {
      const found = findRows(
        data,
        ["events", "items", "entries"],
        "`events`（並びに意味のある出来事の配列）"
      );
      if ("missing" in found) return failShape(found.missing);
      const raw = found.rows;
      const events = raw.slice(0, TIMELINE_MAX).map((e) => {
        const o = asRecord(e);
        return {
          // 時刻は**モジュールが人の単位に落として渡す**。器はタイムゾーンを知らない
          at: text(o?.["at"] ?? o?.["time"] ?? o?.["date"] ?? o?.["timestamp"]) ?? "—",
          label: rowLabel(e) ?? "—",
          ...(state(o?.["state"]) ? { state: state(o?.["state"])! } : {}),
        };
      });
      if (events.length === 0) return failShape("`events` が空です");
      return { ok: true, utsuwa: { ...base, kind: "timeline", events } };
    }

    case "image": {
      const o = asRecord(data);
      const src = text(o?.["src"] ?? o?.["url"]);
      if (!src) return failShape("`src`（画像への参照）がありません");
      const alt = text(o?.["alt"]);
      // I1: 見えない人に「画像」とだけ出さない
      if (!alt) return failShape("`alt`（画像の説明）がありません。見えない人に「画像」とだけ出せません");
      return {
        ok: true,
        utsuwa: {
          ...base,
          kind: "image",
          src,
          alt,
          ...(num(o?.["w"]) !== undefined ? { w: num(o?.["w"])! } : {}),
          ...(num(o?.["h"]) !== undefined ? { h: num(o?.["h"])! } : {}),
        },
      };
    }

    case "doc": {
      const o = asRecord(data);
      const body = text(o?.["excerpt"] ?? o?.["content"] ?? o?.["text"] ?? o?.["body"]);
      if (!body) return failShape("`excerpt`（本文の抜粋）がありません");
      const excerpt = truncate(body, DOC_MAX);
      return {
        ok: true,
        utsuwa: {
          ...base,
          kind: "doc",
          excerpt,
          ...(text(o?.["path"]) ? { path: text(o?.["path"])! } : {}),
          ...(excerpt.length < body.length || o?.["truncated"] === true
            ? { truncated: true }
            : {}),
          // 全部を読む面への口。番頭が指定していれば付ける
          ...(labels.view
            ? { open: { view: labels.view, ...(labels.args ? { args: labels.args } : {}) } }
            : {}),
        },
      };
    }

    case "quote": {
      const o = asRecord(data);
      const body = text(o?.["text"] ?? o?.["quote"] ?? data);
      if (!body) return failShape("`text`（引用する文字）がありません");
      const source = text(o?.["source"]);
      // 番頭の言葉と、拾ってきた言葉を混ぜない
      if (!source) return failShape("`source`（出どころ）がありません。出どころの無い引用は出せません");
      return {
        ok: true,
        utsuwa: {
          ...base,
          kind: "quote",
          text: truncate(body, QUOTE_MAX),
          source,
          ...(text(o?.["href"]) ? { href: text(o?.["href"])! } : {}),
        },
      };
    }

    // `choice` は上で弾いてある（取次を通る）
    default:
      return fail(`器「${kind}」はこの経路から出せません`);
  }
}

// ── 上限（膳は小さい・決定78）────────────────────────────────────────────────
/** 行の一覧。10 行を超えたら面へ送る器なので、切る線もそこに置く。 */
const LIST_MAX = 10;
const FACTS_MAX = 12;
const TABLE_COLS = 4;
const TABLE_ROWS = 8;
const STATS_MAX = 3;
const SPARK_MAX = 30;
const TIMELINE_MAX = 10;
const DOC_MAX = 1200;
const QUOTE_MAX = 600;
/** 差分の行数。**膳に載るのは抜粋**で、全部は面（Git）で読む。 */
const DIFF_LINES_MAX = 24;
/** 鍵の案内に並べる数。これは番頭が読む文で膳ではないが、栞に1行で収まる長さに留める。 */
const DESCRIBE_KEYS_MAX = 8;

// ── 形を読む小道具 ──────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 配列そのものか、いずれかの鍵の下の配列。 */
function pickArray(value: unknown, keys: readonly string[]): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const o = asRecord(value);
  if (!o) return undefined;
  for (const key of keys) if (Array.isArray(o[key])) return o[key] as unknown[];
  return undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function state(value: unknown): UtsuwaState | undefined {
  // モジュールの独自の状態名は**通さない**（決定78：持ち込ませると色の意味が崩れる）。
  //
  // **当たらない語は無色で素通しする。** `closed` を `stop` に、`failed` を `warn` に……と
  // 写す対応表をここに置くと、**中核が各モジュールの語彙を知る**ことになる（ADR-0017 の
  // 「モジュールは器を知らない／中核はモジュールの中身を知らない」に触れる）。誰が写すのかは
  // まだ決まっていない。嘘の色が点くほうが、色が点かないより高くつく（I1）
  return typeof value === "string" && STATES.includes(value as UtsuwaState)
    ? (value as UtsuwaState)
    : undefined;
}

/**
 * 行の見出しにできる鍵（左から順に見る）。
 *
 * **ここに並ぶのは一般名だけ。** 「その行を人が識別する文字列が入っている鍵」の名前で、
 * 特定のモジュールの都合（状態の語彙など）は入れない。当たらなければ最後に
 * 「最初の文字列の値」まで落ちる——「—」を並べるくらいなら、その行に在る文字を出す。
 */
const LABEL_KEYS = [
  "label",
  "name",
  "title",
  "subject",
  "message",
  "summary",
  "text",
  "path",
  "file",
  "envId",
  "taskId",
  "id",
  "sessionId",
  "ref",
  "hash",
  "key",
] as const;

/** 1行の見出し。行が文字列そのものならそれを使う。 */
function rowLabel(row: unknown): string | undefined {
  const o = asRecord(row);
  if (!o) return text(row);
  for (const key of LABEL_KEYS) {
    const value = text(o[key]);
    if (value !== undefined) return value;
  }
  for (const value of Object.values(o)) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** 入れ子（オブジェクト・配列）の鍵と、その形の一言。**断り文にだけ使う**（番頭への案内）。 */
function nestedEntries(value: unknown): Array<[string, string]> {
  const o = asRecord(value);
  if (!o) return [];
  return Object.entries(o)
    .filter(([, v]) => v !== null && typeof v === "object")
    .map(([k, v]) => [k, Array.isArray(v) ? `${v.length} 件の配列` : "入れ子"] as [string, string]);
}

/**
 * 観測の直下に何があるかを1行に潰す。**番頭が `path` を書けるようにするため**の案内で、
 * PO が見る観測ではない（だから件数を書いてよい）。
 */
export function describeKeys(value: unknown): string | undefined {
  if (Array.isArray(value)) return `（配列そのもの・${value.length} 件）`;
  const o = asRecord(value);
  if (!o) return undefined;
  const keys = Object.keys(o);
  if (keys.length === 0) return undefined;
  const shown = keys.slice(0, DESCRIBE_KEYS_MAX).map((k) => {
    const v = o[k];
    if (Array.isArray(v)) return `${k}[${v.length}]`;
    if (v !== null && typeof v === "object") return `${k}{…}`;
    return k;
  });
  const rest = keys.length > shown.length ? ` ほか ${keys.length - shown.length} 個` : "";
  return `${shown.join(" / ")}${rest}`;
}

/**
 * その観測の中で「行の配列」になり得る鍵。`[]` なら行の一覧は出せない。
 *
 * 器の外（栞の案内）からも使う——番頭は `details` の鍵名を知る手段を他に持たない。
 */
export function rowArrayKeys(value: unknown): string[] {
  const o = asRecord(value);
  if (!o) return [];
  return Object.entries(o)
    .filter(([, v]) => Array.isArray(v))
    .map(([k]) => k);
}

/**
 * 行の配列を見つける。
 *
 * **`path` を書かなくても、一意に決まるなら器が自分で見つける。** 決まらないときは
 * 黙って選ばず、**どの鍵を指せばよいかを名指しで**返す（決定81(d)）——番頭は
 * 断り文だけを頼りに次の一手を書く。
 */
function findRows(
  data: unknown,
  named: readonly string[],
  what: string
): { key?: string; rows: unknown[] } | { missing: string } {
  if (Array.isArray(data)) return { rows: data };
  const o = asRecord(data);
  if (!o) return { missing: `${what} がありません（この観測は配列でもオブジェクトでもありません）` };

  for (const key of named) {
    if (Array.isArray(o[key])) return { key, rows: o[key] as unknown[] };
  }
  const arrays = Object.entries(o).filter(([, v]) => Array.isArray(v)) as Array<[string, unknown[]]>;
  if (arrays.length === 0) {
    return { missing: `${what} がありません（この観測に配列の鍵がありません）` };
  }
  // 直下に配列が1つしか無いなら、それが行の配列で間違いようがない
  if (arrays.length === 1) return { key: arrays[0]![0], rows: arrays[0]![1] };
  const filled = arrays.filter(([, v]) => v.length > 0);
  if (filled.length === 1) return { key: filled[0]![0], rows: filled[0]![1] };
  const candidates = arrays.map(([k, v]) => `\`${k}\`（${v.length} 件）`).join(" / ");
  const example = (filled[0] ?? arrays[0])![0];
  return {
    missing:
      `${what} が1つに決まりません。行の配列になり得るのは ${candidates} です——` +
      `path でどれかを指してください（例 path: "${example}"）`,
  };
}

/**
 * オブジェクトの配列から列を導く。
 *
 * **道具は器を知らない**（決定81(a)：道具の戻り値は書き換えない）ので、`cols`/`rows` を
 * 持って返す道具のほうが稀。鍵をそのまま列にする——名前を作らないので器は何も足していない。
 */
function deriveColumns(records: ReadonlyArray<Record<string, unknown>>): {
  keys: string[];
  nested: string[];
} {
  const order: string[] = [];
  const nested = new Set<string>();
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (!order.includes(key)) order.push(key);
      // 1行でも入れ子ならその列は出せない（畳むと器がデータを作ることになる）
      if (value !== null && typeof value === "object") nested.add(key);
    }
  }
  const usable = order.filter((k) => !nested.has(k));
  // 人が行を識別できる列を左端に置く（並べ替えるだけで、値は触らない）
  const head = LABEL_KEYS.find((k) => usable.includes(k));
  return {
    keys: head ? [head, ...usable.filter((k) => k !== head)] : usable,
    nested: [...nested],
  };
}

/** 表の1マス。入れ子は文字にできないので「—」（`null`）になる——列ごと落としてある。 */
function toCell(cell: unknown): string | number | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "number") return cell;
  return text(cell) ?? null;
}

/**
 * 器の添え書き。**番頭の note を消さずに、切ったことを足す**（I1）——
 * 番頭が note を書いていたからといって、落としたものを黙っていい理由にはならない。
 */
function withNote(base: UtsuwaBase, auto: string | undefined): { note?: string } {
  if (!auto) return base.note ? { note: base.note } : {};
  return { note: base.note ? `${base.note}（${auto}）` : auto };
}

/** `[[鍵, 値], …]` か、平たいオブジェクトを鍵と値の並びにする。`null` は「—」として残す。 */
function toPairs(value: unknown): Array<[string, string | null]> | undefined {
  if (Array.isArray(value)) {
    const pairs: Array<[string, string | null]> = [];
    for (const row of value) {
      if (Array.isArray(row) && row.length >= 1) {
        pairs.push([text(row[0]) ?? "—", text(row[1]) ?? null]);
        continue;
      }
      const o = asRecord(row);
      if (o && "key" in o) pairs.push([text(o["key"]) ?? "—", text(o["value"]) ?? null]);
    }
    return pairs.length > 0 ? pairs : undefined;
  }
  const o = asRecord(value);
  if (!o) return undefined;
  const pairs = Object.entries(o)
    // 中身が入れ子のものは器に載らない（膳＝器1つ・決定81(b)）。
    // **黙って落とさないための番は呼ぶ側**（`facts` は入れ子があれば描かずに断る）——
    // ここに残っているのは念のための網で、ここを通って消えることは無い
    .filter(([, v]) => v === null || typeof v !== "object")
    .map(([k, v]) => [k, text(v) ?? null] as [string, string | null]);
  return pairs.length > 0 ? pairs : undefined;
}

/**
 * 差分を読む。`hunks` があればそれを、無ければ unified 形式の文字列を刻む。
 *
 * **抜粋であることを隠さない**（I1）——切ったら `truncated` を立てる。
 */
function parseHunks(
  o: Record<string, unknown> | undefined
): { hunks: Array<{ header?: string; lines: Array<[" " | "+" | "-", string]> }>; truncated: boolean } | undefined {
  if (!o) return undefined;
  const given = Array.isArray(o["hunks"]) ? (o["hunks"] as unknown[]) : undefined;
  if (given) {
    let left = DIFF_LINES_MAX;
    const hunks: Array<{ header?: string; lines: Array<[" " | "+" | "-", string]> }> = [];
    for (const h of given) {
      const ho = asRecord(h);
      const raw = Array.isArray(ho?.["lines"]) ? (ho["lines"] as unknown[]) : [];
      const lines = raw
        .slice(0, Math.max(0, left))
        .map((l): [" " | "+" | "-", string] => {
          if (Array.isArray(l)) return [sign(l[0]), text(l[1]) ?? ""];
          const s = text(l) ?? "";
          return [sign(s[0]), s.slice(1)];
        });
      left -= lines.length;
      const header = text(ho?.["header"]);
      if (lines.length > 0) hunks.push({ ...(header ? { header } : {}), lines });
      if (left <= 0) break;
    }
    if (hunks.length === 0) return undefined;
    let total = 0;
    for (const h of given) {
      const raw = asRecord(h)?.["lines"];
      if (Array.isArray(raw)) total += raw.length;
    }
    return { hunks, truncated: total > DIFF_LINES_MAX };
  }
  const unified = text(o["diff"] ?? o["patch"]);
  if (!unified) return undefined;
  const all = unified.split("\n");
  const lines = all
    .filter((l) => !l.startsWith("+++") && !l.startsWith("---") && !l.startsWith("@@"))
    .slice(0, DIFF_LINES_MAX)
    .map((l): [" " | "+" | "-", string] => [sign(l[0]), l.slice(1)]);
  if (lines.length === 0) return undefined;
  const header = all.find((l) => l.startsWith("@@"));
  return {
    hunks: [{ ...(header ? { header } : {}), lines }],
    truncated: all.length > DIFF_LINES_MAX,
  };
}

function sign(ch: unknown): " " | "+" | "-" {
  return ch === "+" || ch === "-" ? ch : " ";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * `details` の中を掘る（`canvas.show` の `path`）。
 *
 * 番頭は「どのツール結果を・**どこを**・どの器で」を言う（決定81(a)）。掘るのは
 * 素直なドット記法だけ——ここに式を持ち込むと、番頭が画面を組み始める。
 */
export function pickPath(data: unknown, path?: string): unknown {
  if (!path) return data;
  let cursor: unknown = data;
  for (const key of path.split(".")) {
    if (key === "") continue;
    const o = asRecord(cursor);
    if (o && key in o) {
      cursor = o[key];
      continue;
    }
    if (Array.isArray(cursor)) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && index < cursor.length) {
        cursor = cursor[index];
        continue;
      }
    }
    return undefined;
  }
  return cursor;
}

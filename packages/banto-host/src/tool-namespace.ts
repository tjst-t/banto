/**
 * Tool namespace convention for Banto host tools (ADR-0010 決定9).
 *
 * 境界線: 単発の状態照会・単発アクション（Kobo状態クエリ、キャンバスのopen/close/switch等）は
 * すべて Tool として定義し、`<domain>.<verb...>` 形式で命名する
 * （例: kobo.query.ready / kobo.action.spawn_worker / canvas.open / canvas.switch）。
 * 契約の形状（名前・JSON Schemaパラメータ・説明）は発生元ドメインによらず共通のまま、
 * 名前空間プレフィックスで発生元ドメイン（Kobo・canvas・将来のExtension Pack等）を区別する。
 *
 * D6: 依存は正規表現のみ（純粋な命名検証）。
 */

/** A tool name that at least looks like `<domain>.<verb...>` at the type level. */
export type NamespacedToolName = `${string}.${string}`;

/**
 * Segment grammar: lower_snake, but **no consecutive underscores** and no trailing underscore.
 * That restriction is what makes the logical↔wire mapping below injective: `__` can then only
 * ever mean "this was a dot", never "this was part of a segment" (ADR-0010 決定22).
 */
const SEGMENT = "[a-z][a-z0-9]*(?:_[a-z0-9]+)*";
const NAMESPACED_TOOL_NAME_PATTERN = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})+$`);

/** True if `name` follows the `<domain>.<verb...>` convention (lower_snake segments, dot-separated). */
export function isNamespacedToolName(name: string): name is NamespacedToolName {
  return NAMESPACED_TOOL_NAME_PATTERN.test(name);
}

/**
 * Throws if `name` does not follow the namespace convention.
 * I2: naming violations must fail loudly, not be silently accepted or coerced.
 */
export function assertNamespacedToolName(name: string): asserts name is NamespacedToolName {
  if (!isNamespacedToolName(name)) {
    throw new Error(
      `Tool name "${name}" does not follow the namespace convention "<domain>.<verb>" ` +
        `(ADR-0010 決定9, e.g. "kobo.query.ready", "canvas.open").`
    );
  }
}

/** Extracts the domain segment (e.g. "kobo" from "kobo.query.ready"). */
export function toolDomain(name: NamespacedToolName): string {
  assertNamespacedToolName(name);
  return name.split(".", 1)[0] as string;
}

// ── 論理名 ↔ wire名（ADR-0010 決定22）────────────────────────────────────────
//
// 決定9のドット記法は契約・論理層の識別子。実際にLLM APIへ渡す関数名（wire名）は
// プロバイダによって使える文字が異なる——openai-completions 互換のプロバイダ
// （opencode-go 等）は関数名にドットを許さず、task-0004 の実機確認では
// `400 Upstream request failed` で拒否された。Anthropic はドットを許容する。
// そこで wire 層ではドットを `__` に置換し、プロバイダ共通で安全な
// `[a-z0-9_]+` の範囲に収める。

/** Separator standing in for `.` at the wire level. Never occurs inside a segment (see SEGMENT). */
const WIRE_SEPARATOR = "__";

/**
 * 論理名（`kobo.query.ready`）→ wire名（`kobo__query__ready`）。
 * SEGMENT が連続アンダースコアを禁じているため、この変換は単射（異なる論理名は
 * 決して同じ wire 名に潰れない）。
 */
export function toWireToolName(name: NamespacedToolName): string {
  assertNamespacedToolName(name);
  return name.split(".").join(WIRE_SEPARATOR);
}

/**
 * wire名（`kobo__query__ready`）→ 論理名（`kobo.query.ready`）。`toWireToolName` の逆写像。
 * I2: 論理名として成立しない入力は握りつぶさず例外にする。
 */
export function fromWireToolName(wireName: string): NamespacedToolName {
  const logical = wireName.split(WIRE_SEPARATOR).join(".");
  assertNamespacedToolName(logical);
  return logical;
}

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

const NAMESPACED_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

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

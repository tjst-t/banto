// js-yaml は型を同梱していない。使う分だけを書く（`@types/js-yaml` を足すほどの面積ではない、規則10）。
declare module "js-yaml" {
  export const JSON_SCHEMA: unknown;
  export function load(text: string, options?: { schema?: unknown; json?: boolean }): unknown;
}

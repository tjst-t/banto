// **引数のファイルの拡張子で、tool の画面を選び替える**（`dev.banto/ui-by-extension`、追加・2026-10-15、
// v4-modules.md §2.2「PDF・Office…」）。host（`listUiToolsForThread`）が tool の名乗りを読んで渡してくる。
// 画面は workspace のパッケージに依存していないので、`@banto/module-contract` の `uiResourceUriForCall` を写して持つ（変えるなら両方）。

export interface UiByExtension {
  arg: string;
  byExtension: Record<string, string>;
}

/** その呼び出しで出す画面。引数のパスの拡張子が `byExtension` に当たればそれ、当たらなければ `resourceUri` */
export function uiResourceUriForCall(resourceUri: string, byExtension: UiByExtension | undefined, args: unknown): string {
  if (!byExtension || !args || typeof args !== "object") return resourceUri;
  const value = (args as Record<string, unknown>)[byExtension.arg];
  if (typeof value !== "string") return resourceUri;
  const name = value.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return resourceUri;
  return byExtension.byExtension[name.slice(dot + 1).toLowerCase()] ?? resourceUri;
}

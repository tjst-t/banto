// **「/dev/kvm を見せる」に足すカーネルモジュールの名前**（決定・2026-10-20、`docs/specs/v4-security.md` §1「`containers` で
// 仮想化（KVM）」の 2.）。欄は空白で区切った名前で、形（`[a-z0-9_-]+`）は host も確かめる——画面は送る前に言うだけ。
// `-` と `_` は同じ扱い（`br-netfilter` も `br_netfilter`）。

const MODULE_NAME = /^[a-z0-9_-]+$/;

/** 欄の文字を名前に分ける。形が違うものは `invalid` に（送らずに言う） */
export function parseModuleNames(text: string): { names: string[]; invalid: string[] } {
  const words = text.split(/\s+/).filter((w) => w !== "");
  return { names: words.filter((w) => MODULE_NAME.test(w)), invalid: words.filter((w) => !MODULE_NAME.test(w)) };
}

/** `br_netfilter` を足そうとしているか——サーバのブリッジ全部の通り方を変えるので、注意を出す */
export function includesBrNetfilter(names: readonly string[]): boolean {
  return names.some((n) => n.replace(/-/g, "_") === "br_netfilter");
}

/** 名前の並びが同じか（`-` と `_` は同じ扱い。並びの順は問わない） */
export function sameModuleNames(a: readonly string[], b: readonly string[]): boolean {
  const norm = (xs: readonly string[]) => [...new Set(xs.map((x) => x.replace(/-/g, "_")))].sort().join(" ");
  return norm(a) === norm(b);
}

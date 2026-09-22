// **どの配布形式を、banto が扱えるか**（決定・2026-09-21、ユーザー
// 「1（npm のみ）で、ただし今後全形式に対応するときに大きなアーキテクチャ変更に
// ならないように作って」）。
//
// **ここが増えるところ。** 形式を1つ足すのは、
//   1. この表に1行足す
//   2. `install/<形式>.ts` を1本足して `INSTALLERS` に登録する
// の2つだけで済むようにしてある。呼ぶ側（HTTP の口・画面）は
// **`registryType` を1つも知らない**——知っているのはこの表だけ（規則3）。
//
// **なぜ npx に丸投げできないか**（実測・2026-09-21）。banto は Module を
// Landlock で閉じ込めて起動する。instance の Module に書ける場所は
// `moduleDataDir` と `/dev` だけで、**`$HOME/.npm` は書けない**
// ——`touch $HOME/.npm/… → Permission denied` を実機で確認した。
// つまり `npx -y <pkg>` は**起動時に自分で取ってくることができない**。
// 取ってくるのは閉じ込めの外＝host の仕事で、起動はその置き場を
// **読み取り専用**で渡して行う。「インストールして、つなぐ」が1本の筋になる。

import type { RegistryPackage, RegistryRemote, RegistryServer } from "./server-json.js";

export interface FormatSupport {
  /** `server.json` の `registryType`。 */
  registryType: string;
  /** 人に出す名前。 */
  label: string;
  /** 取ってくるのに要る実行環境（無ければ入れられない）。 */
  runtime: string;
  supported: boolean;
  /** **対応していない理由**。黙って飛ばさない（規則2）。 */
  reason?: string;
}

/**
 * **いま対応している形式の表**（唯一の真実）。
 *
 * `supported: false` のものも**消さずに並べる**——画面が「まだ対応していない」と
 * 理由つきで言えるようにするため。行ごと消すと、人には「そんな形式は無い」に見える。
 */
export const FORMAT_SUPPORT: readonly FormatSupport[] = [
  { registryType: "npm", label: "npm", runtime: "npm", supported: true },
  {
    registryType: "pypi",
    label: "PyPI",
    runtime: "uvx",
    supported: false,
    reason: "Python の取得に使う uvx を banto がまだ扱っていません",
  },
  {
    registryType: "oci",
    label: "コンテナ（OCI）",
    runtime: "docker",
    supported: false,
    reason: "コンテナは Landlock とは別の閉じ込めになるため、扱いをまだ決めていません",
  },
  {
    registryType: "nuget",
    label: "NuGet",
    runtime: "dotnet",
    supported: false,
    reason: ".NET の取得を banto がまだ扱っていません",
  },
  {
    registryType: "mcpb",
    label: "MCPB",
    runtime: "—",
    supported: false,
    reason: "配布物の SHA-256 の検証を先に決める必要があります",
  },
];

export function formatSupportOf(registryType: string): FormatSupport {
  return (
    FORMAT_SUPPORT.find((f) => f.registryType === registryType) ?? {
      registryType,
      label: registryType,
      runtime: "—",
      supported: false,
      // **知らない形式を「対応していない」と言い切る**——推測で通さない（規則2）
      reason: `banto の知らない配布形式です（${registryType}）`,
    }
  );
}

/** その1件を、banto がどう繋ぐことになるか。 */
export type ConnectPlan =
  /** 相手のサーバへ URL で繋ぐ（こちらでは動かさない＝閉じ込めは掛からない） */
  | { kind: "remote"; url: string; transport: string; remote: RegistryRemote }
  /** こちらで取ってきて動かす */
  | { kind: "local"; pkg: RegistryPackage; support: FormatSupport }
  /** 繋ぎようが無い */
  | { kind: "none"; reason: string };

/**
 * **どう繋ぐかを1つに決める**（画面に選ばせない——選ぶ材料を人が持っていない）。
 *
 * **remote を先に見る。** こちらでコードを動かさずに済むほうが、人の machine に
 * とっては軽い（閉じ込めの要らない経路）。ただし**外へ出ていく**ので、画面は
 * 今までどおり相手の名前を出す（`add-instance-module-dialog.tsx`）。
 *
 * local は**対応している形式を優先**する。対応していないものしか無いときは、
 * **その理由をそのまま返す**——「使えません」だけで終わらせない。
 */
export function planFor(server: RegistryServer): ConnectPlan {
  const remote = server.remotes?.[0];
  if (remote?.url) return { kind: "remote", url: remote.url, transport: remote.type, remote };

  const packages = server.packages ?? [];
  const usable = packages.find((p) => formatSupportOf(p.registryType).supported);
  if (usable) return { kind: "local", pkg: usable, support: formatSupportOf(usable.registryType) };

  if (packages.length > 0) {
    const first = packages[0]!;
    const support = formatSupportOf(first.registryType);
    return { kind: "local", pkg: first, support };
  }
  return { kind: "none", reason: "繋ぎ方（remotes も packages も）が書かれていません" };
}

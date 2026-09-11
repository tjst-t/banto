// **設定画面を開いているときの、Project の行き先**（決定・2026-09-11、ユーザー要望）。
//
// 設定は1つの画面で、どの Project の層を出すかは `?project=<id>`（§6.16）。
// そこでサイドバーの Project を押したときは：
//
//   - **別の Project** → 設定を閉じない。**その Project の設定**に切り替える
//   - **いま設定で見ている Project** → 設定を閉じて、その会話へ戻る
//
// 判断は1箇所に持つ（規則3）——開いたサイドバーと畳んだレールが同じ答えを使う。

/** その Project の層に属する節か（切り替えても同じ節を保てる） */
function isProjectSection(section: string | null): boolean {
  return section !== null && section.startsWith("project-");
}

export function projectNavHref(
  projectId: string,
  /** いまのパス（`/settings` かどうかだけ見る） */
  pathname: string,
  /** いまの `?project=` と `?section=` */
  current: { project: string | null; section: string | null },
): string {
  if (pathname !== "/settings") return `/p/${projectId}`;
  // いま設定で見ている Project を押した＝「会話に戻る」
  if (current.project === projectId) return `/p/${projectId}`;
  // 別の Project——設定のまま、その Project の層へ。Project の層の節を見ていた
  // ならその節を保ち（見比べられる）、そうでなければ先頭の節へ
  const section = isProjectSection(current.section) ? current.section : "project-modules";
  return `/settings?project=${projectId}&section=${section}`;
}

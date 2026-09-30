// **設定は、いまの画面の上に重ねて開く**（改訂・2026-09-28、ユーザー要望「設定は上にかぶせる形がいい」）。
//
// 以前の設定は別のページ（`/settings`）だった。開くと会話の画面が**捨てられ**、閉じると作り直されて
// いた（入力欄・スクロール・開いていた Fork や Canvas・流れていた返事の読み取りを失う）。いまは受信箱・
// Command Palette と同じく、URL の印（`?settings=1`）で**いまの画面の上に**重ねる。受信箱などの
// `overlay` とは別の印にする——設定の上で Command Palette を開いて閉じても、設定は閉じない。下の画面は
// そのまま生きている。どの Project の層を出すか（`project`）・どの節か（`section`）も URL が持つ
// （§6.16、規則3）。
//
// `/settings` を直接開いたとき（ブックマーク・読み込み直し前の URL）も同じ設定の面が出る——下に
// 何も無いだけ。
//
// **設定を開いているときの、Project の行き先**（決定・2026-09-11、モックで確認）。
// 設定の中でサイドバーの Project を押したときは：
//
//   - **別の Project** → 設定を閉じない。**その Project の設定**に切り替え、**下の画面もその Project の会話**に
//     する（改訂・2026-09-30、ユーザー要望）——閉じたとき、いま設定で見ていた Project が出ている
//   - **いま設定で見ている Project** → 設定を閉じて、その会話へ戻る
//
// 判断は1箇所に持つ（規則3）——開いたサイドバーと畳んだレールが同じ答えを使う。

const SETTINGS_PARAM = "settings";

/** URL の読み取り口（`useSearchParams()` の返り値も `URLSearchParams` も渡せる） */
interface ReadableParams {
  get(name: string): string | null;
  toString(): string;
}

function withQuery(pathname: string, params: URLSearchParams): string {
  const q = params.toString();
  return q ? `${pathname}?${q}` : pathname;
}

/** 設定の面が開いているか */
export function isSettingsOpen(pathname: string, params: ReadableParams): boolean {
  return pathname === "/settings" || params.get(SETTINGS_PARAM) === "1";
}

/** いまの画面の上に設定を開く URL */
export function settingsOpenHref(
  pathname: string,
  params: ReadableParams,
  target: { project?: string | null; section?: string | null } = {},
): string {
  const next = new URLSearchParams(params.toString());
  if (pathname !== "/settings") next.set(SETTINGS_PARAM, "1");
  if (target.project) next.set("project", target.project);
  else next.delete("project");
  if (target.section) next.set("section", target.section);
  else next.delete("section");
  return withQuery(pathname, next);
}

/** 設定を閉じる URL——下の画面はそのまま。`/settings` を直接開いていたなら、見ていた Project の会話へ */
export function settingsCloseHref(pathname: string, params: ReadableParams): string {
  if (pathname === "/settings") {
    const project = params.get("project");
    return project ? `/p/${project}` : "/";
  }
  const next = new URLSearchParams(params.toString());
  next.delete(SETTINGS_PARAM);
  next.delete("project");
  next.delete("section");
  return withQuery(pathname, next);
}

/** その Project の層に属する節か（切り替えても同じ節を保てる） */
function isProjectSection(section: string | null): boolean {
  return section !== null && section.startsWith("project-");
}

export function projectNavHref(
  projectId: string,
  /** いまのパス */
  pathname: string,
  /** いまの URL の問い合わせ部分 */
  params: ReadableParams,
  /** 設定の中で、その Project の層が始まる節（繋がっているものが Project ごとに違う） */
  fallbackSection: string,
): string {
  if (!isSettingsOpen(pathname, params)) return `/p/${projectId}`;
  // いま設定で見ている Project を押した＝「会話に戻る」
  if (params.get("project") === projectId) {
    // その Project の画面の上に開いていたなら、設定を閉じるだけ（下の画面をそのまま見せる）
    if (pathname === `/p/${projectId}`) return settingsCloseHref(pathname, params);
    return `/p/${projectId}`;
  }
  // 別の Project——設定のまま、その Project の層へ。Project の層の節を見ていた
  // ならその節を保ち（見比べられる）、そうでなければ先頭の節へ。
  // **下の画面もその Project の会話にする**（改訂・2026-09-30）。前の Project の画面の印（開いていた Fork・
  // Canvas など）は連れていかない——別の Project のものだから
  const current = params.get("section");
  const section = isProjectSection(current) ? current : fallbackSection;
  return settingsOpenHref(`/p/${projectId}`, new URLSearchParams(), { project: projectId, section });
}

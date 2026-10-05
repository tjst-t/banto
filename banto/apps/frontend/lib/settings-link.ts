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
  return threadNavHref(projectId, null, pathname, params, fallbackSection);
}

/**
 * **サイドバー・レールの Thread の行（Base か Fork）を押したときの行き先**（改訂・2026-10-05、ユーザー要望）。
 * **設定を開いていても、設定を閉じてその会話を出す**。2026-09-30 から 10-05 までは設定を開いたまま下の画面だけ
 * 替えていた（下の `threadNavHref`）が、「Thread を押したらその会話が見たい」に改めた。Project の名前を押したとき
 * （`projectNavHref`）・Fork を閉じたあと・Command Palette はこれまでどおり `threadNavHref`。
 */
export function threadRowHref(projectId: string, forkId: string | null): string {
  const under = new URLSearchParams();
  if (forkId) under.set("fork", forkId);
  return withQuery(`/p/${projectId}`, under);
}

/**
 * **Thread（Base か Fork）への行き先**（追加・2026-09-30、ユーザー指摘）。設定を開いていなければその会話へ。
 * **設定を開いていれば、設定は開いたまま、下の画面をその会話にし、設定もその Project の層にする**。
 * 以前は Project 名だけがこの形で、サイドバーの「Base Thread」・Fork の行・レールの Fork 一覧・Command Palette
 * は素の `/p/…` へ飛び、設定が閉じていた（サイドバー・レールの Thread の行は 2026-10-05 に `threadRowHref` で
 * 設定を閉じる形へ戻した）。設定を閉じるのは Escape・閉じるボタン・いま設定で見ている
 * Project の名前を押す（`projectNavHref`）とき。
 */
export function threadNavHref(
  projectId: string,
  forkId: string | null,
  pathname: string,
  params: ReadableParams,
  /** その Project の層が始まる節（別の Project へ移るとき、全体の節を見ていたらここへ） */
  fallbackSection: string,
): string {
  const under = new URLSearchParams();
  if (forkId) under.set("fork", forkId);
  if (!isSettingsOpen(pathname, params)) return withQuery(`/p/${projectId}`, under);
  // 同じ Project なら見ている節のまま。別の Project なら、Project の層の節を見ていたときだけその節を保つ
  // （見比べられる）。前の Project の画面の印（開いていた Canvas など）は連れていかない
  const current = params.get("section");
  const section =
    params.get("project") === projectId ? current : isProjectSection(current) ? current : fallbackSection;
  return settingsOpenHref(`/p/${projectId}`, under, { project: projectId, section });
}

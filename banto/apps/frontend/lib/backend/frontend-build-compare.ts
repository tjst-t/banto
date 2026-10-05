// 画面の版の比べ方（frontend-build.ts から分けた。単体で試すため、ほかを読み込まない）

/**
 * サーバの印が、このページの印と違う（＝読み込み直せば新しい画面になる）か。
 * どちらかが分からないときは「違わない」——分からないのに読み込み直しを勧めない
 */
export function isNewerBuild(pageBuild: string | null, serverBuild: unknown): serverBuild is string {
  return typeof pageBuild === "string" && pageBuild !== "" && typeof serverBuild === "string" && serverBuild !== "" && serverBuild !== pageBuild;
}

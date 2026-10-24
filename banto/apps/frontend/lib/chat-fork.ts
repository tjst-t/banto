// **チャットでは Fork を作らない**（決定・2026-10-21、ユーザー。`docs/specs/v4-architecture.md` §2.2「チャット」・
// `docs/specs/v4-frontend.md` §6.53「会話の画面」）。会話の右上の「…」の「Fork を開く」・発言から分ける操作を、この答えで出し分ける。
// host も同じ口を 409 `chat-no-fork` で断る——画面は押せるものを出さないだけ。「Project にする」で印が外れたら出る

/** この Project の会話に Fork を作る操作を出すか（チャットなら出さない） */
export function forkActionsAllowed(project: { kind?: "chat" | "meta" }): boolean {
  return project.kind !== "chat";
}

// **Canvas から banto の確かめの画面を開かせる頼み**の置き場（banto の拡張、2026-10-02〜03）。
// `dev.banto/open-new-project`（新しい Project の画面）と `dev.banto/close-projects`（Project を閉じる確かめ）が同じ形で使う
// ——受ける・断るの決まりを1箇所に置く（規則3）：
//
// - 開く場所（外枠のダイアログ）が出ていない面（別タブの Canvas）からは断る——「開いた」と返して何も出ないことにしない
// - 開いている間の頼みは受けない——人が打ちかけた入力・見ている確かめを捨てて開き直さない
// - **会話の中の画面**（AI の tool の結果として出たもの）からは、人がその画面を押した直後（一時的な利用者の操作）でなければ
//   受けない——AI のターンの画面が、人の見ていないところで開かせない。入口・設定の面は直後でなくても受ける
//   （clone・削除は時間がかかり、終わったときには押した瞬間は過ぎている）
// - どの Module からでも同じ——core は頼んできた Module を名指ししない。ただし開いた画面に出所（`from`）を出す

export interface CanvasRequestStore<T> {
  decide(input: { fromConversation: boolean; activated: boolean }): { ok: true } | { error: string };
  request(input: T): void;
  clear(): void;
  subscribe(listener: () => void): () => void;
  get(): (T & { seq: number }) | null;
  registerHost(): () => void;
}

export function createCanvasRequestStore<T>(what: string): CanvasRequestStore<T> {
  let current: (T & { seq: number }) | null = null;
  let seq = 0;
  let hosts = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of listeners) l();
  };
  return {
    decide(input) {
      if (hosts === 0) return { error: `この画面からは${what}を開けません（banto の画面で開いてください）` };
      if (current) return { error: `${what}は、もう開いています` };
      if (input.fromConversation && !input.activated) return { error: "会話の中の画面からは、人が押した直後にだけ開けます" };
      return { ok: true };
    },
    request(input) {
      seq += 1;
      current = { ...input, seq };
      notify();
    },
    clear() {
      current = null;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => current,
    registerHost() {
      hosts += 1;
      return () => {
        hosts -= 1;
      };
    },
  };
}

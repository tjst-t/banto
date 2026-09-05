// lib/mock/adapter.ts（台本再生）とlib/backend/adapter.ts（実host接続）の
// 両方が同じtool名を使う必要があるため、循環import回避のためにここへ切り出した
// （元はadapter.ts内にまとまっていた——lib/mock/adapter.tsから引き続きre-exportする）。

// useLocalRuntime の unstable_humanToolNames と合わせる（thread-panel.tsx）
export const HUMAN_TOOL_NAME = "banto_ask";

// Shell Module（v4-modules.md §2.3）の唯一の tool。会話内のインラインカード
// （ShellCommandCard）はこの名前で分岐する——resource を持たない Shell には
// InlineModuleView（Module の Canvas コンテンツを埋め込む経路）が無いため、
// 専用の表示を持つ
export const SHELL_RUN_COMMAND_TOOL_NAME = "banto_shell_run_command";

// 承認ゲートを通りうる tool 名。unstable_humanToolNames にも含める
// （thread-panel.tsx）——「承認専用の別 tool」は作らない：承認ゲートは
// `canUseTool` の一般機構であって、tool の側が承認用に分裂するものではない
// （Shell の tool は runCommand 1本だけ、v4-modules.md §2.3）。
// 実測で分かったこと（規則1）：assistant-ui の `approval` フィールド／
// `respondToApproval` は「承認された直後、次の run() が同じ round trip の中で
// 結果を返す」前提で shouldContinue が組まれており（承認済みでも result が
// 無ければ do-while が回り続ける）、こちらの資産（コンポーネントの副作用で
// 後から addResult する形）とは相性が悪く、二重に _runLoop が走って
// スタックする事故を実測で踏んだ。**human tool とまったく同じ枠組み**
// （unstable_humanToolNames + addResult）に統一することで、既に動作確認済みの
// 経路だけを使う（規則12——一度ハマった機構をもう一度別の形で作り直さない）
// host が中継する Module 間の呼び出し（v4-architecture.md §2.5）。Runner の tool 一覧には
// 載らない（visibility: module）ので、これは「AI が呼んだ tool」ではなく
// **host 自身が発生源の判断待ち**である——会話の中に出すために、他と同じ
// tool 呼び出しの器に載せているだけ
export const MODULE_RELAY_TOOL_NAME = "banto_module_relay";

export const APPROVAL_TOOL_NAMES: readonly string[] = [
  SHELL_RUN_COMMAND_TOOL_NAME,
  MODULE_RELAY_TOOL_NAME,
];

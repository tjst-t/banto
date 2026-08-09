---
id: task-0088
type: task
kind: feat
title: 会話を幹1本と枝にし、器と作業する面を分ける（ADR-0017）
status: todo
refs: [adr-0017, adr-0015, adr-0010, spec-ui, spec-chat-ui, spec-canvas-ui]
scope:
  paths:
    [
      "packages/banto-host/src/threads.ts",
      "packages/banto-host/src/thread-tools.ts",
      "packages/banto-host/src/canvas*.ts",
      "packages/banto-web/src/**",
      "docs/spec/ui.md",
      "docs/spec/chat-ui.md",
      "docs/spec/canvas-ui.md",
      "tests/**",
    ]
acceptance:
  - {
      id: a1,
      text: "プロジェクトごとに幹が1本あり、畳めない（会話のタブが無い）",
    }
  - {
      id: a2,
      text: "枝は還す条件が無いと開けない。番頭の判断でも PO の指示でも開ける",
    }
  - {
      id: a3,
      text: "枝を畳むと幹の末尾に結論が1行積まれる。幹の既存の行は書き換わらない",
    }
  - {
      id: a4,
      text: "枝の中に枝は開けない（深さ1段）",
    }
  - {
      id: a5,
      text: "開いている枝は必ず「幹の札・横断の通知・レールの点」のどれかに出ている",
      verify: "tests/acceptance で全枝を走査して確かめる",
    }
  - {
      id: a6,
      text: "canvas.show が器名と退避済み結果への参照を取り、データを再送させずに描く",
    }
  - {
      id: a7,
      text: "器は13種。どれも畳んだ姿を持ち、コンテナクエリで切り替わる",
    }
  - {
      id: a8,
      text: "どの器も「いつの」を出す。器は後から書き換わらない",
    }
  - {
      id: a9,
      text: "描けない戻り値は、モジュール名・Tool 名・器名・足りないものを添えて会話に出る。番頭にも同じものが返る。会話は止まらない",
    }
  - {
      id: a10,
      text: "判断待ちの固定帯が無い。遡ったときだけ↓ボタンが朱になる",
    }
  - {
      id: a11,
      text: "作業する面を開くと、いま居た会話が細い帯として残り、話しかけられる。帯の幅は変えられる",
    }
  - {
      id: a12,
      text: "面はどこから開いたかを覚える（幹から→枝を閉じる／枝から→枝を残す）",
    }
  - {
      id: a13,
      text: "狭い画面（760px 以下）では幹が地、枝と面が重なる紙になる",
    }
  - { id: a14, text: "npm test / npx playwright test が通る", verify: "npm test && npx playwright test" }
---

## 背景

ADR-0017（accepted 2026-08-09）の実装。案3「座敷」が 2026-08-05 の裁定⑤「主従は後で」
で未決のまま残っていた件に決着が付いた。

見本は `prototype/redesign/13-tsuzukima-kai.html`（決定の姿）と
`prototype/redesign/12-utsuwa.html`（器の語彙 13 種）。到達までの経緯は
`03-zashiki` / `06-suji` / `07-ukagai` / `08-chomen` / `09` / `10` / `11` に残っている。

## 分けかた

大きいので、この順で分けて進める。**a1〜a5（幹と枝）が土台**で、器はその上に乗る。

1. **幹と枝のデータモデル**（a1〜a4）。`ThreadRegistry` を親子に開く。
   還す条件を必須の欄にし、深さ1段を機構で縛る
2. **埋没しない不変条件**（a5）。走査する試験を先に書く
3. **器の語彙**（a7・a8）と `canvas.show`（a6）。モジュールは触らない
4. **描けなかったときの出方**（a9）
5. **判断待ちの出し方**（a10）。`PendingDecisions` の固定帯を落とし、↓ボタンへ載せる
6. **作業する面**（a11〜a13）。`file.viewer` を足し、`file.browser` と分ける
7. **spec の改訂**。`spec-ui` §1 / `spec-canvas-ui`（器の語彙・読む面と作業する面）

## 注意

- **`spec-chat-ui` §7.3 は ADR と同時に書き換え済み**（compaction → 章立て）。
  ADR-0010 決定47(b) への追従漏れだったので、この task の対象ではない
- **ADR-0015 決定73 の取次そのものは触らない。** 変わるのは判断待ちの画面側だけ
- 器を増やしたくなったら **ADR を通す**（ADR-0017 未決事項）

---
id: imp-0057
title: 読み戻しのたびに会話の「開いた時刻」と sessionFile が振り直される
status: inbox
kind: improvement
origin: 枝「枝が起動しない」(thread-105) の調査中に発見。imp-0056 の時系列を作るときに実際に誤読を招きかけた
refs:
  - packages/banto-host/src/threads.ts
created: 2026-08-15
---

## 何が起きているか

`ThreadRegistry.restore()`（`threads.ts:713` 付近）が `new Thread({...})` に **`createdAt` を
渡していない**ため、`threads.ts:312` の既定値 `new Date().toISOString()` が効く。つまり
**ホストを再起動して会話を読み戻すたびに「開いた時刻」が現在時刻に書き換わる**。
`index.json` に残っている値は最後の読み戻しの時刻であって、その会話が開かれた時刻ではない。

`sessionFile` の名前も同様に振り直されており、`index.json` が指すファイルが `sessions/` に
**存在しない**ことがある。

## なぜ困るか

- **事実が書き換わる**（I1）。imp-0056 の調査では `index.json` の `createdAt` が
  「thread-104 は再起動**後**に作られた」と読める値になっており、journal のログと突き合わせて
  いなければ原因を取り違えていた。会話の並び順や履歴の表示にも効く。
- 「いつ開いた枝か」を機構が答えられないので、**古い枝の棚卸しができない**。

## 直す方向

- `restore()` で保存済みの `createdAt` をそのまま復元する（imp-0056 の直しに同梱する）。
- `sessionFile` の方は影響が読み切れないので**別途**。まず「index が指すファイルが実在するか」
  を起動時に確かめて、食い違いを黙らせない（I2）ところから。

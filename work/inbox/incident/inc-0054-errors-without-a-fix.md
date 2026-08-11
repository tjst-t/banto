---
id: inc-0054
type: incident
kind: incident
origin: po
class: tool-contract
status: resolved
refs: [thread-72, imp-0016]
---

## 内容

**断り文句に「直し方」が書かれておらず、番頭が同じ呼び出しを繰り返して空回りする。**

2026-08-11、thread-72（外部公開方法のモジュール化）で実測。番頭が `file.write` を
**place 指定なしで7回連続**で呼び、毎回同じエラーが返り、最後は打ち切られた
（`stopReason: aborted`）。返っていたのはこれ:

```
Multiple places are registered (banto, desk, github.com/..., ...). Specify one.
```

**事実としては正しいが、どの引数に何を入れれば通るのかが書かれていない。** 読んだ側は
「複数ある」ことしか分からず、`place` という引数名にも、そこへ id を入れることにも
到達できない。ターン予算の見張り（`turn-budget.ts`）が「同じ確認を4回出しています」と
割り込んだが、**直し方が分からない以上それでも止まらなかった**。

## なぜ起きたか

道具のエラーは**番頭にとっては唯一の手がかり**で、人間向けのログとは要求が違う。
「何が起きたか」だけでなく「次に何をすれば通るか」まで書かないと、回復の手がない。

`place-scoped.ts` の作りも効いていた。`file.*` / `git.*` は自分がどの場所に居るかを
知らず（この層が根を差し替えている）、素の「No such file: work/reports/x.md」だけが
返る——**パスが違うのか場所が違うのかを切り分けられない**ので、場所を変えずに
繰り返すことになる。

## 直したこと

**「既存の頭（英語）は残し、直し方を後ろに足す」**方針で揃えた。頭を変えなかったのは、
既存の試験20箇所がそこを見ているため（P1: 触る範囲を広げない）。

| 場所 | 前 | 後（足したもの） |
|---|---|---|
| `places.ts` `resolve()` | `Multiple places are registered (...). Specify one.` | 引数名 `"place"`・候補・そのまま書き写せる例 |
| `places.ts` `resolve()` | `No place is registered.` | 何ができないか、`place.list` へ誘導 |
| `places.ts` `require()` | `Unknown place "x". Registered: ...` | 引数名と例 |
| `places.ts` `resolveInPlace()` | `Path "x" is outside the place "id".` | その場所の**根**（パスと場所のどちらを直すか決められる） |
| `place-scoped.ts` | （素通し） | 失敗時に**どの場所を見た結果か**を添える |
| `workspace.ts` | `Path "x" is outside the workspace.` | **根** |
| `canvas.ts` ×3 | `Unknown canvas tab "x".` | いま開いているタブの id（無ければ `canvas.open` へ誘導） |
| `threads.ts` ×6 | `unknown thread: x` | 開いている会話のIDと題、畳んだ本数 |
| `threads.ts` | `no trunk` | 何が無いのか、`thread.open` へ誘導 |

**「一覧が空」と「引数が違う」を書き分けた**のが要点——直し方が別なので、同じ文言で
返すと片方は必ず迷子になる。

## 確かめたこと（I1）

- 回帰試験を3ファイルに追加（`banto-places` 4件・`banto-canvas` 2件・`banto-threads` 2件）
- **直しを戻すと落ちる**：`places.ts` / `place-scoped.ts` を旧文言へ戻すと 2件 fail、
  復元して 35/35 pass
- 既存の試験（`Unknown place` / `outside the workspace` / `unknown thread` /
  `Unknown canvas tab` を見ている20箇所）は**頭を残したので無変更で通る**

## 残っている論点

- **他のモジュールは見ていない。** 今回直したのは `banto-host` の中だけで、Kobo・
  Worker Pool・Environment Pool が番頭へ返すエラーは未点検。同じ基準で洗う価値がある
- **道具の説明文（スキーマ）側では直していない。** `place` は任意引数のままで、
  場所が複数あるときに必須にする案は取らなかった（省略できることに意味がある場面が
  あるため）。エラーで導く形で十分かは、しばらく実測してから

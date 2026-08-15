---
id: inc-0071
title: ブラウザ試験 trunk-branch.spec.ts が 9 件、strict mode violation（.u-open が2つに当たる）で落ち続けている
status: inbox
kind: incident
origin: 「モバイルの自動フォーカス」の枝で、無関係な変更の検証中に踏んだ。変更前の HEAD でも同じ 9 件が同じ理由で落ちる
refs:
  - tests/trunk-branch.spec.ts
  - packages/banto-web/src/App.tsx
created: 2026-08-15
---

## 何が起きているか

`npx playwright test tests/trunk-branch.spec.ts` が **9 件失敗**する。理由はすべて同じで、
`.u-open` のロケータが**要素2つに当たる** playwright の strict mode violation。

- 観測したのは職人（session 783a2f45、taskId mobile-no-autofocus）のホスト上の実行
- **変更前の HEAD でも同一の 9 件が同一のメッセージで落ちる**ことを、Room.tsx を一時的に戻して
  dist を作り直したうえで確かめている（＝今回の変更とは無関係）
- 同じ実行で `tests/mobile-layout.spec.ts` と新しい `tests/mobile-no-autofocus.spec.ts` は通る

## なぜ放置できないか

ブラウザ試験の一群が**恒常的に赤い**ので、画面を直すたびに「元から落ちているのか、自分が
壊したのか」を毎回切り分ける羽目になる。実際この枝でも切り分けに一往復を使った。
間欠ではなく決定的な失敗なので、直せば緑に戻る。

## 最初の一手

1. 落ちている 9 件と、当たっている 2 つの `.u-open` 要素を実際に出す（再現）
2. 画面側で `.u-open` が2つ描かれるのが正しいのか（＝試験の絞り方が甘い）、それとも
   描かれてはいけないものが出ているのか（＝画面の退行）を見分ける
3. 前者なら試験のロケータを意図が読める形に絞る。後者なら画面を直す

## 参照

- `docs/principles.md` I1（自己申告を信頼しない）・P6（間欠的に落ちる試験は機構が壊れている合図）
- 同じ「試験が恒常的に赤い」系: `work/inbox/incident/inc-0074-model-select-e2e-broken.md`

# 同梱の道具用のコンテナの実装（Backlog #309、2026-10-15）

仕様は `docs/specs/v4-security.md` §2「同梱の道具用のコンテナの作り」。ここは経緯と、実装で決めたこと・残したこと。

## 測ったこと

- 土台のイメージ（`banto-base-*`）から起こしたコンテナで、uid 1000（`ubuntu`）は **`/etc/sudoers.d/banto` を消しても
  `/etc/sudoers.d/90-incus`（`ubuntu ALL=(ALL) NOPASSWD:ALL`）でパスワード無しの sudo ができた**。両方を消すと
  `sudo -n true` は「a password is required」で通らない（`ubuntu` はパスワードが無い＝ロック）。念のため sudo の組からも外す
- `SUDO_FORCE_REMOVE=yes dpkg --purge sudo` は依存で断られた（`dependency problems - not removing`）。パッケージを外す案は採らず、
  設定を消して「できないことを確かめる」形にした

## 決めたこと（仕様に書いたもの以外）

- **入れられなかったことを覚えるのは banto の走行の間だけ**。Event Store に残すほどのものではない（起こし直したら1回だけやり直す）。
  仕様の「毎回やり直さない」は、Module の起こし直し・頼みのたびに apt を走らせない、の意味で満たす
- **失敗はパッケージの組ごと**に覚える。別の Module の名乗った組が入らなくても、ほかの組は入れられる
- **試しの Module は目録の `hidden`**。同梱の判定（同じコードか）は目録から引くので、試しの Module も目録に置く必要がある。
  画面の目録には出さず、入れる口は同じ
- **「道具を入れ直す」は入れられなかったときだけ行の「…」に出す**（入っているのに押せると、何も起きないボタンになる）

## 残したこと・人に上げること（規則8）

- **`documents` の変換を「中の root で起こす」形はまだ無い**（`v4-modules.md` §2.2「LibreOffice の閉じ込め」）。道具用の
  コンテナの Module は、ほかのコンテナの Module と同じく host と同じ uid で起きる（`execInContainer`）。bubblewrap を root から
  起こすには、Module のプロセスを root で起こすか、変換を起こす小さな部分だけを root で起こす口が要る。#304（office-converter）で決める
- 「入れている間の頼みには『変換役を入れています』を返す」は、頼みを受ける側（`documents`・FileSystem）の仕事として #304 に残した。
  core は入れている間、設定の一覧で「Installing」を返すところまで
- 入れられなかった・入れ直したことの E2E は無い（apt を確実に失敗させる手段が E2E に無い）。単体試験
  （`host-container.test.ts`）で、覚える・やり直さない・入れ直すで1回だけやり直す、を見ている

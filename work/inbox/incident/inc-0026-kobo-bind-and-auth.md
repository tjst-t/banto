---
id: inc-0026
type: incident
kind: incident
origin: agent
class: spec-drift
status: open
refs: [adr-0010, adr-0013, spec-daemon-core]
---

## 内容

**ADR-0010 決定40(a)（2026-08-01、PO裁定）は「既定で localhost だけを待ち受ける」を機構で担保した。** 番頭ホストは `listen(port, "127.0.0.1")` で、広げるには `--host` / `BANTO_HOST_BIND` の明示を要求し、広げたときは起動ログに警告を出す。

**Kobo は `daemon.ts` で `listen(this.config.port, "0.0.0.0")` と全インターフェースに出ている。** `http-server.ts` の冒頭には `Authentication: none (local network, spec §8 open item)` と明記され、`spec-daemon-core` §8 でも認証は未決のままになっている。

## なぜ問題か

決定40 の裁定は「Banto に認証を持たせない。気になる配置では前段（Caddy 等）で守る」だが、それが成り立つのは**素通りできないこと**が機構で担保されている場合だけである（決定40a がまさにその理由で既定を閉じた）。

Kobo を配線すると、**番頭側で塞いだ経路の隣に無認証の口が開いたまま**になる。しかも Kobo はタスクの状態遷移 API を持つので、叩ければ `approved` を任意に打てる——**マージ前ゲートは通るが、レビューは飛ばせる**。

## 対処

ADR-0013 決定60・63 の一部として task-0061 で実装する（既定 127.0.0.1・広げたら警告）。

**`spec-daemon-core` §7・§8 の改訂が別途要る**——「サーバ集中型・全インターフェース」の記述と、§8 の「APIの認証方式（未決）」を、決定40 の結論（前段で守る／既定は閉じる）に寄せる。

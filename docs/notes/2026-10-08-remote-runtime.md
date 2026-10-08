# 2026-10-08 Project の実行場所を VM・別のサーバに広げる検討

Fork「実行環境を VM・別サーバに広げる検討」。仕様は `docs/specs/v4-security.md` §1「Project の実行場所——別のサーバ」。

## 問い

Project の実行環境を、今の Incus のシステムコンテナだけでなく VM・別のサーバでも使えるようにできないか（ユーザー）。

## 今の作りで、コンテナに頼っているところ（コードを読んで洗い出した）

- `packages/container/src/project-container.ts`：作る・起こす・止める、Project の根と banto のコードと Module の置き場を
  **host と同じパスで**マウント（`raw.idmap` で持ち主を揃える）、node を `incus file push`、資源の上限 `limits.*`、
  host に届くアドレス（ブリッジの host 側）、コンテナのアドレス（Publish 用）、cgroup の数え（上限の知らせ）
- `core/src/cli.ts`：`incus exec` で Module を起こし標準入出力を繋ぐ（env は `--env`）、Module の置き場を中に見せる、
  Vault の ssh-agent の窓口を Module の置き場の中（`<置き場>/s`）に立てる、Shell のホームに設定を写す
- host の側で Project の根を直接触るもの：Runner（Claude Code の CLI）の cwd・CLI の記録の置き場の鍵
  （`http/app.ts`・`delivery/turn-continuation.ts`）、Repositories（clone・削除・ブランチを送る口）、フォルダ選び
  （`GET /api/fs/directories`）、広すぎる根の判定
- 流れの口（アーキ §5.8）は host が Module の置き場の UNIX ソケットへ host の側のパスで直接繋ぐ

## 3つの候補の当てはめ（◎そのまま／△替わりが要る／×成り立たない）

| 今の仕組み | Incus の VM | SSH の別のサーバ | 別のサーバの Incus |
|---|---|---|---|
| Module を起こして標準入出力 | ◎（incus-agent） | ◎ ssh | ◎ リモートの incus exec |
| Project の根を同じパスで | △ virtiofs、`raw.idmap` 不可 | × 向こうにある | × 同じ |
| Module の置き場を同じパスで | △ virtiofs | × 向こうに置く | × 同じ |
| host で根に触るもの | ◎ | × 作り直し | × 同じ |
| 中から banto（/relay・Claude） | ◎ | △ 入口が閉じている→SSH の逆向きトンネル | △ |
| Vault の ssh-agent（ソケット） | × virtiofs を越えない | × 転送が要る | × |
| Publish | ◎ | △ LAN で届けば | △ |
| 資源の上限・知らせ | △ メモリは割り当て、CPU の時間の上限・プロセス数が効かない | — | ◎ |
| 起こす速さ | △ 数十秒 | ◎ | ◎ |

この Project のコンテナには `/dev/kvm` が無く、VM は試せなかった。`poc/10-project-vm/probe.sh`（host 用）は未実行。

## 決まったこと（ユーザー）

1. **本命の場面**は「containerlab で Proxmox を試し、その上で VM を動かす」。banto の host 自体が VM なので、今の
   コンテナでも Proxmox が2段目・その上の VM が3段目、Incus の VM だと3段目・4段目になる。物理サーバなら1段目・2段目で
   仮想化支援が効く。→ **Incus の VM（案1）はこの目的に効かないので優先しない**
2. **まず案2（SSH で入るサーバ丸ごとを Project の箱）を作り、あとでそのサーバの中の Incus のコンテナ（案3）を足せる形に**
3. 本番の物理サーバは banto の host と同じ LAN の Ubuntu（これから組む）。試験にはまず別の VM を立てる
4. 案2の作りの8点（登録と選び方・向こうに置くもの・SSH の接続1本・host が根に触っていたものの扱い・閉じ込め・
   最初は作らないもの・Publish・試験）は提案どおり（「8点ともおすすめでよい」）

## 実行場所を Module にしなかった理由

Vault・Publish・Backlog の「窓口1本＋実装が複数」の形も考えたが、実行場所は Module を起こす側なので Module にすると
自分を起こせない。閉じ込めは core が持つと決めている（v4-security §1）。core の中の差し替え口にする。

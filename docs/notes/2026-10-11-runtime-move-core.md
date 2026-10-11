# Project を別の実行場所へ移す——本体（Backlog #263 `runtime-move-core`、2026-10-11）

仕様は `docs/specs/v4-security.md` §1「Project を別の実行場所へ移す」（「実装の形」に決まったことを書いた）。ここは経緯と、
選ばなかった形。

## 決めたこと・選ばなかった形

- **写すのは tar の流れを host のこの process に通す形**。別のサーバどうしでも host を経由する（仕様どおり）。この機械の側も
  `sh -c tar` で流す——同じ台本を両側で使えるので、件数と大きさの確かめ（`find -printf`）も同じ除き方で書ける。
  rsync は使わない（向こうに入っているとは限らない・前提の確かめに足すほどの理由が無い。規則10）
- **進み具合はメモリだけ**。Event Store に写した量を積むと、1回の移し替えで何百件も増える。起き直したあとは、記録の
  started だけで「途中で止まった」と分かれば足りる（起き直したら片づけて failed を積むので、続きから写すことはしない）
- **移す先の作ったものの記録は started に入れる**。started を積む前に根を作り・残っていた置き場を退かせる（その結果を
  started に書く）——起き直したときに片づける範囲を、記録だけから決められる。started を積む前に落ちると、空の根と
  `.before-` が残る（害は無い・人が見て消せる）
- **`s` だけの置き場**は「空と見なす」（仕様）。写す先にそのまま重ねる。片づけでは `s` を残し、ほかを消す
- **動いているものを Module に tool で聞く口は作らなかった**（仕様との違い・人に上げる）。Factory の件・Shell の待たない
  コマンドはどちらも会話への返事待ちの札を持つ——host の札で数えられる。Module ごとに「いま何か抱えているか」の口を足すと、
  契約が1つ増えるのに、今ある Module では答えが札と同じになる
- **Service の unit を disable する口は Service の Module の管理操作**（`disableAllServices`、可視性 admin）。core は
  `services.json` を書かない（仕様）。Service の Module に繋げない・systemd を用意できないときは移さない——止めておけたか
  分からないまま写すと、元の場所の起こし直しで起きる

## E2E で踏んだもの

- 入れ子の Project のコンテナでは logind に繋がらず、Service の Module が `loginctl enable-linger` で止まる。試験の中で
  Shell から `sudo -n systemctl start user@$(id -u).service` を流してから Service を使う（`e2e-env-pitfalls` と同じ）。
  この機械へ戻したあとはコンテナが起こし直されているので、もう一度要る
- **起き直した直後に別のサーバへ繋ぐと、在る SSH 鍵が「どの Vault にもありません」になった**（2026-10-11、runtime-move.spec の
  「写す途中で落とす」）。片づけは待ち受けを始めた直後に走る。Vault の窓口（vault-directory）は**繋がっている** Vault だけを
  探すので、vault-local が繋がる 12ms 前に聞いた問いが「無い」と答えた（読めなかった Vault としても数えられない——まだ
  一覧に居ない）。core が自分のために鍵を使う口（`cli.ts` の `sshIdentityThroughVault`）で、先に banto 全体の Vault を
  繋いでから窓口に聞くようにした。窓口の側の「まだ繋がっていない Vault を、無いと答える」は直していない（スコープの外。
  ほかの経路——AI が起き直した直後に alias を引く——でも同じことが起きうる。人に上げる）

## 確かめたこと（2026-10-11）

- `e2e/specs/runtime-move.spec.ts`：1並列で通過（単独 1.5 分。関係する spec とまとめた回でも通過——計2回）。最初の2回は
  落ちた：①「移した」の知らせを積んだあとに留めていた届いたものを数えたので、知らせだけでターンを起こしていた（直した）
  ②起き直した直後の片づけで Vault の窓口が鍵を見つけられなかった（上）
- 関係する spec（remote-runtime-host-side・-ssh・-registry・-sockets・project-close-release・turn-resume-restart・
  background-work）を1並列で：`remote-runtime-ssh.spec.ts:214` が1回落ちた（受信箱に「コマンドが終わりました：向こうで
  待たない」が先に入っていた）。単独では、この変更の前の core（283b78ec）でも、この変更の core でも通過。待たない形の
  コマンドが届けた知らせが、受信箱を見る前に来るかどうかの順番に依る（spec は linger と tmux の2件だけを待つ）——この変更とは
  関係しない。直していない（スコープ外。3回中1回。人に上げる）
- 単体：`npm test`（frontend・core・module-contract・factory・subagent・backlog）と Service の Module の試験が通過。core の
  `socket-dir.test` の2件は、このセッションの TMPDIR が長いと落ちる（`TMPDIR=/tmp` で通過。この変更で触っていない）

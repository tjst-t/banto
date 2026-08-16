---
id: imp-0075
kind: improvement
status: open
severity: low
created: 2026-08-16
refs: [task-0178, imp-0076]
---

# chromium のサンドボックスは「2つの壁」で止まっている——setuid 側は、まだ試せていない

## いつ効く起票か

**誰かが「共有ブラウザをサンドボックス有効で動かしたい」と思ったとき。**
2026-08-16 に一度試して駄目だったが、**駄目だった理由の半分は我々自身の設定**で、
**もう半分は検証できていない**。同じ時間を溶かさないために、分かったことを全部残す。

## 何が起きたか（2026-08-16・K2 の作業中）

共有ブラウザ（`task-0178`）で本物の chromium を起こそうとしたところ、起動直後に FATAL で落ちた。

PO の判断で、まず**サンドボックスを保つ**筋を試した——playwright 同梱の setuid ヘルパを
root 所有かつ setuid にし、`CHROME_DEVEL_SANDBOX` でそれを指す。PO が root で実行:

```
sudo chown root:root /home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome_sandbox
sudo chmod 4755 /home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome_sandbox
```

`-rwsr-xr-x root root` になったことを確認済み。**それでも chromium は落ちた。**

## 壁は2つある（ここが要点）

chromium が出した stderr:

```
The setuid sandbox is not running as root. Common causes:
  * An unprivileged process using ptrace on it, like a debugger.
  * A parent process set prctl(PR_SET_NO_NEW_PRIVS, ...)
Failed to move to new namespace: PID namespaces supported, Network namespace supported,
but failed: errno = Operation not permitted
[...] FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:207]
```

### 壁1：**我々自身のユニットの `NoNewPrivileges=true`**（setuid 側）

- `banto.service` も `banto-worker-pool.service` も **`NoNewPrivileges=yes`**
  （`/proc/self/status` の `NoNewPrivs` が `1` であることも確認）
- これは `prctl(PR_SET_NO_NEW_PRIVS)` を立て、**setuid バイナリを問答無用で無効化する**
- つまり **`chmod 4755` は正しい操作だったが、我々の側でそれを無効化していた**

**上のエラーは原因候補を自分で名指ししている**（`* A parent process set prctl(PR_SET_NO_NEW_PRIVS, ...)`）。
にもかかわらず、番頭は最初これを読み飛ばして「AppArmor が setuid も塞いでいる」と幹へ報告し、
あとで訂正した。**出ている情報を読まなかった**のが実際で、次に読む人は**まずこの行を見ること**。

### 壁2：**AppArmor の `apparmor_restrict_unprivileged_userns=1`**（namespace 側）

- setuid 経路が使えないので chromium は namespace サンドボックスへ落ち、
  そちらは `Operation not permitted` で拒まれた
- このホスト（Ubuntu / kernel 6.8）は AppArmor が非特権 user namespace を塞いでいる
  （`kernel.unprivileged_userns_clone` は `1` だが、AppArmor 側の制限が優先して効く）

## まだ分かっていないこと（これが再検証の中身）

**壁1が無い場所で、壁2だけを相手にしたら setuid は通るのか。** 試せていない。

- setuid サンドボックスは**root として** namespace を作るので、
  「非特権 user namespace の制限」には当たらない**可能性がある**
- しかし 2026-08-16 の実験は、**壁1のせいで壁2に到達する前に終わっていた**

**試すなら**：systemd のユニット外（NO_NEW_PRIVS の立っていない素のシェル）から、
`CHROME_DEVEL_SANDBOX` を指して chromium を `--no-sandbox` 無しで起動してみる。
`grep NoNewPrivs /proc/self/status` が `0` であることを**先に確かめてから**やること
（`1` のまま試すと、また同じ結論の出ない実験になる）。

## ただし、通っても話は終わらない

**setuid が通ると分かっても、banto 本体から使うには `banto.service` の
`NoNewPrivileges=true` を外すことになる。** それは**ハードニングを緩める判断**であり、
「サンドボックスを得るためにプロセスの権限昇格防止を捨てる」という取引になる。
どちらが安全かは自明ではない。**だから今日の流れでは決めず、別件にした**（幹の判断・2026-08-16）。

判断するときに揃っているべき材料:

- 壁2だけなら通るのか（上の再検証）
- `NoNewPrivileges=false` にしたとき、banto 本体が失うもの
- 共有ブラウザだけを別ユニット／別コンテナへ追い出す案との比較
  （8/15 の判定は「後から Environment Pool のプロファイルへ移せる形にする」と書いてある）

## いまどうなっているか

PO 承認のもと、**明示的に開けたときだけ** `--no-sandbox` が付く形で動かしている
（`BANTO_BROWSER_ALLOW_NO_SANDBOX=1`。既定では付かず、開けていなければ
「サンドボックスが使えない」と理由を言って起動を拒む）。開いていることは
`browser.status` と起動ログに出る。**黙って危ない側に倒れる作りにはなっていない。**

## 出所

- `task-0178`（共有ブラウザ K2）の作業ログ・2026-08-16
- chromium の stderr 全文（上記）
- `systemctl show banto.service -p NoNewPrivileges` / `systemctl cat banto-worker-pool.service`
- `docs/proposals/2026-08-15-shared-browser-module-assessment.md`（決めた内容と理由を追記済み）

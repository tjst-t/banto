# 開発用の Windows の VM に AI が繋ぐ形（案・2026-10-20）

デスクトップ版（`docs/specs/v4-desktop.md`）の段0の実測（§9）を AI が行うための、開発用の Windows の VM との繋ぎ方。
ユーザーが VM を用意する（2026-10-20）。ここは案で、ユーザーが決めたら「決まったこと」に書き換える。

## 繋ぎ方の全体

```
banto-dev-vm（この Project の Module が動く場所）
  └─ Shell の runCommand（sshIdentity に Vault の windows-dev-vm-ssh）
       └─ ssh banto@<VM> → Windows の OpenSSH Server → PowerShell
            ├─ 画面の要らない実測：そのまま PowerShell で流す。ファイルは scp
            └─ 画面の要る実測（窓・トレイ・通知）：ログオン中の画面で動く予約タスクを ssh から起こし、
               画面の写しを撮って scp で持ち帰る
```

- **ssh にする理由**：Windows に標準で入っていて（OpenSSH Server）、banto の Shell と Vault の鍵（`sshIdentity`）がそのまま使える。
  WinRM は banto に繋ぐ道具が無く、設定も多い
- **AI に渡すのは標準ユーザー `banto` だけ**（管理者でない）。会社の PC と同じ「管理者の権限なし」で実測するため。管理者の作業
  （OpenSSH を入れる・ユーザーを作る）は人が行う
- **既定のシェルは PowerShell**（Windows の OpenSSH の既定は cmd）
- **道具はインストールしないで置く**：node は zip 版、Git は Git for Windows の PortableGit を `banto` のホームに展開する
  （デスクトップ版の「インストールしない」と揃う。管理者の権限も要らない）

## 画面の要る実測

ssh のセッションはログオン中の画面（デスクトップ）とは別なので、そこで起こした Electron の窓・トレイ・通知は人の画面に出ない。

- **`banto` を自動でログオンさせ、画面のセッションを常に1つ持つ**（Sysinternals の Autologon。パスワードは LSA の秘密に入る）
- 画面で動かしたいものは、**「ログオンしているときだけ動く」予約タスク**（`New-ScheduledTaskPrincipal -LogonType Interactive`）に
  登録し、ssh から `Start-ScheduledTask` で起こす。そのプロセスはログオン中の画面で動く
- 確かめは (1) Playwright の Electron の口で窓の中身を読む、(2) PowerShell で画面の写し（PNG）を撮って scp で持ち帰る
- 画面が暗くなる・ロックされると写しが黒くなるので、スリープ・画面のロックは切る

## VM の条件

- Windows 11（Pro か Enterprise の評価版）、x64、**日本語版**（会社の PC と同じ。コンソールの文字コード（cp932）・日本語の
  パス・ユーザー名で踏むものを先に見る）
- banto-dev-vm から TCP 22 で届く
- Defender は有効のまま（§9 の5の実測のため）
- この VM に会社のデータ・個人の資格情報を置かない（AI が標準ユーザーで何でも読める）。Claude のログインは実測用に入れる
- **スナップショット「まっさら」**を取っておく（OpenSSH とユーザーだけの状態。§9 の1「Git for Windows が無くても通るか」を見るため）

## 人が VM で行う準備（管理者の PowerShell）

1. OpenSSH Server を入れて起こす・既定のシェルを PowerShell に

   ```powershell
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
   Set-Service -Name sshd -StartupType Automatic
   Start-Service sshd
   New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
     -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force
   Get-NetFirewallRule -Name *OpenSSH-Server*   # 受け入れの規則が有効か
   ```

2. 標準ユーザー `banto` を作り、一度ログオンしてプロファイルを作る

   ```powershell
   New-LocalUser -Name banto -Password (Read-Host -AsSecureString "パスワード") -PasswordNeverExpires
   Add-LocalGroupMember -Group Users -Member banto
   ```

3. AI の公開鍵（banto の Vault の `windows-dev-vm-ssh` の公開鍵。AI が渡す）を `banto` の `authorized_keys` に置く

   ```powershell
   $d = "C:\Users\banto\.ssh"
   New-Item -ItemType Directory -Force $d | Out-Null
   Set-Content -Path "$d\authorized_keys" -Value "<公開鍵の1行>" -Encoding ascii
   icacls "$d\authorized_keys" /inheritance:r /grant "banto:F" /grant "SYSTEM:F" /grant "Administrators:F"
   ```

   （管理者のユーザーは `C:\ProgramData\ssh\administrators_authorized_keys` を見るが、`banto` は標準ユーザーなのでホームのもの）

4. `banto` を自動でログオンさせ、スリープと画面のロックを切る

   ```powershell
   # Sysinternals の Autologon を取ってきて
   .\Autologon64.exe banto $env:COMPUTERNAME <パスワード> /accepteula
   powercfg /change standby-timeout-ac 0
   powercfg /change monitor-timeout-ac 0
   ```

   （設定 → アカウント → サインイン オプションの「離席時のサインイン要求」を「表示しない」に）

5. スナップショット「まっさら」を取り、VM のアドレスを AI に伝える

## AI が最初に確かめること

`ssh banto@<VM>` で：`whoami`（標準ユーザーか）・`$PSVersionTable`・`[Console]::OutputEncoding`・`Get-MpComputerStatus`（Defender）・
`Get-ScheduledTask` が使えるか・予約タスク越しに画面の写しが撮れるか。結果をこのノートに追記する。

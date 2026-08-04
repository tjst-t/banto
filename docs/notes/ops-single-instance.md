# Single Instance 移行手順（Runbook）

PO が実行する root 作業（0〜3）と、確認項目。

## 前提
- **Single Instance モデル**: `/opt/banto` (User=banto) を引退し、`ubuntu` ユーザーの ghq checkout を常に稼働させる。
- **データ保持**: `/var/lib/banto` は `ubuntu` が読み書きできるように chown 済み。
- **Caddy**: `:80` -> `127.0.0.1:4100` は変更なし。

## 移行ステップ（PO 実行）

### Step 0: `/var/lib/banto` の ownership 確認
```bash
sudo chown -R ubuntu:ubuntu /var/lib/banto
ls -ld /var/lib/banto
```

### Step 1: `deploy/banto.service` の内容確認
```bash
# ユーザーが ubuntu になっているか確認
cat /home/ubuntu/ghq/github.com/tjst-t/banto/deploy/banto.service
# User=ubuntu, WorkingDirectory=/home/ubuntu/ghq/github.com/tjst-t/banto
```

### Step 2: 古い `/opt/banto` の stop（任意だが推奨）
```bash
# 必要に応じて old banto を停止
# sudo systemctl stop banto@banto  # または旧ユニット名
```

### Step 3: 新ユニットの有効化・起動
```bash
# banto ユーザーで新ユニットを有効化（systemd に登録）
sudo systemctl enable /home/ubuntu/ghq/github.com/tjst-t/banto/deploy/banto.service
sudo systemctl start banto
```

## 確認事項
- `systemctl status banto`: active (running) か
- `curl http://localhost:4100/api/health`: 応答があるか
- `journalctl -u banto -f`: ログが正常か

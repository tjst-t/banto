#!/usr/bin/env bash
#
# banto v3 を動かす（ホスト＋観測）。
#
#   scripts/serve.sh start|stop|status
#
# ## なぜ script にしたか
#
# **起動の仕方が、動いているプロセスの環境変数にしか無かった**（2026-08-21 に踏んだ）。
# 落として上げ直そうとしたら `BANTO_FS_ROOT` が失われていて、
# **どこを作業範囲にしていたのかを推測するはめになった。**
# 既定値を持たない設計（`requiredRoot`）は正しいが、それは
# **どこかに書いてあること**とセットでないと運用できない。
#
# systemd の user unit は使えない（このホストには user bus が無い）。
# だから素のバックグラウンドで動かすが、**起動の仕方はここに1つだけ置く**（規則3）。
#
# ## 観測はホストの中で回さない（規則4）
#
# > 観測は、観測される機構の外側に置く。中に置くと、機構が止まったとき観測も止まる。
#
# だから別プロセスとして起こす。ホストが落ちても警報は上がり続ける。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${BANTO_V3_ENV:-$HOME/.banto-v3/env}"

# **設定は読むだけ。既定値を当てない**（規則2）——当てると、
# 意図しない場所を作業範囲にしたまま動いてしまう。
if [ ! -f "$CONFIG" ]; then
  cat >&2 <<EOF
設定が無い: $CONFIG

次の形で作る（合言葉はリポジトリに入れない）:

  BANTO_DATA_DIR=$HOME/.banto-v3/data
  BANTO_FS_ROOT=$HOME/.banto-v3/workspace
  BANTO_PORT=4100
  BANTO_SECRET=<長い合言葉>
  # 任意: BANTO_REPO_ROOT=<Factory を紐づけるリポジトリ>
  # 任意: BANTO_ENV_KIND=env-process|env-docker
  # 任意: BANTO_MODEL=<モデル id。省くと apps/host の既定（claude-haiku-4-5）>
EOF
  exit 1
fi

# shellcheck disable=SC1090
set -a; . "$CONFIG"; set +a

for required in BANTO_DATA_DIR BANTO_FS_ROOT BANTO_PORT BANTO_SECRET; do
  if [ -z "${!required:-}" ]; then
    echo "$CONFIG に $required が無い" >&2
    exit 1
  fi
done

RUN_DIR="$(dirname "$CONFIG")"
HOST_PID="$RUN_DIR/host.pid"
WATCH_PID="$RUN_DIR/watch.pid"

# **自分が起こしたものだけ止める。** 旧 banto や他のプロセスには触らない。
stop_one() {
  local file="$1" name="$2"
  [ -f "$file" ] || { echo "$name: 動いていない"; return; }
  local pid; pid="$(cat "$file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"; sleep 1
    echo "$name: 止めた（pid $pid）"
  else
    echo "$name: すでに居ない（pid $pid）"
  fi
  rm -f "$file"
}

case "${1:-status}" in
  start)
    stop_one "$HOST_PID" ホスト
    stop_one "$WATCH_PID" 観測

    # **起動ディレクトリを、呼び出し元がどこにいたかから切り離す**（規則8、実測 2026-08-22）。
    # Agent SDK は既定で cwd の CLAUDE.md／.claude/settings.json を自動で読む
    # （`settingSources` を渡さない限り）。このリポジトリの中から serve.sh を叩くと、
    # 人向けの会話に開発者向け CLAUDE.md が紛れ込んだ実例があった。
    # 本筋の遮断は Runner 側の `settingSources: []` だが、
    # ここでも cwd を毎回同じ場所に固定しておく（多重の守り）。
    cd "$HERE"

    BANTO_FS_ROOT="$BANTO_FS_ROOT" nohup node "$HERE/apps/host/dist/index.js" serve \
      --data "$BANTO_DATA_DIR" \
      --port "$BANTO_PORT" \
      --host "${BANTO_HOST:-127.0.0.1}" \
      --secret "$BANTO_SECRET" \
      --web "$HERE/apps/web/dist" \
      ${BANTO_REPO_ROOT:+--repo "$BANTO_REPO_ROOT"} \
      ${BANTO_ENV_KIND:+--env "$BANTO_ENV_KIND"} \
      ${BANTO_MODEL:+--model "$BANTO_MODEL"} \
      >> "$RUN_DIR/host.log" 2>&1 &
    echo $! > "$HOST_PID"

    # **ホストとは別のプロセス**（規則4）。ホストが落ちても警報は上がる。
    nohup node "$HERE/packages/observer/dist/cli.js" \
      --watch "$BANTO_DATA_DIR" --interval "${BANTO_WATCH_INTERVAL:-60}" \
      >> "$RUN_DIR/watch.log" 2>&1 &
    echo $! > "$WATCH_PID"

    sleep 2
    "$0" status
    ;;

  stop)
    stop_one "$HOST_PID" ホスト
    stop_one "$WATCH_PID" 観測
    ;;

  status)
    # **生きているかは pid ファイルではなく現物で見る**（規則3）。
    for pair in "$HOST_PID:ホスト" "$WATCH_PID:観測"; do
      file="${pair%%:*}"; name="${pair##*:}"
      if [ -f "$file" ] && kill -0 "$(cat "$file")" 2>/dev/null; then
        echo "$name: 動いている（pid $(cat "$file")）"
      else
        echo "$name: 動いていない"
      fi
    done
    echo "画面: http://${BANTO_HOST:-127.0.0.1}:$BANTO_PORT/?k=<合言葉>"
    ;;

  *)
    echo "usage: $0 start|stop|status" >&2
    exit 1
    ;;
esac

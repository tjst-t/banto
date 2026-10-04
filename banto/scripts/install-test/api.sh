#!/usr/bin/env bash
# 試験の場の中で、banto の host の API を機械の合言葉（config.json の authToken）で叩く（run.sh が中に送って使う）。
# usage: api.sh <GET|POST> <パス>   例：api.sh GET /api/admin/update
set -euo pipefail
cfg="$HOME/.config/banto/config.json"
token=$(node -e 'console.log(require(process.argv[1]).authToken)' "$cfg")
port=$(node -e 'console.log(require(process.argv[1]).port ?? 4737)' "$cfg")
curl -s -m 900 -X "$1" -H "authorization: Bearer $token" "http://127.0.0.1:$port$2"

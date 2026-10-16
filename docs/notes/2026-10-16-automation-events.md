# 自動化の段2——出来事をきっかけにする（2026-10-16、Fork「定期実行（Cron）の検討」）

仕様はアーキ §4.3「段2」と v4-frontend.md §6.42 の段2の項。ここは経緯。

- ユーザーの問い「Factory が30分以上かかると知らせが来るのと違う仕組み？」→ 違う。知らせは頼んだ会話への札（§4.2）、出来事は待つ自動化が拾う。両方出してよい
- ユーザーの要望「AI が依頼してくる判断待ちを AI に判断してほしい。まとめで判断を求めていたら判断用の会話に投げ、判断できれば元の会話に返す」
  → banto 自身の出来事 `banto.turn-decisions` と、前の回を引き継ぐ専用の Fork「判断役」と send_message で組める。対象はまとめの決めることだけ
  （tool・中継の承認は入れない）。歯止めはホップ 10（およそ5往復）
- 今の作りで確かめたこと：Module→host の中継には host 自身が受ける口（relayRaiseNotice・relayDeliverToThread、host-relay-endpoint.ts）があり、
  relayEmitEvent はその並びに足せる。Service は落ちたことを unit の起動役（log-wrapper.ts）が exit.json に書くが、Module は listServices の
  ときに読むだけで見張っていない——出口の箱へ書くのは起動役にする。Project の Module は使われないと止められる作りは見当たらなかった
  （道具用のコンテナの Module だけ使うとき起こす、startsOnDemand）

// **流し直すターンの AI の発言を、記録から外す**（追加・2026-10-05、アーキ仕様 §2.5「書き終えた発言ごとに記録する」）。
//
// host は AI の発言を書き終えるごとに記録へ足す（以前はターンの最後に1回）。走っているターンに乗る画面は、記録から
// 会話を組み直したうえで、そのターンを**最初から**流し直してもらう（`followRunningTurn`）——記録に入った分をそのまま
// 描くと、同じ発言が流し直しの吹き出しと記録の吹き出しの2つに出る。境界は host が `attached` で渡す、そのターンの
// 始まりの seq（`turn.started`）。
//
// そのターンの記録は、始まりより後ろに「人の発言・届いたもの」が先に並び、AI の発言（host がターンごとに1件に
// まとめている）がそのあとに1件。その1件だけを外す。乗ったあとに次のターンが始まっていたら（記録の `lastTurn` が
// 後ろにある）、それより後ろは次のターンのものなので触らない。

/** 外すかを決めるのに要る分だけ（`RealThread` の発言と最後のターン） */
interface RecordedMessage {
  seq: number;
  role: "user" | "assistant";
}

export function withoutReplayedReply<T extends { messages: RecordedMessage[]; lastTurn?: { startedSeq: number } }>(
  record: T,
  startedSeq: number | undefined,
): T {
  if (startedSeq === undefined) return record;
  const nextTurnFrom =
    record.lastTurn && record.lastTurn.startedSeq > startedSeq ? record.lastTurn.startedSeq : Number.POSITIVE_INFINITY;
  let i = record.messages.findIndex((m) => m.seq > startedSeq);
  if (i === -1) return record;
  while (i < record.messages.length && record.messages[i]!.role === "user") i += 1;
  const reply = record.messages[i];
  if (reply?.role !== "assistant" || reply.seq > nextTurnFrom) return record;
  return { ...record, messages: record.messages.filter((_, j) => j !== i) };
}

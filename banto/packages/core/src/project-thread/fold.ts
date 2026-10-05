import type { BackgroundWork } from "../delivery/reply-handles.js";
import type { StoredEvent } from "../event-store/log.js";
import type { Fold } from "../event-store/snapshot.js";
import type {
  MessageEntry,
  MessageImage,
  MessageOrigin,
  MessageSender,
  ProjectThreadReadModel,
  ProjectState,
  ThreadPermissionMode,
  ThreadEffort,
  ThreadState,
  TurnCause,
  TurnContinuation,
  TurnOutcome,
  TurnRecord,
} from "./types.js";
import type { SessionSkillSet } from "../skills/types.js";

export type ProjectThreadEvent =
  | { type: "project.created"; payload: { id: string; name: string; root: string } }
  | { type: "project.closed"; payload: { id: string } }
  // **人が付けた名前**（決定・2026-09-11、ユーザー要望）。Project は作るときに
  // 名前を付けるが、後から直せなかった
  | { type: "project.renamed"; payload: { id: string; name: string } }
  // **根を変える**（決定・2026-09-11、ユーザー要望）。根は閉じ込めの範囲その
  // ものなので、変えたら Module は立て直す（`releaseProjectModules`）
  | { type: "project.root_changed"; payload: { id: string; root: string } }
  // **人が決めた並び順**（決定・2026-09-11、ユーザー要望）。**順番そのものを1件で
  // 持つ**——各要素に番号を振ると、1つ動かすたびに全件を書き直すことになり、
  // 途中で失敗したときに番号が飛ぶ。ここに載っていないものは、載っているものの
  // 後ろに、作られた順で並ぶ（載せ忘れで消えない）
  | { type: "project.order.set"; payload: { ids: string[] } }
  | { type: "project.reopened"; payload: { id: string } }
  | {
      type: "thread.created";
      payload: {
        id: string;
        projectId: string;
        kind: "base" | "fork";
        parentThreadId?: string;
        resumePoint?: string;
        /** 親の会話の**どのメッセージの時点から**分けたか（決定・2026-09-11、
         *  ユーザー要望）。いまの続きから分けたときは持たない。 */
        forkedFromSeq?: number;
        /** **作るときに付けた名前**（追加・2026-09-28）。AI が立てる Fork は名前と一緒に作る——作ってから
         *  名前を付けると、その間に一覧を取った画面が名前の無い Fork を覚えてしまう（E2E で発覚） */
        title?: string;
        /** **会話を引き継がない Fork**（追加・2026-10-01、アーキ仕様 §4.2）。Project だけを宛先にしたメッセージで立つ。
         *  親の会話も resume-point も持たず、まっさらな会話で始まる（Base を Clear した状態） */
        fresh?: boolean;
      };
    }
  // **承認なしでメッセージを受け取ってよい Project の一覧**（追加・2026-10-01、アーキ仕様 §4.2）。一覧そのものを置き換える
  | { type: "project.message_senders_set"; payload: { id: string; senders: string[] } }
  | { type: "thread.closed"; payload: { id: string } }
  // Fork の名前（決定・2026-09-11、ユーザー要望）。**付けていないものは持たない**
  // ——既定の「Fork 1」は連番から導出できる（規則3）
  | { type: "thread.renamed"; payload: { id: string; title: string } }
  | { type: "thread.order.set"; payload: { projectId: string; ids: string[] } }
  | { type: "thread.reopened"; payload: { id: string } }
  // `anchor`：そのターンの最後のやり取り（追加・2026-10-01）。止めたターン・それより前の記録は持たない
  | { type: "thread.resume_point_updated"; payload: { id: string; resumePoint: string; anchor?: string } }
  // **人が止めて取り消した発言**（追加・2026-10-01、v4-frontend.md §6.31）。AI がまだ何も出していないうちに止めた
  // ——会話から外し、`rewindTo` があれば次のターンはそこまでで切って resume する
  | { type: "message.withdrawn"; payload: { threadId: string; seq: number; rewindTo?: string } }
  | { type: "thread.permission_mode_set"; payload: { id: string; mode: ThreadPermissionMode } }
  // 人が選んだモデルと effort（決定・2026-09-23）。null は「選んでいない」（SDK の既定）
  | { type: "thread.model_set"; payload: { id: string; model: string | null; effort: ThreadEffort | null } }
  // Memoryの持ち主はProject（決定・2026-09-05）。この決定より前に積まれた
  // イベントは`threadId`しか持たない——書き換えず、foldでThread→Projectを
  // 解決して読む（Event Storeは追記のみ、規則3）。
  | { type: "memory.appended"; payload: { projectId?: string; threadId?: string; text: string } }
  | { type: "memory.invalidated"; payload: { projectId?: string; threadId?: string; targetSeq: number } }
  | { type: "memory.delivered"; payload: { threadId: string; upToSeq: number } }
  | {
      type: "message.appended";
      payload: {
        threadId: string;
        role: "user" | "assistant";
        text: string;
        /** 画面つき tool の呼び出し（表示の復元用、決定・2026-09-07）。 */
        uiToolCalls?: unknown;
        /** 機械から届いたものの印（追加・2026-09-25）。無ければ人の発言 */
        origin?: MessageOrigin;
        /** 人が添えた画像の名前（追加・2026-09-26）。中身は画像の置き場 */
        images?: MessageImage[];
      };
    }
  // **Thread に届いたもの**（追加・2026-09-25、アーキ仕様 §4.2）。会話に積むのはターンを始めるとき
  // （`message.appended` の origin.deliveryId で消える）——まず残してから起こす（黙って捨てない）
  | {
      type: "delivery.received";
      payload: {
        threadId: string;
        deliveryId: string;
        from: string;
        title: string;
        text: string;
        hop: number;
        /** 別の Thread の AI が送ったものの送り元（追加・2026-10-01） */
        sender?: MessageSender;
        /** 起こし直しで切れたターンの続き（追加・2026-10-06） */
        continues?: TurnContinuation;
      };
    }
  | {
      type: "reply.awaiting";
      payload: { threadId: string; replyTo: string; connName: string; moduleName: string; hop: number; work?: BackgroundWork };
    }
  | { type: "reply.settled"; payload: { threadId: string; replyTo: string } }
  | { type: "thread.cleared"; payload: { threadId: string } }
  // **新しいセッションで効かせた Skill の集合**（決定・2026-09-23、§5.7）
  | { type: "thread.skills_fixed"; payload: { threadId: string; set: SessionSkillSet } }
  | {
      type: "ui-tool-call.display-mode.recorded";
      payload: { threadId: string; toolCallId: string; displayMode: "inline" | "fullscreen" };
    }
  | {
      type: "usage.recorded";
      payload: {
        threadId: string;
        contextUsage: unknown;
        compactionCount: number;
        apiUsage?: unknown;
      };
    }
  // **ターンの進み具合**（追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで続ける」）。起き直した host が
  // 切れたターンを見分けるのに使う。始めた時刻は出来事の ts
  | {
      type: "turn.started";
      payload: {
        threadId: string;
        turnId: string;
        cause: TurnCause;
        attempt: number;
        resumePoint?: string;
        rewindTo?: string;
        /** 新しい会話の最初のターン・Fork の最初のターンで、host が先に決めて Runner に渡した session id */
        sessionId?: string;
        /** 起こし直しで切れたターンの続きなら、続けたターンとその会話の始まり（`TurnContinuation`） */
        continues?: { turnId: string; fromSeq: number };
      };
    }
  // Runner の `system/init` で会話の id が分かった。**resume-point は変えない**——resume-point は今どおりターンの
  // 最後に書く（走っている途中に人が Fork を切ったら前の完了した状態から分かれ、Clear の防御も今のまま効く）
  | { type: "turn.session_known"; payload: { threadId: string; turnId: string; sessionId: string } }
  | { type: "turn.ended"; payload: { threadId: string; turnId: string; outcome: TurnOutcome } };

function cloneModel(m: ProjectThreadReadModel): ProjectThreadReadModel {
  return {
    displayModeByToolCall: new Map(m.displayModeByToolCall),
    // **前からある snapshot には、この2つが無い**（実測・2026-09-11、実機で踏んだ）
    // ——後から足した欄は、無い状態から読み戻される。空として扱う
    projectOrder: [...(m.projectOrder ?? [])],
    threadOrder: new Map(m.threadOrder ?? []),
    projects: new Map(Array.from(m.projects, ([k, v]) => [k, { ...v, memory: [...v.memory] }])),
    threads: new Map(
      Array.from(m.threads, ([k, v]) => [
        k,
        {
          ...v,
          messages: [...v.messages],
          markers: [...v.markers],
          usage: [...v.usage],
          skillSets: [...(v.skillSets ?? [])],
        },
      ]),
    ),
  };
}

/** Memoryイベントの宛先Project。新しいイベントは`projectId`を持ち、
 *  この決定（2026-09-05）より前のものは`threadId`しか持たない——後者は
 *  Threadから解決する（既存イベントを書き換えないための読み替え）。 */
function resolveMemoryProjectId(
  model: ProjectThreadReadModel,
  payload: { projectId?: string; threadId?: string },
): string | undefined {
  if (payload.projectId) return payload.projectId;
  if (!payload.threadId) return undefined;
  return model.threads.get(payload.threadId)?.projectId;
}


/**
 * **Fork が親から引き継いだ会話を、スナップショットでは1つにまとめる**（追加・2026-10-04、実機で発覚）。
 *
 * Fork を立てると、親の会話（messages）を Fork の記録に写す。メモリでは同じオブジェクトを指すので安いが、
 * JSON にすると Fork の数だけ丸ごと写しができ、読み戻すと**本当に別々のオブジェクト**になる。実機では
 * イベントの記録が 23MB なのにスナップショットが 121MB になり、起動直後から host が 1.2GiB 使っていた。
 *
 * そこで書き出すときは、メッセージを seq（その message.appended の seq。全体で一意）ごとに1つの表に置き、
 * Thread には seq だけを書く。中身が表のものと違うもの（Fork だけが書き換えた等）はそのまま書く。
 * 読むときは同じ seq を同じオブジェクトに戻す——前の形（全部そのまま）のスナップショットも、中身が同じなら
 * まとめて読む（次に書き出すときに小さくなる）
 */
type PackedMessage = number | MessageEntry;
interface PackedModel {
  packedMessages: [number, MessageEntry][];
  [key: string]: unknown;
}

function packModel(m: ProjectThreadReadModel): unknown {
  const pool = new Map<number, MessageEntry>();
  const poolJson = new Map<number, string>();
  const same = (seq: number, msg: MessageEntry): boolean => {
    const canonical = pool.get(seq);
    if (canonical === undefined) {
      pool.set(seq, msg);
      return true;
    }
    if (canonical === msg) return true;
    let a = poolJson.get(seq);
    if (a === undefined) {
      a = JSON.stringify(canonical);
      poolJson.set(seq, a);
    }
    return a === JSON.stringify(msg);
  };
  const threads = new Map<string, unknown>();
  for (const [id, t] of m.threads) {
    const messages: PackedMessage[] = t.messages.map((msg) => (same(msg.seq, msg) ? msg.seq : msg));
    threads.set(id, { ...t, messages });
  }
  return { ...m, threads, packedMessages: [...pool] } satisfies PackedModel;
}

function unpackModel(raw: unknown): ProjectThreadReadModel {
  const r = raw as PackedModel & { threads: Map<string, ThreadState & { messages: PackedMessage[] }> };
  const pool = new Map<number, MessageEntry>(r.packedMessages ?? []);
  const poolJson = new Map<number, string>();
  const intern = (msg: MessageEntry): MessageEntry => {
    const canonical = pool.get(msg.seq);
    if (canonical === undefined) {
      pool.set(msg.seq, msg);
      return msg;
    }
    let a = poolJson.get(msg.seq);
    if (a === undefined) {
      a = JSON.stringify(canonical);
      poolJson.set(msg.seq, a);
    }
    return a === JSON.stringify(msg) ? canonical : msg;
  };
  const threads = new Map<string, ThreadState>();
  for (const [id, t] of r.threads) {
    const messages = t.messages.map((p) => {
      if (typeof p !== "number") return intern(p);
      const msg = pool.get(p);
      if (!msg) throw new Error(`スナップショットが壊れています：Thread ${id} のメッセージ ${p} が表にありません`);
      return msg;
    });
    // 前の形は全ターンの使用量を持っている——最新の1件だけにする（usage.recorded の fold と同じ）
    threads.set(id, { ...t, messages, usage: (t.usage ?? []).slice(-1) });
  }
  const { packedMessages: _drop, ...rest } = r;
  return { ...(rest as unknown as ProjectThreadReadModel), threads };
}

export const projectThreadFold: Fold<ProjectThreadReadModel> = {
  pack: packModel,
  unpack: unpackModel,
  initial: () => ({
    projects: new Map(),
    threads: new Map(),
    displayModeByToolCall: new Map(),
    projectOrder: [],
    threadOrder: new Map(),
  }),

  apply(state, raw: StoredEvent): ProjectThreadReadModel {
    const event = raw as unknown as ProjectThreadEvent & { ts: string };
    const next = cloneModel(state);

    switch (event.type) {
      case "project.created": {
        const p: ProjectState = {
          id: event.payload.id,
          name: event.payload.name,
          root: event.payload.root,
          status: "active",
          memory: [],
          createdAt: raw.ts,
        };
        next.projects.set(p.id, p);
        return next;
      }
      case "project.closed": {
        const p = next.projects.get(event.payload.id);
        if (p) next.projects.set(p.id, { ...p, status: "closed" });
        // 走っていたターンは、起き直しても続けない（人が Project ごと閉じた）
        for (const t of next.threads.values()) {
          if (t.projectId === event.payload.id) abandonLastTurn(t, "project_closed");
        }
        return next;
      }
      case "project.message_senders_set": {
        const p = next.projects.get(event.payload.id);
        if (p) next.projects.set(p.id, { ...p, acceptMessagesFrom: [...event.payload.senders] });
        return next;
      }
      case "project.renamed": {
        const p = next.projects.get(event.payload.id);
        if (p) next.projects.set(p.id, { ...p, name: event.payload.name });
        return next;
      }
      case "project.root_changed": {
        const p = next.projects.get(event.payload.id);
        if (p) next.projects.set(p.id, { ...p, root: event.payload.root });
        return next;
      }
      case "project.order.set": {
        next.projectOrder = [...event.payload.ids];
        return next;
      }
      case "thread.renamed": {
        const t = next.threads.get(event.payload.id);
        if (t) next.threads.set(t.id, { ...t, title: event.payload.title });
        return next;
      }
      case "thread.order.set": {
        next.threadOrder = new Map(next.threadOrder);
        next.threadOrder.set(event.payload.projectId, [...event.payload.ids]);
        return next;
      }
      case "project.reopened": {
        const p = next.projects.get(event.payload.id);
        if (p) next.projects.set(p.id, { ...p, status: "active" });
        return next;
      }
      case "thread.created": {
        const t: ThreadState = {
          id: event.payload.id,
          projectId: event.payload.projectId,
          kind: event.payload.kind,
          parentThreadId: event.payload.parentThreadId,
          forkedFromSeq: event.payload.forkedFromSeq,
          ...(event.payload.title ? { title: event.payload.title } : {}),
          createdSeq: raw.seq,
          resumePoint: event.payload.resumePoint,
          resumePoints: [],
          // 作られた時点のresume-pointは「親から借りたもの」——自分のセッション
          // ではない（決定・2026-09-05）。最初のターンでforkSessionにより
          // 枝を分け、自分のsession idを受け取った時点でtrueになる。
          ownsSession: false,
          status: "active",
          // system promptに入るMemoryはここで確定する（決定・2026-09-05）。
          // 物差しはEvent Storeのseqそのもの——Project MemoryもGlobal Memoryも
          // 同じ1本の時間軸に並ぶので、種類ごとに別の境界を持たなくてよい。
          // Fork Threadが「分岐時点のMemoryを固定的に持つ」（§2.2 item6）のも
          // 同じ1つの値で表せる——親のmemoryをコピーする必要は無い（規則3）。
          memoryBaselineSeq: raw.seq,
          memoryDeliveredSeq: 0,
          abandonedSessions: [],
          messages: [],
          markers: [],
          usage: [],
          createdAt: raw.ts,
        };
        // 会話の表示（messages/markers/usage）は分岐時点の親の内容を引き継ぐ
        // ——Fork Threadは親の会話の続きとして画面に出る（決定・2026-09-04）。
        // **過去のメッセージから分けたときは、そこまで**（改訂・2026-09-11）
        // ——分けた後の親のやり取りが Fork の会話に混ざらない。
        if (t.kind === "fork" && t.parentThreadId) {
          const parent = next.threads.get(t.parentThreadId);
          if (parent && event.payload.fresh) {
            // **会話を引き継がない Fork**（§4.2）——表示も Skill も写さない。走らせ方の設定だけは親にそろえる
            // （承認ゲートを効かせている Project で、立った Fork だけ既定に戻らないように）
            if (parent.permissionMode) t.permissionMode = parent.permissionMode;
            if (parent.model) t.model = parent.model;
            if (parent.effort) t.effort = parent.effort;
          } else if (parent) {
            const upTo = event.payload.forkedFromSeq ?? Number.MAX_SAFE_INTEGER;
            t.messages = parent.messages.filter((m) => m.seq <= upTo);
            t.markers = parent.markers.filter((m) => m.seq <= upTo);
            t.usage = parent.usage.filter((u) => u.seq <= upTo).slice(-1);
            // **効かせた Skill も分けた時点のものを引き継ぐ**（決定・2026-09-23）。
            // Fork は親のセッションを `resume` して枝を分けるので、`instructions` は
            // 読み直されない（実測）——親がその時点で効かせていたものが、そのまま効く
            t.skillSets = (parent.skillSets ?? []).filter((s) => s.seq <= upTo);
            // 人が選んだ permissionMode も引き継ぐ（決定・2026-09-06）——
            // 引き継がないと、承認ゲートを効かせていたつもりの人が
            // fork した瞬間に既定（auto）へ戻る（規則2）
            if (parent.permissionMode) t.permissionMode = parent.permissionMode;
            // モデルと effort も引き継ぐ（決定・2026-09-23）——Fork は親の続きなので、
            // 黙って既定のモデルへ戻すと、その Fork の最初のターンでキャッシュが効かない
            if (parent.model) t.model = parent.model;
            if (parent.effort) t.effort = parent.effort;
          }
        }
        next.threads.set(t.id, t);
        return next;
      }
      case "thread.permission_mode_set": {
        const t = next.threads.get(event.payload.id);
        if (t) next.threads.set(t.id, { ...t, permissionMode: event.payload.mode });
        return next;
      }
      case "thread.model_set": {
        const t = next.threads.get(event.payload.id);
        if (t) {
          const { model: _m, effort: _e, ...rest } = t;
          next.threads.set(t.id, {
            ...rest,
            ...(event.payload.model ? { model: event.payload.model } : {}),
            ...(event.payload.effort ? { effort: event.payload.effort } : {}),
          });
        }
        return next;
      }
      case "thread.closed": {
        const t = next.threads.get(event.payload.id);
        if (t) {
          abandonLastTurn(t, "thread_closed");
          next.threads.set(t.id, { ...t, status: "closed" });
        }
        return next;
      }
      case "thread.reopened": {
        const t = next.threads.get(event.payload.id);
        if (t) next.threads.set(t.id, { ...t, status: "active" });
        return next;
      }
      case "thread.resume_point_updated": {
        const t = next.threads.get(event.payload.id);
        if (!t) return next;
        // **このターンの会話が、どこから載っているか**（追加・2026-10-05）。AI の発言は書き終えるごとに記録するので、
        // 返事は resume-point の更新より前の seq を持つ——更新の seq で履歴に積むと、返事から Fork を分けたとき
        // （`resumePointAsOf`）そのターンの会話が見つからない。ターンの始まりの seq で積む。ターンの外の更新
        // （この仕組みより前の記録・試験）は更新の seq のまま
        // 起こし直しで切れたターンの続きなら、切れたターンの会話の始まりから（追加・2026-10-06）——切れた吹き出しから
        // 分けても、続きのターンが続けた会話が見つかる
        const turnFrom =
          t.lastTurn && !t.lastTurn.resumePointUpdated ? (t.lastTurn.continuesFromSeq ?? t.lastTurn.startedSeq) : raw.seq;
        // **最後まで行ったかは resume-point の更新で見る**（アーキ仕様 §2.5）——ターンの終わりは返事 → resume-point →
        // 使用量 → Fork → `turn.ended` と別々に書かれる。resume-point を書いたあとに落ちたターンは、CLI の
        // 側では終わっているので「切れた」にしない
        if (t.lastTurn && !t.lastTurn.resumePointUpdated) t.lastTurn = { ...t.lastTurn, resumePointUpdated: true };
        // **どの時点でどのセッションだったか**を残す（決定・2026-09-11、
        // ユーザー要望）。過去のメッセージから分けるには、その時点の
        // resume-point が要る——Clear で手放したものも含めて（Clear の前の
        // やり取りから分けたい、というのが要望そのもの）。
        // 同じものが続くときは積まない（ターンごとに1件で足りる）
        const history = t.resumePoints ?? [];
        if (history[history.length - 1]?.sessionId !== event.payload.resumePoint) {
          // seq の順に並べておく（`resumePointAsOf` は順に読む）——続きのターンの始まりは前のものより手前になりうる
          t.resumePoints = [...history, { seq: turnFrom, sessionId: event.payload.resumePoint }].sort((a, b) => a.seq - b.seq);
        }
        // **Clear で切り離したセッションは、後から来ても入れない**（決定・2026-09-06）。
        // 走行中に Clear すると、そのターンは終了時に開始時のsession idで
        // ここへ来て、Clear を取り消してしまっていた（見直し・2026-09-06）。
        if (t.abandonedSessions.includes(event.payload.resumePoint)) {
          next.threads.set(t.id, { ...t });
          return next;
        }
        // Runnerが返したsession idを受け取った＝この Thread 自身のセッション。
        // 切って resume する必要は、新しい resume-point で消える（そのターンが切って走った）
        const { resumeAnchor: _a, rewindTo: _r, ...rest } = t;
        next.threads.set(t.id, {
          ...rest,
          resumePoint: event.payload.resumePoint,
          ownsSession: true,
          ...(event.payload.anchor ? { resumeAnchor: event.payload.anchor } : {}),
        });
        return next;
      }
      case "message.withdrawn": {
        const t = next.threads.get(event.payload.threadId);
        if (!t) return next;
        t.messages = t.messages.filter((m) => m.seq !== event.payload.seq);
        if (event.payload.rewindTo) t.rewindTo = event.payload.rewindTo;
        return next;
      }
      case "memory.appended": {
        const projectId = resolveMemoryProjectId(next, event.payload);
        const p = projectId ? next.projects.get(projectId) : undefined;
        if (p) {
          p.memory.push({
            seq: raw.seq,
            text: event.payload.text,
            originThreadId: event.payload.threadId,
          });
        }
        return next;
      }
      case "memory.invalidated": {
        const projectId = resolveMemoryProjectId(next, event.payload);
        const p = projectId ? next.projects.get(projectId) : undefined;
        if (p) {
          // エントリ自体は前のスナップショットと共有されている——書き換えず
          // 差し替える（foldの結果は不変であるべき、規則3）。
          // 無効化の「時点」を残す——確定時点との前後で扱いが変わる（types.ts）。
          p.memory = p.memory.map((m) =>
            m.seq === event.payload.targetSeq && m.invalidatedAtSeq === undefined
              ? { ...m, invalidatedAtSeq: raw.seq }
              : m,
          );
        }
        return next;
      }
      case "memory.delivered": {
        const t = next.threads.get(event.payload.threadId);
        // 巻き戻さない——届けた事実は消えない（Event Storeは追記のみ）。
        if (t) t.memoryDeliveredSeq = Math.max(t.memoryDeliveredSeq, event.payload.upToSeq);
        return next;
      }
      case "message.appended": {
        const t = next.threads.get(event.payload.threadId);
        if (t) {
          // 先に届いていた「どの面に出したか」をここで貼る（上の説明）
          const uiToolCalls = Array.isArray(event.payload.uiToolCalls)
            ? (event.payload.uiToolCalls as NonNullable<MessageEntry["uiToolCalls"]>).map((c) => {
                const known = next.displayModeByToolCall.get(c.toolCallId);
                return known ? { ...c, displayMode: c.displayMode ?? known } : c;
              })
            : undefined;
          const last = t.messages[t.messages.length - 1];
          if (
            event.payload.role === "assistant" &&
            last?.role === "assistant" &&
            t.lastTurn !== undefined &&
            last.seq > t.lastTurn.startedSeq
          ) {
            // **1ターンの AI の発言は1つにまとめる**（追加・2026-10-05、アーキ仕様 §2.5「書き終えた発言ごとに記録する」）。
            // 記録（Event Store）には書き終えた発言ごとに1件ずつ書くが、会話の1件（＝画面の吹き出し1つ）はターンごと
            // ——ターンの最後にまとめて書いていたときと同じ形にする。文は段落を分けてつなぐ（`extractAssistantText`
            // と同じ）。seq は最初の発言のもの。Fork に写したものと同じオブジェクトなので、書き換えずに差し替える
            const calls = [...(last.uiToolCalls ?? []), ...(uiToolCalls ?? [])];
            t.messages[t.messages.length - 1] = {
              ...last,
              text: [last.text, event.payload.text].filter((s) => s !== "").join("\n\n"),
              uiToolCalls: calls.length > 0 ? calls : undefined,
            };
            return next;
          }
          t.messages.push({
            seq: raw.seq,
            role: event.payload.role,
            text: event.payload.text,
            ...(event.payload.origin ? { origin: event.payload.origin } : {}),
            ...(event.payload.images && event.payload.images.length > 0 ? { images: event.payload.images } : {}),
            uiToolCalls,
          });
          // 積んだものは、届いたものの待ち行列から外す
          const delivered = event.payload.origin?.deliveryId;
          if (delivered && t.deliveries) t.deliveries = t.deliveries.filter((d) => d.deliveryId !== delivered);
        }
        return next;
      }
      case "delivery.received": {
        const t = next.threads.get(event.payload.threadId);
        if (t) {
          const { threadId: _thread, ...rest } = event.payload;
          const received = { ...rest, receivedAt: raw.ts };
          // **切れたターンの続きは、ほかの届いたものより先に積む**（アーキ仕様 §2.5）——AI はまず切れたことを知る
          t.deliveries = rest.continues
            ? [received, ...(t.deliveries ?? [])]
            : [...(t.deliveries ?? []), received];
          // 送り元への返事を承認なしで通すための記録（§4.2）。届くたびに数え直す
          if (rest.sender) t.receivedFrom = { ...(t.receivedFrom ?? {}), [rest.sender.threadId]: raw.ts };
        }
        return next;
      }
      case "reply.awaiting": {
        const t = next.threads.get(event.payload.threadId);
        if (t) {
          const { threadId: _thread, ...rest } = event.payload;
          t.awaitingReplies = [...(t.awaitingReplies ?? []).filter((r) => r.replyTo !== rest.replyTo), { ...rest, since: raw.ts }];
        }
        return next;
      }
      case "reply.settled": {
        const t = next.threads.get(event.payload.threadId);
        if (t?.awaitingReplies) t.awaitingReplies = t.awaitingReplies.filter((r) => r.replyTo !== event.payload.replyTo);
        return next;
      }
      // **どの面に出したか**を、その tool 呼び出しの記録に書き足す
      // （決定・2026-09-07）。決めるのは画面側なので、決まってから届く
      case "ui-tool-call.display-mode.recorded": {
        // 会話がまだ書かれていないこともあるので、まず預かる
        next.displayModeByToolCall.set(event.payload.toolCallId, event.payload.displayMode);
        const t = next.threads.get(event.payload.threadId);
        if (t) {
          t.messages = t.messages.map((m) => {
            if (!m.uiToolCalls?.some((c) => c.toolCallId === event.payload.toolCallId)) return m;
            return {
              ...m,
              uiToolCalls: m.uiToolCalls.map((c) =>
                c.toolCallId === event.payload.toolCallId
                  ? { ...c, displayMode: event.payload.displayMode }
                  : c,
              ),
            };
          });
        }
        return next;
      }
      case "usage.recorded": {
        const t = next.threads.get(event.payload.threadId);
        if (t) {
          // **最新の1件だけ持つ**（改訂・2026-10-04、実機で発覚）。読むのは最新だけ（app.ts）で、1件が SDK の
          // getContextUsage の中身そのまま（数十 KB）なので、全ターン分を Fork の数だけ持つと写しが 113MB になった。
          // 履歴は Event Store の usage.recorded に残っている
          t.usage = [{
            seq: raw.seq,
            contextUsage: event.payload.contextUsage,
            compactionCount: event.payload.compactionCount,
            apiUsage: event.payload.apiUsage,
          }];
        }
        return next;
      }
      case "thread.skills_fixed": {
        const t = next.threads.get(event.payload.threadId);
        if (t) t.skillSets = [...(t.skillSets ?? []), { seq: raw.seq, set: event.payload.set }];
        return next;
      }
      case "thread.cleared": {
        const t = next.threads.get(event.payload.threadId);
        if (t) {
          t.markers.push({ seq: raw.seq, kind: "clear" });
          // 「畳む」＝次のRunner呼び出しでresume-pointを渡さない
          // （v4-architecture.md §2.2）。新規query()として再開する。
          // 走行中のターンが終了時に同じsession idで戻ってきても復活させない
          if (t.resumePoint) t.abandonedSessions = [...t.abandonedSessions, t.resumePoint];
          // **走っているターンの会話も切り離す**（追加・2026-10-05、Fable のレビュー）。新しい会話の最初のターン・
          // Fork の最初のターンは、まだ resume-point に自分の会話を持っていない——上だけでは、終わりに来た
          // resume-point の更新が Clear を取り消していた（前からある穴）
          // 起こし直しで切れたターンの続きは、Thread の resume-point に無い会話（切れたターンが書いた会話）を続けている
          // ——始めたときの resume-point も捨てる（追加・2026-10-06。`system/init` の前に Clear すると、まだ knownSessionId
          // が無い）
          for (const id of [t.lastTurn?.assignedSessionId, t.lastTurn?.knownSessionId, t.lastTurn?.resumePoint]) {
            if (id !== undefined && !t.abandonedSessions.includes(id)) t.abandonedSessions = [...t.abandonedSessions, id];
          }
          // 走っていたターンは、起き直しても続けない（人が会話を畳んだ）
          abandonLastTurn(t, "cleared");
          t.resumePoint = undefined;
          t.resumeAnchor = undefined;
          t.rewindTo = undefined;
          t.ownsSession = false;
          // 畳んだ時点で、system promptに入るMemoryを確定し直す
          // （決定・2026-09-05）——次のターンは新しいキャッシュ境界から始まる。
          t.memoryBaselineSeq = raw.seq;
        }
        return next;
      }
      case "turn.started": {
        const t = next.threads.get(event.payload.threadId);
        if (t) {
          const p = event.payload;
          t.lastTurn = {
            turnId: p.turnId,
            startedSeq: raw.seq,
            startedAt: raw.ts,
            cause: p.cause,
            attempt: p.attempt,
            ...(p.resumePoint !== undefined ? { resumePoint: p.resumePoint } : {}),
            ...(p.rewindTo !== undefined ? { rewindTo: p.rewindTo } : {}),
            ...(p.sessionId !== undefined ? { assignedSessionId: p.sessionId } : {}),
            ...(p.continues ? { continuesTurnId: p.continues.turnId } : {}),
            // 切れたターンより後に Clear があれば、その会話の始まりは引き継がない（Clear より前から分けて、Clear の
            // あとの会話にならないように）
            ...(p.continues && !t.markers.some((m) => m.kind === "clear" && m.seq > p.continues!.fromSeq)
              ? { continuesFromSeq: p.continues.fromSeq }
              : {}),
          };
        }
        return next;
      }
      case "turn.session_known": {
        const t = next.threads.get(event.payload.threadId);
        // resume-point には触らない（上の型の説明）
        if (t?.lastTurn?.turnId === event.payload.turnId) {
          t.lastTurn = { ...t.lastTurn, knownSessionId: event.payload.sessionId };
        }
        return next;
      }
      case "turn.ended": {
        const t = next.threads.get(event.payload.threadId);
        if (t?.lastTurn?.turnId === event.payload.turnId) {
          t.lastTurn = { ...t.lastTurn, outcome: event.payload.outcome };
        }
        return next;
      }
      default:
        return state;
    }
  },
};

/** 最後のターンに「始めたより後に人がやめた」を書く（最初の1つだけ）。`t` は fold が作り直したもの */
function abandonLastTurn(t: ThreadState, by: NonNullable<TurnRecord["abandonedBy"]>): void {
  if (t.lastTurn && !t.lastTurn.abandonedBy) t.lastTurn = { ...t.lastTurn, abandonedBy: by };
}

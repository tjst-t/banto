"use client";

// **書きかけのメッセージは、Thread ごとにブラウザに残す**（決定・2026-09-28、ユーザー要望
// 「別のページへ行く・設定を開いて閉じる・Fork の画面を閉じる、でも全部残してほしい」）。
//
// 入力欄の中身は assistant-ui のランタイムが持つ。ランタイムは面が作り直されるたびに新しく
// なる（ページを移る・Fork と Canvas を両方開く・記録から組み直す）ので、そこにだけ置くと
// そのたびに消える。**打つたびにここへ写し、ランタイムが作られたら戻す**。
//
// 置き場は localStorage——読み込み直しても、タブを閉じて開き直しても残る。送ったら入力欄は
// 空になるので、そのとき一緒に消える。
//
// **添えた画像も残す**（決定・2026-10-08、ユーザー要望「別ページに遷移しても添付ファイルが残らない」）。
// 画像は1枚 10MB まであり localStorage には入らないので、IndexedDB に File（Blob）のまま置く。
// 戻すときは入力欄に添えるのと同じ道（`addAttachment(File)`）を通す。

import type { ThreadComposerRuntime } from "@assistant-ui/react";

const KEY_PREFIX = "banto.composerDraft.";

function read(threadId: string): string {
  try {
    return window.localStorage.getItem(KEY_PREFIX + threadId) ?? "";
  } catch (err) {
    // 読めない（保存が禁じられたブラウザ等）——書きかけが戻らないだけで、会話は使える。黙りはしない
    console.warn("[banto] 書きかけを読めませんでした:", err);
    return "";
  }
}

function write(threadId: string, text: string): void {
  try {
    if (text === "") window.localStorage.removeItem(KEY_PREFIX + threadId);
    else window.localStorage.setItem(KEY_PREFIX + threadId, text);
  } catch (err) {
    console.warn("[banto] 書きかけを残せませんでした:", err);
  }
}

// ── 添えた画像（IndexedDB） ──────────────────────────────────────────────

const DB_NAME = "banto-composer-drafts";
const STORE = "attachments";

type SavedFile = { name: string; type: string; blob: Blob };

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // 開けなかったら次の呼び出しで開き直す（一度の失敗を覚え込まない）
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

async function readFiles(threadId: string): Promise<File[]> {
  const db = await openDb();
  const saved = await new Promise<SavedFile[] | undefined>((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(threadId);
    req.onsuccess = () => resolve(req.result as SavedFile[] | undefined);
    req.onerror = () => reject(req.error);
  });
  return (saved ?? []).map((f) => new File([f.blob], f.name, { type: f.type }));
}

async function writeFiles(threadId: string, files: readonly File[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    if (files.length === 0) store.delete(threadId);
    else store.put(files.map((f): SavedFile => ({ name: f.name, type: f.type, blob: f })), threadId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// 書き込みは Thread ごとに順に流す（後から書いた中身が先に書いた中身に負けないように）
const writeChains = new Map<string, Promise<void>>();
function queueWriteFiles(threadId: string, files: readonly File[]): void {
  const prev = writeChains.get(threadId) ?? Promise.resolve();
  const next = prev
    .then(() => writeFiles(threadId, files))
    .catch((err: unknown) => console.warn("[banto] 書きかけの画像を残せませんでした:", err));
  writeChains.set(threadId, next);
  void next.then(() => {
    if (writeChains.get(threadId) === next) writeChains.delete(threadId);
  });
}

type ComposerAttachment = { id: string; file?: File };

function attachmentFiles(attachments: readonly ComposerAttachment[]): File[] {
  return attachments.flatMap((a) => (a.file ? [a.file] : []));
}

function attachmentKey(attachments: readonly ComposerAttachment[]): string {
  return attachments.map((a) => a.id).join("\n");
}

/**
 * その Thread の入力欄に書きかけを戻し、以後の変化を残し続ける。返り値で止める。
 * 入力欄にすでに何かある（作り直す前から打っていた）ときは、そちらを優先する
 */
export function keepComposerDraft(threadId: string, composer: ThreadComposerRuntime): () => void {
  const saved = read(threadId);
  if (saved !== "" && composer.getState().text === "") composer.setText(saved);
  let last = composer.getState().text;

  // 画像：入力欄にまだ何も添えていなければ、残しておいたものを戻す。戻し終わるまでは書かない
  // （戻している途中の半端な並びで、残しておいた全体を上書きしないため）
  let disposed = false;
  let restoring = composer.getState().attachments.length === 0;
  let lastAttachments = attachmentKey(composer.getState().attachments);
  const saveAttachments = () => {
    const attachments = composer.getState().attachments;
    const key = attachmentKey(attachments);
    if (key === lastAttachments) return;
    lastAttachments = key;
    queueWriteFiles(threadId, attachmentFiles(attachments));
  };
  if (restoring) {
    void (async () => {
      try {
        // 先に流した書き込み（前の面が閉じる間際のもの）が済んでから読む
        await (writeChains.get(threadId) ?? Promise.resolve());
        const files = await readFiles(threadId);
        for (const file of files) {
          if (disposed) return;
          // 1枚戻せなくても残りは戻す。理由は入力欄に「添えられなかった」として出る
          await composer.addAttachment(file).catch((err: unknown) => {
            console.warn("[banto] 書きかけの画像を入力欄へ戻せませんでした:", err);
          });
        }
      } catch (err) {
        console.warn("[banto] 書きかけの画像を読めませんでした:", err);
      } finally {
        restoring = false;
        // 戻している間に人が足した・外したものも含めて、いまの並びを残す
        if (!disposed) {
          lastAttachments = "";
          saveAttachments();
        }
      }
    })();
  }

  const unsubscribe = composer.subscribe(() => {
    const text = composer.getState().text;
    if (text !== last) {
      last = text;
      write(threadId, text);
    }
    if (!restoring) saveAttachments();
  });
  return () => {
    disposed = true;
    unsubscribe();
  };
}

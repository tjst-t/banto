"use client";

import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useShallow } from "zustand/react/shallow";
import { REAL_IMAGE_SRC_PREFIX, fetchRealImageUrl } from "@/lib/backend/client";

const useFileSrc = (file: File | undefined) => {
  const [entry, setEntry] = useState<{ file: File; url: string } | undefined>(
    undefined,
  );

  useEffect(() => {
    if (!file) {
      setEntry(undefined);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setEntry({ file, url: objectUrl });

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return entry !== undefined && entry.file === file ? entry.url : undefined;
};

/**
 * **記録から戻した画像は host から取ってくる**（banto、決定・2026-09-26）。
 * `banto-image:<id>` を合言葉つきで取り、手元の URL にする（`fetchRealImageUrl`）。
 * 取れなければ代わりの絵（ファイルの印）のまま——理由はコンソールに残す
 */
const useRealImageSrc = (src: string | undefined) => {
  const id = src?.startsWith(REAL_IMAGE_SRC_PREFIX)
    ? src.slice(REAL_IMAGE_SRC_PREFIX.length)
    : undefined;
  const [entry, setEntry] = useState<{ id: string; url: string } | undefined>(
    undefined,
  );

  useEffect(() => {
    if (!id) return;
    let alive = true;
    fetchRealImageUrl(id).then(
      (url) => {
        if (alive) setEntry({ id, url });
      },
      (err: unknown) => console.warn(`[banto] 画像 ${id} を出せません:`, err),
    );
    return () => {
      alive = false;
    };
  }, [id]);

  if (!id) return src;
  return entry?.id === id ? entry.url : undefined;
};

export const useAttachmentSrc = () => {
  const { file, src } = useAuiState(
    useShallow((s): { file?: File; src?: string } => {
      if (s.attachment.type !== "image") return {};
      if (s.attachment.file) return { file: s.attachment.file };
      const src = s.attachment.content?.filter((c) => c.type === "image")[0]
        ?.image;
      if (!src) return {};
      return { src };
    }),
  );

  const realSrc = useRealImageSrc(src);
  return useFileSrc(file) ?? realSrc;
};

// Module の画面からのダウンロード（MCP Apps の `ui/download-file`、2026-09-23）。
//
// 画面はサンドボックスの中にいて、自分ではファイルを保存させられない——仕様が
// 「host に頼む」口を用意している（規則12）。ここは **banto の側で実際に保存させる**
// 部分だけを持つ。確かめるかどうかは `module-canvas.tsx` が決める。

/** 画面が渡してくる1件（仕様の EmbeddedResource の中身）。 */
export interface EmbeddedDownload {
  uri: string;
  mimeType?: string;
  blob?: string;
  text?: string;
}

export interface PreparedDownload {
  name: string;
  blob: Blob;
}

/** 保存するときの名前——URI の最後の部分。区切りや空は使わない。 */
export function downloadNameOf(uri: string): string {
  let last = uri.split(/[?#]/)[0]!.split("/").pop() ?? "";
  try {
    last = decodeURIComponent(last);
  } catch {
    // 読めない %xx はそのまま使う
  }
  const safe = last.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return safe && safe !== "." && safe !== ".." ? safe : "download";
}

export function prepareDownload(resource: EmbeddedDownload): PreparedDownload {
  const type = resource.mimeType ?? "application/octet-stream";
  let blob: Blob;
  if (typeof resource.blob === "string") {
    const binary = atob(resource.blob);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    blob = new Blob([bytes], { type });
  } else {
    blob = new Blob([resource.text ?? ""], { type });
  }
  return { name: downloadNameOf(resource.uri), blob };
}

export function saveDownload({ name, blob }: PreparedDownload): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // すぐ捨てると、保存が始まる前に中身が消えるブラウザがある
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

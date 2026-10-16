// pdf.js（pdfjs-dist 6.4）の、この画面が使うところだけの型。
//
// pdf.js 本体は束に入れず、HTML に別の script で置く（`ui-app.ts`）——読み込まれると自分で
// `globalThis.pdfjsLib` に置く。worker も同じ画面の中で先に読み込まれ `globalThis.pdfjsWorker` に置かれるので、
// pdf.js は Worker を作らずに同じ流れで動く（fake worker。Canvas の CSP は Worker を塞いでいて、緩めない）。
// パッケージの型（.d.mts）はこの画面の組み立て（CommonJS）から引けないので、使う形だけを書き写す。

export interface PdfViewport {
  width: number;
  height: number;
  scale: number;
  userUnit?: number;
}

export interface PdfTextItem {
  str: string;
  hasEOL?: boolean;
}

export interface PdfTextContent {
  items: PdfTextItem[];
}

export interface PdfRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

export interface PdfPage {
  getViewport(params: { scale: number }): PdfViewport;
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport; transform?: number[] }): PdfRenderTask;
  getTextContent(): Promise<PdfTextContent>;
  cleanup(): boolean;
}

export interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}

export interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

/** バイトの範囲で中身を渡す口。`requestDataRange` を差し替え、届いたら `onDataRange` で返す */
export interface PdfDataRangeTransport {
  requestDataRange(begin: number, end: number): void;
  onDataRange(begin: number, chunk: Uint8Array): void;
  abort(): void;
}

export interface PdfTextLayer {
  render(): Promise<void>;
  cancel(): void;
  /** 文字の層の要素。`getTextContent()` の items と同じ順・同じ数 */
  readonly textDivs: HTMLElement[];
}

/** CMap・標準フォントを渡す口（pdf.js は既定で fetch する。この画面は fetch できないので差し替える） */
export interface PdfBinaryDataFactory {
  fetch(params: { kind: string; filename: string }): Promise<Uint8Array>;
}

export interface PdfDocumentParams {
  data?: Uint8Array;
  range?: PdfDataRangeTransport;
  rangeChunkSize?: number;
  disableAutoFetch?: boolean;
  disableStream?: boolean;
  isEvalSupported?: boolean;
  useWasm?: boolean;
  useWorkerFetch?: boolean;
  cMapPacked?: boolean;
  BinaryDataFactory?: new (options: object) => PdfBinaryDataFactory;
}

export interface PdfJsLib {
  getDocument(params: PdfDocumentParams): PdfLoadingTask;
  PDFDataRangeTransport: new (length: number, initialData: Uint8Array | null) => PdfDataRangeTransport;
  TextLayer: new (params: { textContentSource: PdfTextContent; container: HTMLElement; viewport: PdfViewport }) => PdfTextLayer;
}

/** pdf.js 本体。読み込まれていなければ止まる（黙って描けないふりをしない、規則2） */
export function pdfjs(): PdfJsLib {
  const g = globalThis as { pdfjsLib?: PdfJsLib; pdfjsWorker?: unknown };
  if (!g.pdfjsLib) throw new Error("pdf.js が読み込まれていません（画面の組み立てを確かめてください）");
  if (!g.pdfjsWorker) throw new Error("pdf.js の worker が読み込まれていません（Worker 無しで動かせません）");
  return g.pdfjsLib;
}

/** 描画を途中で止めたときに pdf.js が投げるもの（失敗ではない） */
export function isRenderingCancelled(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "RenderingCancelledException";
}

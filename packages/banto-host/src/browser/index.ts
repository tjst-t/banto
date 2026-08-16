/**
 * 共有ブラウザ モジュールの入口。
 *
 * いまはホストの中に置いてあるが、外へ切り出せるように**ここ1つを口にしてある**
 * （ホストの他の場所から `./browser/session.js` 等を直に掴まない）。
 */

export {
  createBrowserModule,
  BROWSER_BASE_URL,
  BROWSER_VIEWER_WS_PATH,
  type BrowserModuleOptions,
} from "./module.js";
export {
  createUnimplementedLauncher,
  type BrowserLauncher,
  type LaunchRequest,
  type LaunchedBrowser,
} from "./launcher.js";
export { connectCdp, type CdpConnection, type CdpEventHandler, type CdpParams } from "./cdp.js";
export {
  createBrowserSession,
  type BrowserSession,
  type BrowserSessionOptions,
  type BrowserStatus,
  type ScreencastOptions,
} from "./session.js";
export {
  parseViewerInput,
  toCdpCalls,
  toPageCoordinates,
  type CdpCall,
  type MouseButton,
  type Point,
  type ScreencastMetadata,
  type ViewerInput,
  type ViewerMessage,
  type ViewerSize,
} from "./viewer-protocol.js";

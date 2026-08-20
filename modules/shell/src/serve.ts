/**
 * subprocess として単独で立つときの入口。stdio で標準 MCP を喋る
 * （isolation: 'subprocess'、要件 C8b）。Runner はこのプロセスを
 * `node modules/shell/dist/serve.js` として起動し、stdio 越しに繋ぐだけ。
 */

import { shellModule } from './index.js';

await shellModule.serve();

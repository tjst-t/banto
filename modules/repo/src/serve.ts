/**
 * subprocess として単独で立つときの入口。stdio で標準 MCP を喋る
 * （isolation: 'subprocess'、要件 C8b）。Runner はこのプロセスを
 * `node modules/repo/dist/serve.js` として起動し、stdio 越しに繋ぐだけ。
 */

import { requiredRoot } from '@banto/module-kit';

import { repoModule } from './index.js';

await repoModule(requiredRoot('BANTO_REPO_ROOT')).serve();

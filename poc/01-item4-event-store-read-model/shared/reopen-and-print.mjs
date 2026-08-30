// 別プロセスでの再開を試すための子プロセス。dir を開いて state を canonical にして stdout へ。
import { StoreC } from '../arm-c.mjs';
import { canonical } from './fold.mjs';

const dir = process.argv[2];
const store = await StoreC.open(dir);
process.stdout.write(canonical(store.state()));

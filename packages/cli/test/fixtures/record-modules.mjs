// TEST ONLY: preloaded with `node --import <this file>` to record every module the process loads (ESM and CommonJS,
// static and dynamic), so a test can check what `smurg hook` / `smurg mcp` really load at run time. The list is written
// as JSON to $SMURG_RECORD_MODULES_OUT when the process exits.
import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const out = process.env['SMURG_RECORD_MODULES_OUT'];
const loaded = [];
registerHooks({
  load(url, context, nextLoad) {
    loaded.push(url);
    return nextLoad(url, context);
  },
});
process.on('exit', () => {
  if (out) writeFileSync(out, JSON.stringify(loaded));
});

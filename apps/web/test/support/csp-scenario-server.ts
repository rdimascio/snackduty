import { createApp } from "@lesto/kernel";
import { serve } from "@lesto/runtime";

import applicationConfig from "../../lesto.app";
import {
  registerRuntimePages,
  withBrandPolicy,
  withRuntimeAssets,
} from "../../runtime/web-surface";

const config = await applicationConfig();
await registerRuntimePages(config.app);
const app = withBrandPolicy(withRuntimeAssets(await createApp(config)));
const server = await serve(app, { host: "127.0.0.1", port: 0 });

const stop = () => {
  void server.close().finally(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

console.log(JSON.stringify({ port: server.port }));

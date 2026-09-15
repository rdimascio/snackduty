import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { App } from "@lesto/kernel";
import { scanRoutes } from "@lesto/router";
import { contentTypeOf, nodeStaticReader, staticCacheControl } from "@lesto/runtime";
import { applyFileRoutes, loadFileRoutes } from "@lesto/web";
import type { Lesto } from "@lesto/web";

const webRoot = fileURLToPath(new URL("../", import.meta.url));

/** Use the same file-route discovery and layout composition as the Lesto CLI. */
export async function registerRuntimePages(app: Lesto): Promise<void> {
  const directory = join(webRoot, "app/routes");
  const files = await scanRoutes(
    async (path) =>
      (await readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      })),
    directory,
  );
  const modules = await loadFileRoutes(
    files,
    (kind, segments) => import(join(directory, ...segments, kind)),
  );
  applyFileRoutes(app, files, modules);
}

/** Only the two public build outputs are exposed; database/source files never are. */
export function withRuntimeAssets(app: App, outputRoot = join(webRoot, "out")): App {
  const read = nodeStaticReader(outputRoot);
  return {
    ...app,
    async handle(method, path, options) {
      if (
        (method === "GET" || method === "HEAD") &&
        (path === "/client.js" || path === "/styles.css")
      ) {
        const file = path.slice(1);
        const body = await read(file);
        if (typeof body !== "string") return { status: 404, headers: {}, body: "" };
        return {
          status: 200,
          headers: {
            "Content-Type": contentTypeOf(file),
            "Cache-Control": staticCacheControl(file),
            "X-Content-Type-Options": "nosniff",
          },
          body: method === "HEAD" ? "" : body,
        };
      }
      return app.handle(method, path, options);
    },
  };
}

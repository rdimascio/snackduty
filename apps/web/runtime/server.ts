import type { App } from "@lesto/kernel";
import { serveWithGracefulShutdown } from "@lesto/runtime";
import type {
  GracefulShutdownOptions,
  RequestTracer,
  Server,
  TraceparentParser,
} from "@lesto/runtime";

import { logAccessLine, redactingLogRequest } from "../app/lib/server/access-log";
import { openRuntimeApplication } from "./application";
import type { RuntimeApplication, RuntimeApplicationAdapters } from "./application";
import type { RuntimeConfiguration, RuntimeEnvironment } from "./config";
import { runtimeConfiguration } from "./config";
import { redactingRequestTracer } from "./tracing";
import { createAppleIdentityVerifier } from "../app/lib/server/apple-identity";

type ServeRuntime = (app: App, options: GracefulShutdownOptions) => Promise<Server>;

export interface RuntimeServerAdapters extends RuntimeApplicationAdapters {
  readonly serve?: ServeRuntime;
  readonly tracer?: RequestTracer;
  readonly parseTraceparent?: TraceparentParser;
}

export interface RunningRuntimeServer {
  readonly application: RuntimeApplication;
  readonly port: number;
  stop(): Promise<void>;
}

function databaseReady(application: RuntimeApplication): () => Promise<boolean> {
  return async () => {
    try {
      await application.sql.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  };
}

export async function startRuntimeServer(
  configuration: RuntimeConfiguration,
  adapters: RuntimeServerAdapters = {},
): Promise<RunningRuntimeServer> {
  const application = await openRuntimeApplication(configuration, adapters);
  const serveRuntime = adapters.serve ?? serveWithGracefulShutdown;

  try {
    const server = await serveRuntime(application.app, {
      host: configuration.host,
      port: configuration.port,
      health: { isReady: databaseReady(application) },
      logRequest: redactingLogRequest(logAccessLine),
      onClosed: application.close,
      ...(adapters.tracer === undefined ? {} : { tracer: redactingRequestTracer(adapters.tracer) }),
      ...(adapters.parseTraceparent === undefined
        ? {}
        : { parseTraceparent: adapters.parseTraceparent }),
    });
    let stopped = false;

    return {
      application,
      port: server.port,

      async stop() {
        if (stopped) return;
        stopped = true;
        await server.close();
        await application.close();
      },
    };
  } catch (error) {
    await application.close();
    throw error;
  }
}

export async function runRuntimeFromEnvironment(
  environment: RuntimeEnvironment,
  adapters: RuntimeServerAdapters = {},
): Promise<RunningRuntimeServer> {
  const configuration = runtimeConfiguration(environment);
  const audience = environment["SNACKDAY_APPLE_CLIENT_ID"]?.trim();
  const appleVerifier =
    adapters.appleVerifier ??
    (audience
      ? createAppleIdentityVerifier({
          audience,
          ...(adapters.clock === undefined ? {} : { clock: adapters.clock }),
        })
      : undefined);
  const running = await startRuntimeServer(configuration, {
    ...adapters,
    ...(appleVerifier === undefined ? {} : { appleVerifier }),
  });
  console.log(
    JSON.stringify({
      level: "info",
      event: "runtime.ready",
      mode: configuration.mode,
      public_base_url: configuration.publicBaseUrl.origin,
      port: running.port,
      migrations_applied: running.application.migrationsApplied,
    }),
  );
  return running;
}

if (import.meta.main) {
  await runRuntimeFromEnvironment(process.env);
}

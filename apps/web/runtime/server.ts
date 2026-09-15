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
import { aesGcmInvitationPayloadCipher } from "../app/lib/server/invitation-outbox";

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
  let closeResources = application.close;

  try {
    const worker = await application.outbox?.work();
    let resourcesClosed = false;
    closeResources = async () => {
      if (resourcesClosed) return;
      resourcesClosed = true;
      await worker?.stop();
      await application.close();
    };
    const server = await serveRuntime(application.app, {
      host: configuration.host,
      port: configuration.port,
      health: { isReady: databaseReady(application) },
      logRequest: redactingLogRequest(logAccessLine),
      onClosed: closeResources,
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
        await closeResources();
      },
    };
  } catch (error) {
    await closeResources();
    throw error;
  }
}

export async function runRuntimeFromEnvironment(
  environment: RuntimeEnvironment,
  adapters: RuntimeServerAdapters = {},
): Promise<RunningRuntimeServer> {
  const configuration = runtimeConfiguration(environment);
  const encodedKey = environment["SNACKDAY_INVITATION_OUTBOX_KEY"];
  const decodedKey = encodedKey === undefined ? undefined : Buffer.from(encodedKey, "base64");
  if (
    decodedKey !== undefined &&
    (decodedKey.byteLength !== 32 || decodedKey.toString("base64") !== encodedKey)
  ) {
    throw new Error("SNACKDAY_INVITATION_OUTBOX_KEY must be a base64-encoded 32-byte key.");
  }
  const invitationCipher =
    adapters.invitationCipher ??
    (decodedKey === undefined ? undefined : aesGcmInvitationPayloadCipher(decodedKey));
  if (adapters.inviteDelivery !== undefined && invitationCipher === undefined) {
    throw new Error("Configured invitation delivery requires an outbox encryption key.");
  }
  const running = await startRuntimeServer(configuration, {
    ...adapters,
    ...(invitationCipher === undefined ? {} : { invitationCipher }),
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

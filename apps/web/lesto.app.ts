import { KERNEL_DEFAULT_RATE_LIMIT, secureStack } from "@lesto/kernel";
import type { LestoAppConfig } from "@lesto/kernel";
import { openSqlite } from "@lesto/runtime";
import { BROWSER_SPANS_ROUTE, runPipeline } from "@lesto/web";
import type { LestoRequest, LestoResponse } from "@lesto/web";
import { env } from "./env";
import { createApplication } from "./app/lib/server/composition";
import { identityServices } from "./app/lib/server/identity";
import { devInviteDeliverer } from "./app/lib/server/invite-delivery";
import { createAppleIdentityVerifier } from "./app/lib/server/apple-identity";
import { unavailableInviteDeliverer } from "./runtime/delivery";
import { runtimeConfiguration } from "./runtime/config";
import { aesGcmInvitationPayloadCipher } from "./app/lib/server/invitation-outbox";
import { reelLessonCatalog } from "./app/lessons/catalog";
import { routeBrands, secureBrands } from "./app/server/brand-routing";
import { ballplayerHome } from "./app/ballplayer/home-page";
import { registerDevSkillEventRoutes } from "./app/dev/skill-events";

function isBrowserSpanPost(request: LestoRequest): boolean {
  return request.method.toUpperCase() === "POST" && request.path === BROWSER_SPANS_ROUTE;
}

function withUnlimitedBrowserSpans(config: LestoAppConfig): LestoAppConfig {
  if (config.secure === false) return config;
  const { rateLimit, ...unlimited } = config.secure ?? {};
  const durable =
    config.durable === false ? {} : { db: config.db, dialect: config.dialect ?? "sqlite" };
  const limited = secureStack({
    rateLimit: rateLimit ?? { ...KERNEL_DEFAULT_RATE_LIMIT },
    ...durable,
    ...unlimited,
  });
  const browserSpans = secureStack(unlimited);
  const handle = config.app.handle.bind(config.app);
  config.app.handle = async (method, path, options) => {
    const request: LestoRequest = {
      method,
      path,
      params: {},
      query: options?.query ?? {},
      headers: options?.headers ?? {},
      body: options?.body,
    };
    const response = await runPipeline(
      isBrowserSpanPost(request) ? browserSpans : limited,
      request,
      () => handle(method, path, options),
    );
    return response as LestoResponse;
  };
  return { ...config, secure: false };
}

// Lesto invokes this factory per boot; importing it opens no database.
export default async function applicationConfig() {
  const mode = env.SNACKDAY_RUNTIME_MODE;
  if (mode !== "development" && mode !== "staging" && mode !== "production") {
    throw new Error("SNACKDAY_RUNTIME_MODE must be development, staging, or production.");
  }
  if (mode !== "development") runtimeConfiguration(process.env);
  const { db: sql } = await openSqlite(env.LESTO_DB);
  const { db, sessions } = await identityServices(sql, {
    mode: mode === "development" ? "development" : "verified",
    clock: Date.now,
  });
  const audience = env.SNACKDAY_APPLE_CLIENT_ID?.trim();
  const { config } = createApplication({
    sql,
    db,
    sessions,
    clock: Date.now,
    mode,
    developmentSignIn: env.SNACKDAY_DEV_SIGN_IN,
    lessons: {
      enabled: env.SNACKDAY_LESSON_OF_THE_WEEK,
      catalog: reelLessonCatalog({ clock: Date.now }),
    },
    inviteDelivery: mode === "development" ? devInviteDeliverer() : unavailableInviteDeliverer(),
    ...(mode === "development"
      ? {
          // Public, synthetic-only development key. Remote delivery never uses it.
          invitationCipher: aesGcmInvitationPayloadCipher(new Uint8Array(32).fill(7)),
        }
      : {}),
    ...(audience ? { appleVerifier: createAppleIdentityVerifier({ audience }) } : {}),
  });
  const app = registerDevSkillEventRoutes(config.app, {
    enabled: env.SNACKDAY_DEV_SIGN_IN,
    db,
    sessions,
    clock: Date.now,
  });
  const branded = { ...config, app: secureBrands(routeBrands(app, { home: ballplayerHome })) };
  return mode === "development" ? withUnlimitedBrowserSpans(branded) : branded;
}

import { createApp } from "@lesto/kernel";

import applicationConfig from "../../lesto.app";

const app = await createApp(await applicationConfig());
const sameOrigin = { "sec-fetch-site": "same-origin" };
const seed = await app.handle(
  "POST",
  "/api/dev/teams/team_probe/participants/participant_probe/skill-events",
  { headers: sameOrigin, body: [] },
);
const signIn = await app.handle("POST", "/api/dev/sign-in", { headers: sameOrigin });
const roleSignIn = await app.handle("POST", "/api/dev/sign-in", {
  headers: sameOrigin,
  body: { persona: "head-coach" },
});
const rolesPage = await app.handle("GET", "/dev/sign-in", { headers: {} });
console.log(
  JSON.stringify({
    seed: seed.status,
    signIn: signIn.status,
    roleSignIn: roleSignIn.status,
    rolesPage: rolesPage.status,
  }),
);

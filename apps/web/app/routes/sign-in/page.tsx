import type { ReactNode } from "react";

import type { Context, PageDef } from "@lesto/web";

import { Brand } from "../../components/brand";
import { EmptyState } from "../../components/states/empty-state";
import EmailSignIn from "../../islands/email-sign-in";
import { appServices } from "../../lib/server/app-services";
import { authenticatedAdult } from "../../lib/server/identity";

type SignInData = { readonly signedIn: boolean };

/** The loader never sees the sign-in token: it travels in the URL fragment. */
const load = async (c: Context<"/sign-in">): Promise<SignInData> => {
  const services = appServices(c);
  if (services === undefined) return { signedIn: false };
  const identity = await authenticatedAdult(services.db, services.sessions, c.header("cookie"));
  return { signedIn: identity !== undefined };
};

function SignInPage(data: SignInData): ReactNode {
  return (
    <main className="mx-auto max-w-2xl px-5 py-16 lg:py-24" id="main-content" tabIndex={-1}>
      <div className="mb-10 flex justify-center">
        <Brand />
      </div>
      <h1 className="mb-8 text-center text-3xl font-black tracking-tight sm:text-4xl">Sign in</h1>
      {data.signedIn ? (
        <EmptyState
          action={
            <a className="font-semibold text-primary underline" href="/app">
              Go to your teams
            </a>
          }
          description="This browser already has a Snackday session."
          title="You are signed in"
        />
      ) : (
        <>
          <EmailSignIn />
          <noscript>
            <p className="mt-6 text-center text-sm text-muted-foreground">
              Sign-in needs JavaScript. Turn it on and reload this page.
            </p>
          </noscript>
        </>
      )}
    </main>
  );
}

const page: PageDef<"/sign-in", SignInData> = {
  component: SignInPage,
  load,
  metadata: () => ({
    title: "Sign in — Snackday",
    description: "Sign in to Snackday with a link sent to your email.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};

export default page;

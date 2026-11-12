import type { ReactNode } from "react";

import type { Context, PageDef } from "@lesto/web";
import { ACCOUNT_ERASE_CONFIRMATION } from "@snackday/domain";

import { loadAccountPage } from "../../../account/account-data";
import type { AccountPageData } from "../../../account/account-data";
import { EmptyState } from "../../../components/states/empty-state";
import AccountErasure from "../../../islands/account-erasure";
import { appServices } from "../../../lib/server/app-services";

const load = async (c: Context<"/app/account">): Promise<AccountPageData> => {
  const services = appServices(c);
  if (services === undefined) return { state: "signed-out" };
  return loadAccountPage(services, c.header("cookie"));
};

function AccountPage(data: AccountPageData): ReactNode {
  return (
    <div className="max-w-2xl">
      <p className="text-sm font-bold text-primary">Account</p>
      <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">
        {data.state === "account" ? data.displayName : "Account"}
      </h1>
      <p className="mt-2 text-muted-foreground">
        Read what we keep and why in the{" "}
        <a className="font-semibold text-primary underline" href="/privacy">
          privacy policy
        </a>
        .
      </p>
      <div className="mt-8">
        {data.state === "signed-out" ? (
          <EmptyState
            description="Sign in to see and erase the data you manage."
            title="Signed out"
          />
        ) : (
          <AccountErasure confirmation={ACCOUNT_ERASE_CONFIRMATION} managed={data.children} />
        )}
      </div>
    </div>
  );
}

const page: PageDef<"/app/account", AccountPageData> = {
  component: AccountPage,
  load,
  metadata: () => ({
    title: "Account — Snackday",
    description: "Erase your account or your children's data.",
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
};

export default page;

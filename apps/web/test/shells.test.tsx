import { describe, expect, it } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";

import { Brand } from "../app/components/brand";
import MarketingLayout from "../app/routes/(marketing)/layout";
import featuresPage from "../app/routes/(marketing)/features/page";
import homePage from "../app/routes/(marketing)/page";
import AppLayout from "../app/routes/app/layout";
import appPage from "../app/routes/app/page";
import RootLayout from "../app/routes/layout";

describe("Snackday route shells", () => {
  it("renders an accessible root skip link and public navigation", () => {
    const html = render(
      <RootLayout>
        <MarketingLayout>
          <homePage.component />
        </MarketingLayout>
      </RootLayout>,
    );

    expect(html).toContain('href="#main-content"');
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('aria-label="Mobile primary"');
    expect(html).toContain("<summary");
    expect(html).toContain("Don&#x27;t forget");
    expect(html).not.toContain("Counter");
  });

  it("renders the application shell with only existing links enabled", () => {
    const html = render(
      <AppLayout>
        <appPage.component state="signed-out" />
      </AppLayout>,
    );

    expect(html).toContain('aria-label="Team workspace"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Workspace menu");
    expect(html).toContain('id="main-content"');
    expect(html).not.toContain('href="/app/roster"');
  });

  it("renders the second marketing route with shared feature content", () => {
    const html = render(<featuresPage.component />);
    expect(html).toContain("Less admin. More playing.");
    expect(html).toContain('aria-label="Snackday features"');
  });
});

describe("route metadata", () => {
  it("keeps public metadata distinct and canonical", () => {
    const home = homePage.metadata?.({});
    const features = featuresPage.metadata?.({});
    expect(home?.title).not.toBe(features?.title);
    expect(home?.description).not.toBe(features?.description);
    expect(home?.links).toContainEqual({ rel: "canonical", href: "/" });
    expect(features?.links).toContainEqual({ rel: "canonical", href: "/features" });
  });

  it("marks the product shell private for search crawlers", () => {
    expect(appPage.metadata?.({ state: "signed-out" }).meta).toContainEqual({
      name: "robots",
      content: "noindex, nofollow",
    });
  });
});

// Prove the component is a named export without relying on a snapshot.
expect(Brand).toBeTypeOf("function");

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { createElement } from "react";

import { EmptyState } from "../app/components/states/empty-state";
import { ErrorState } from "../app/components/states/error-state";
import { LoadingState } from "../app/components/states/loading-state";
import { ButtonLink } from "../app/components/ui/button";

describe("shared route states", () => {
  it("renders an empty state with and without an action", () => {
    const withoutAction = render(<EmptyState description="Nothing here yet" title="Empty" />);
    const withAction = render(
      <EmptyState
        action={createElement(ButtonLink, { href: "/app" }, "Set up team")}
        description="Nothing here yet"
        title="Empty"
      />,
    );

    expect(withoutAction).toContain('aria-labelledby="empty-state-title"');
    expect(withoutAction).not.toContain("Set up team");
    expect(withAction).toContain('href="/app"');
  });

  it("exposes one loading status while hiding skeletons", () => {
    const html = render(<LoadingState label="Loading schedule" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading schedule"');
    expect(html.match(/aria-hidden="true"/gu)?.length).toBe(2);
  });

  it("uses alert semantics and an ordinary recovery link for failures", () => {
    const html = render(<ErrorState href="/features" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('href="/features"');
    expect(html).not.toContain("Error:");
  });
});

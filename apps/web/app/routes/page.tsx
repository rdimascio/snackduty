import type { ReactNode } from "react";

import type { PageDef, PageProps } from "@lesto/web";

import Counter from "../islands/counter";

/**
 * The server load. Pulled out as a top-level `const` so the component's props are
 * INFERRED from its return via `PageProps<typeof load>` — declared once, with no
 * restated interface. Returns the island's starting count.
 */
const load = () => ({ start: 0 });

/**
 * The default export IS the `PageDef` the file-route applier registers at `/`.
 * The Counter island is inert until the client bundle hydrates it — a working
 * click is the visible proof the island came alive on the Preact runtime.
 */
const page: PageDef<"/", PageProps<typeof load>> = {
  load,

  component: ({ start }: PageProps<typeof load>): ReactNode => (
    <main>
      <h1>Welcome to Lesto</h1>

      <p>
        This page is <strong>file-routed</strong>: it lives at <code>app/routes/page.tsx</code> and
        registers the URL <code>/</code> with no <code>.page()</code> call. Add a page by adding a
        file under <code>app/routes/</code>.
      </p>

      <Counter start={start} />
    </main>
  ),

  metadata: () => ({
    title: "Welcome to Lesto",
    description: "A file-routed home page over the Lesto starter.",
  }),
};

export default page;

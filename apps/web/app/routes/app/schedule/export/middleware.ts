import type { RouteMiddleware } from "@lesto/web";

import { exportScheduleCsv } from "../../../../schedule/schedule-export";

const exportGuard: RouteMiddleware<"/app/schedule/export"> = (c) => exportScheduleCsv(c);

export default exportGuard;

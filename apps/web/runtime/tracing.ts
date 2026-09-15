import type { RequestSpan, RequestTracer } from "@lesto/runtime";

import { redactCredentialPath } from "../app/lib/server/access-log";

function redactingSpan(span: RequestSpan): RequestSpan {
  return {
    data: span.data,

    setAttribute(key, value) {
      const safeValue =
        key === "http.path" && typeof value === "string" ? redactCredentialPath(value) : value;
      return span.setAttribute(key, safeValue);
    },

    setStatus(status) {
      return span.setStatus(status);
    },

    end() {
      span.end();
    },
  };
}

/** Keeps bearer path segments out of the runtime's `http.path` span attribute. */
export function redactingRequestTracer(tracer: RequestTracer): RequestTracer {
  return {
    startSpan(name, inbound) {
      return redactingSpan(tracer.startSpan(name, inbound));
    },
  };
}

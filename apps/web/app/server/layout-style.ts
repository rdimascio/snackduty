import type { AnyLestoResponse } from "@lesto/web";

const LAYOUT_INLINE_STYLE = /(<div data-lesto-layout="\d+") style="display:contents"/gu;

const LONGEST_HELD_TAG = 64;

function isHtml(headers: AnyLestoResponse["headers"]): boolean {
  return Object.entries(headers).some(
    ([name, value]) =>
      name.toLowerCase() === "content-type" &&
      (Array.isArray(value) ? value[0] : value)?.includes("text/html") === true,
  );
}

export function stripLayoutInlineStyle(html: string): string {
  return html.replace(LAYOUT_INLINE_STYLE, "$1");
}

function heldTail(html: string): number {
  const lastTag = html.lastIndexOf("<");
  return lastTag !== -1 && html.length - lastTag < LONGEST_HELD_TAG ? lastTag : html.length;
}

function strippedStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const html = stripLayoutInlineStyle(pending + decoder.decode(chunk, { stream: true }));
        const cut = heldTail(html);
        pending = html.slice(cut);
        if (cut > 0) controller.enqueue(encoder.encode(html.slice(0, cut)));
      },
      flush(controller) {
        const rest = stripLayoutInlineStyle(pending + decoder.decode());
        if (rest !== "") controller.enqueue(encoder.encode(rest));
      },
    }),
  );
}

export function withoutLayoutInlineStyle<R extends AnyLestoResponse>(response: R): R {
  if (!isHtml(response.headers)) return response;
  const { body } = response;
  if (typeof body === "string") return { ...response, body: stripLayoutInlineStyle(body) };
  if (body instanceof ReadableStream) return { ...response, body: strippedStream(body) };
  return response;
}

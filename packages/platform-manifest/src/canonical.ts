/** Normalize a parseable timestamp to UTC at the manifest's required second precision. */
export function normalizeTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`Invalid commit timestamp: ${value}`);
  return new Date(Math.floor(milliseconds / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

function assertUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Canonical JSON rejects lone Unicode surrogates");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError("Canonical JSON rejects lone Unicode surrogates");
    }
  }
}

/**
 * RFC 8785 serialization restricted to finite safe integers (excluding negative zero).
 * Manifest v0 intentionally has no floating-point fields.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError("Manifest numbers must be finite, safe integers and not negative zero");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertUnicode(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  if (typeof value !== "object") throw new TypeError(`Canonical JSON rejects ${typeof value}`);
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => {
      assertUnicode(key);
      return `${JSON.stringify(key)}:${canonicalize(object[key])}`;
    })
    .join(",")}}`;
}

/** Collect semantic nulls using RFC 6901 escaping. The unknowns ledger is metadata, not a fact. */
export function collectNullPointers(value: unknown, pointer = ""): string[] {
  if (value === null) return [pointer];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectNullPointers(item, `${pointer}/${index}`));
  }
  if (typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    key === "unknowns"
      ? []
      : collectNullPointers(item, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
  );
}

export function jsonPointerValue(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((value, token) => {
      if (Array.isArray(value)) {
        return /^0$|^[1-9]\d*$/u.test(token) ? value[Number(token)] : undefined;
      }
      return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[token]
        : undefined;
    }, root);
}

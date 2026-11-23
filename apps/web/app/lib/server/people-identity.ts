/**
 * "Are these two records the same person?" — asked in exactly one place.
 *
 * Two roster-maintenance surfaces use display-name similarity as a visible,
 * manager-reviewed duplicate hint:
 *
 *   1. Roster import, deciding whether a CSV row names a child who is already
 *      on this season's roster (or appears twice in the same file). The
 *      single-child add uses the same key and answers 409 on a match.
 *   2. Manual guardian attachment, enforcing the duplicate-active-guardian
 *      invariant (`hasDuplicateActiveGuardian` in roster.ts).
 *
 * STORED KEYS: a SHA-256 digest of each key is also stored, so the database
 * enforces both invariants with a partial UNIQUE index (roster-name-keys.ts):
 * `memberships.child_identity_key` holds `storedChildIdentityKey` per season,
 * and `guardian_relationships.guardian_name_key` holds `storedGuardianNameKey`
 * of a placeholder guardian per child + relationship. SQLite and Postgres
 * cannot compute this normalization, and a database without interactive
 * transactions (Cloudflare D1) cannot run the JS check and the write as one
 * unit, so the index is what stops a race between two writes. The JS checks
 * stay and decide the user-facing answer; the index is the backstop. The
 * digest keeps a child's name and birth date out of index entries and the
 * database's constraint-error log, and gives every key a fixed length. Every
 * write that inserts a roster membership or a placeholder guardian link, or
 * changes a child's name or birth date or a placeholder guardian's name, writes
 * the key with the `stored*` helpers in this file, so there is one definition.
 * A stored key is still never identity proof: an account-bound guardian link
 * stores no key, and the database cannot tell a missing key on such a link from
 * a missed write.
 *
 * Authentication, invitation acceptance, account linking and guardian authority
 * MUST NOT use these helpers. Those flows require a stable provider subject or
 * an exact owner-confirmed record ID; a name is never identity proof.
 *
 * THE DEFINITION, and why:
 *
 *   - Same PERSON: the same display name, compared after Unicode NFC
 *     normalization, whitespace collapsing, trimming, and lower-casing. A name
 *     is the only identifying attribute Snackday holds for a placeholder
 *     guardian, and the only one it will ever hold for a child.
 *
 *   - Same CHILD: the same person name AND the same birth date, where "no birth
 *     date recorded" is its own distinct value. Name alone would merge the two
 *     real Jayden Smiths a large club genuinely rosters. Birth date is the only
 *     other attribute we hold — deliberately, because a child has no email, no
 *     address, and no external id here — so name + birth date is the strongest
 *     key available without collecting more data about a minor.
 *
 *   - The asymmetry is INTENTIONAL. A false positive (two different children
 *     judged the same) silently drops a real child from a roster; a false
 *     negative (one child judged two) creates a second row a manager can see
 *     and archive. So a blank birth date does NOT match a recorded one: we take
 *     the visible mistake over the invisible one. Import surfaces every match as
 *     a per-row VERDICT the manager rules on before anything is written, which
 *     is what makes this trade safe rather than merely conservative.
 */

/**
 * The comparable form of a display name: NFC (so a precomposed "e-acute" and a
 * decomposed one agree), internal whitespace collapsed, trimmed, lower-cased.
 * Stored only as a roster name key (above); the original casing and spacing the
 * manager typed is what gets written to `people` and shown.
 */
export function normalizeDisplayName(displayName: string): string {
  return displayName.normalize("NFC").replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

/** Whether two display names name the same person, per the rule above. */
export function sameDisplayName(left: string, right: string): boolean {
  return normalizeDisplayName(left) === normalizeDisplayName(right);
}

/**
 * Join key parts unambiguously WITHOUT a control character: each part is
 * length-prefixed, so no pair of values can collide across the join
 * (`"ab" + ""` and `"a" + "b"` produce different keys). The key holds the
 * normalized name and birth date in clear text, so it is never logged or
 * stored; only its digest (`storedKeyDigest`) is.
 */
function joinKeyParts(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join("|");
}

/**
 * The identity key for one child: normalized display name plus birth date, with
 * "no birth date" as its own value. Two roster entries are the same child when
 * and only when these keys are equal.
 */
export function childIdentityKey(child: {
  readonly displayName: string;
  readonly birthDate?: string | null | undefined;
}): string {
  return joinKeyParts([normalizeDisplayName(child.displayName), child.birthDate ?? ""]);
}

/**
 * A roster-maintenance duplicate hint for a placeholder guardian on one child.
 * This key is never suitable for account linking or an authorization decision.
 */
export function guardianIdentityKey(guardian: {
  readonly displayName: string;
  readonly relationship: string;
}): string {
  return joinKeyParts([normalizeDisplayName(guardian.displayName), guardian.relationship]);
}

const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;

/**
 * The stored form of a roster name key: the lower-case hex SHA-256 digest, 64
 * characters for any input. Equal keys give equal digests, so uniqueness is
 * unchanged.
 */
export async function storedKeyDigest(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0"),
  ).join("");
}

/** What `memberships.child_identity_key` stores for one rostered child. */
export function storedChildIdentityKey(child: {
  readonly displayName: string;
  readonly birthDate?: string | null | undefined;
}): Promise<string> {
  return storedKeyDigest(childIdentityKey(child));
}

/** What `guardian_relationships.guardian_name_key` stores for a placeholder guardian. */
export function storedGuardianNameKey(displayName: string): Promise<string> {
  return storedKeyDigest(normalizeDisplayName(displayName));
}

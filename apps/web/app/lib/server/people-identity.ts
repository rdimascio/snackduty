/**
 * "Are these two records the same person?" — asked in exactly one place.
 *
 * Three surfaces ask it, and they used to answer it three different ways:
 *
 *   1. Roster import, deciding whether a CSV row names a child who is already
 *      on this season's roster (or appears twice in the same file).
 *   2. Manual guardian attachment, enforcing the duplicate-active-guardian
 *      invariant (`hasDuplicateActiveGuardian` in roster.ts).
 *   3. Invitation acceptance, deciding whether the adult who just accepted is
 *      the guardian a manager already typed onto the child by hand.
 *
 * Surface 3 answered it by PERSON ID, which can never match surface 2 — the
 * manual path mints a fresh placeholder Person for every attach — so accepting
 * an invitation put a second "Sam Rivera" on a child's roster. The two now
 * share the definition below, which is why one fix covers both.
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
 * Never stored — the original casing and spacing the manager typed is what gets
 * written and shown.
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
 * (`"ab" + ""` and `"a" + "b"` produce different keys) and the key stays a
 * printable string that is safe to log if it ever needed to be.
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
 * The identity key for one guardian ON one child: normalized display name plus
 * the relationship label. The relationship is part of the key because the same
 * adult may legitimately hold two labels on different children, and because the
 * manual attach path has always treated name+relationship as the unique pair.
 */
export function guardianIdentityKey(guardian: {
  readonly displayName: string;
  readonly relationship: string;
}): string {
  return joinKeyParts([normalizeDisplayName(guardian.displayName), guardian.relationship]);
}

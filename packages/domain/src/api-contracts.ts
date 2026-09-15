import { z } from "zod";

// Wire contracts shared by HTTP boundaries and the canonical Swift fixtures.
// Capabilities describe a current response, never authority for a later request.
const id = z.string().min(1);
export const adultIdentitySchema = z.strictObject({
  account: z.strictObject({ id }),
  person: z.strictObject({ id, displayName: z.string().min(1) }),
});
export type AuthenticatedIdentity = z.infer<typeof adultIdentitySchema>;
export const appleChallengeSchema = z.strictObject({ challengeId: id, nonce: id });
export const appleSignInInputSchema = z.strictObject({
  challengeId: id,
  identityToken: z.string().min(1).max(16384),
  displayName: z.string().trim().min(1).max(200).optional(),
  adultConsent: z.literal(true),
});
export const signedOutSchema = z.strictObject({ signedOut: z.literal(true) });
export const apiErrorSchema = z.object({ error: z.string().min(1) });
export const teamCapabilitiesSchema = z.strictObject({
  read: z.boolean(),
  manage: z.boolean(),
  delegate: z.boolean(),
});
export const recipientBindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("verified_email"), email: z.email().trim().toLowerCase() }),
  z.strictObject({ kind: z.literal("confirmed_person"), personId: id }),
]);
export type RecipientBinding = z.infer<typeof recipientBindingSchema>;
const team = z.object({
  id,
  name: z.string().min(1),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const season = z.object({
  id,
  teamId: id,
  label: z.string().min(1),
  startDate: z.string(),
  endDate: z.string(),
  timeZone: z.string().min(1),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const adultRole = z.enum(["owner", "coach", "adult"]);
export const invitationPreviewSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("preview"),
    teamName: id,
    inviterDisplayName: id,
    invitedRole: adultRole,
  }),
  z.strictObject({ state: z.literal("accepted"), teamName: id, grantedRole: adultRole }),
]);
export const invitationAcceptanceSchema = z.strictObject({
  invitation: z.strictObject({ id, status: z.literal("accepted") }),
  membership: z.strictObject({ role: adultRole }),
  team,
});
export const teamDirectorySchema = z.strictObject({
  teams: z.array(
    z.object({
      team,
      seasons: z.array(season),
      access: z.enum(["manage", "read"]),
      capabilities: teamCapabilitiesSchema,
    }),
  ),
});
export const rosterResponseSchema = z.strictObject({
  roster: z.array(
    z.object({
      participantId: id,
      displayName: z.string().min(1),
      birthDate: z.string().nullable().optional(),
      status: z.string(),
      guardians: z.array(
        z.object({
          guardianId: id,
          displayName: z.string(),
          relationship: z.string(),
          permissions: z.array(z.string()),
          status: z.string(),
        }),
      ),
      guardianInvitations: z
        .object({
          pending: z.number().int().nonnegative(),
          expired: z.number().int().nonnegative(),
          accepted: z.number().int().nonnegative(),
        })
        .optional(),
    }),
  ),
});

import { z } from "zod";
import {
  accountIdSchema,
  auditEventIdSchema,
  guardianRelationshipIdSchema,
  isoTimestampSchema,
  membershipIdSchema,
  participantIdSchema,
  personIdSchema,
  roleIdSchema,
  seasonIdSchema,
  teamIdSchema,
  uniqueArray,
} from "./primitives";
import { domainPermissionSchema } from "./teams";

const actorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("account"),
    accountId: accountIdSchema,
    personId: personIdSchema,
  }),
  z.strictObject({
    kind: z.literal("system"),
    system: z.enum(["scheduler", "migration", "support-operation"]),
  }),
]);
const base = { eventId: auditEventIdSchema, occurredAt: isoTimestampSchema, actor: actorSchema };
const guardian = {
  teamId: teamIdSchema,
  seasonId: seasonIdSchema,
  guardianRelationshipId: guardianRelationshipIdSchema,
  participantId: participantIdSchema,
};
const membership = {
  teamId: teamIdSchema,
  seasonId: seasonIdSchema,
  membershipId: membershipIdSchema,
};
const role = { teamId: teamIdSchema, seasonId: seasonIdSchema.optional(), roleId: roleIdSchema };

export const auditEventSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...base, action: z.literal("guardian_relationship.created"), ...guardian }),
  z.strictObject({ ...base, action: z.literal("guardian_relationship.updated"), ...guardian }),
  z.strictObject({ ...base, action: z.literal("guardian_relationship.revoked"), ...guardian }),
  z.strictObject({ ...base, action: z.literal("membership.created"), ...membership }),
  z.strictObject({
    ...base,
    action: z.literal("membership.status_changed"),
    ...membership,
    previousStatus: z.enum(["invited", "active", "revoked"]),
    newStatus: z.enum(["invited", "active", "revoked"]),
  }),
  z.strictObject({
    ...base,
    action: z.literal("membership.roles_changed"),
    ...membership,
    previousRoleIds: uniqueArray(roleIdSchema),
    newRoleIds: uniqueArray(roleIdSchema),
  }),
  z.strictObject({ ...base, action: z.literal("role.created"), ...role }),
  z.strictObject({
    ...base,
    action: z.literal("role.permissions_changed"),
    ...role,
    previousPermissions: uniqueArray(domainPermissionSchema),
    newPermissions: uniqueArray(domainPermissionSchema),
  }),
  z.strictObject({ ...base, action: z.literal("role.archived"), ...role }),
  z.strictObject({ ...base, action: z.literal("team.created"), teamId: teamIdSchema }),
  z.strictObject({ ...base, action: z.literal("team.updated"), teamId: teamIdSchema }),
  z.strictObject({ ...base, action: z.literal("team.archived"), teamId: teamIdSchema }),
  z.strictObject({
    ...base,
    action: z.literal("season.created"),
    teamId: teamIdSchema,
    seasonId: seasonIdSchema,
  }),
  z.strictObject({
    ...base,
    action: z.literal("season.updated"),
    teamId: teamIdSchema,
    seasonId: seasonIdSchema,
  }),
  z.strictObject({
    ...base,
    action: z.literal("season.archived"),
    teamId: teamIdSchema,
    seasonId: seasonIdSchema,
  }),
]);
export type AuditEvent = z.infer<typeof auditEventSchema>;

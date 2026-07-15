import { z } from "zod";
import {
  entityMetadataSchema,
  localDateSchema,
  membershipIdSchema,
  participantIdSchema,
  personIdSchema,
  roleIdSchema,
  seasonIdSchema,
  teamIdSchema,
  uniqueArray,
} from "./primitives";

const metadata = entityMetadataSchema.shape;
export const domainPermissionSchema = z.enum([
  "team.read",
  "team.settings.manage",
  "season.read",
  "roster.read",
  "roster.manage",
  "memberships.manage",
  "roles.manage",
  "participant.read",
  "participant.manage",
]);
export type DomainPermission = z.infer<typeof domainPermissionSchema>;

export const teamSchema = z.strictObject({
  id: teamIdSchema,
  name: z.string().trim().min(1),
  status: z.enum(["active", "archived"]),
  ...metadata,
});
export type Team = z.infer<typeof teamSchema>;

export const seasonSchema = z
  .strictObject({
    id: seasonIdSchema,
    teamId: teamIdSchema,
    label: z.string().trim().min(1),
    startDate: localDateSchema,
    endDate: localDateSchema,
    timeZone: z.string().trim().min(1),
    status: z.enum(["active", "archived"]),
    ...metadata,
  })
  .refine((season) => season.endDate >= season.startDate, {
    message: "End date must not precede start date",
    path: ["endDate"],
  });
export type Season = z.infer<typeof seasonSchema>;

export const roleSchema = z.strictObject({
  id: roleIdSchema,
  teamId: teamIdSchema,
  seasonId: seasonIdSchema.optional(),
  kind: z.enum(["manager", "coach", "guardian", "participant", "custom"]),
  name: z.string().trim().min(1),
  permissions: uniqueArray(domainPermissionSchema),
  status: z.enum(["active", "archived"]),
  ...metadata,
});
export type Role = z.infer<typeof roleSchema>;

export const SYSTEM_ROLE_PERMISSIONS = {
  manager: domainPermissionSchema.options,
  coach: ["team.read", "season.read", "roster.read", "roster.manage", "participant.read"] as const,
  guardian: ["team.read", "season.read", "participant.read", "participant.manage"] as const,
  participant: ["team.read", "season.read", "participant.read"] as const,
} satisfies Record<Exclude<Role["kind"], "custom">, readonly DomainPermission[]>;

const memberReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), personId: personIdSchema }),
  z.strictObject({ kind: z.literal("participant"), participantId: participantIdSchema }),
]);
export const membershipSchema = z.strictObject({
  id: membershipIdSchema,
  teamId: teamIdSchema,
  seasonId: seasonIdSchema,
  member: memberReferenceSchema,
  roleIds: uniqueArray(roleIdSchema),
  status: z.enum(["invited", "active", "revoked"]),
  ...metadata,
});
export type Membership = z.infer<typeof membershipSchema>;

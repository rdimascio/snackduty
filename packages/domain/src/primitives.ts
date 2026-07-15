import { z } from "zod";

const id = <T extends string>(_name: T) => z.string().trim().min(1).brand<T>();

export const personIdSchema = id("PersonId");
export const accountIdSchema = id("AccountId");
export const householdIdSchema = id("HouseholdId");
export const participantIdSchema = id("ParticipantId");
export const guardianRelationshipIdSchema = id("GuardianRelationshipId");
export const teamIdSchema = id("TeamId");
export const seasonIdSchema = id("SeasonId");
export const membershipIdSchema = id("MembershipId");
export const roleIdSchema = id("RoleId");
export const auditEventIdSchema = id("AuditEventId");

export type PersonId = z.infer<typeof personIdSchema>;
export type AccountId = z.infer<typeof accountIdSchema>;
export type HouseholdId = z.infer<typeof householdIdSchema>;
export type ParticipantId = z.infer<typeof participantIdSchema>;
export type GuardianRelationshipId = z.infer<typeof guardianRelationshipIdSchema>;
export type TeamId = z.infer<typeof teamIdSchema>;
export type SeasonId = z.infer<typeof seasonIdSchema>;
export type MembershipId = z.infer<typeof membershipIdSchema>;
export type RoleId = z.infer<typeof roleIdSchema>;
export type AuditEventId = z.infer<typeof auditEventIdSchema>;

export const isoTimestampSchema = z.iso.datetime({ offset: true });
export const localDateSchema = z.iso.date();
export const lifecycleStatusSchema = z.enum(["active", "archived"]);
export const entityMetadataSchema = z.strictObject({
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export const uniqueArray = <T extends z.ZodType>(schema: T) =>
  z.array(schema).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "Values must be unique" });
    }
  });

import { z } from "zod";
import {
  accountIdSchema,
  entityMetadataSchema,
  guardianRelationshipIdSchema,
  householdIdSchema,
  localDateSchema,
  participantIdSchema,
  personIdSchema,
  uniqueArray,
} from "./primitives";

const metadata = entityMetadataSchema.shape;

export const personSchema = z.strictObject({
  id: personIdSchema,
  displayName: z.string().trim().min(1),
  status: z.enum(["active", "archived"]),
  ...metadata,
});
export type Person = z.infer<typeof personSchema>;

export const accountSchema = z.strictObject({
  id: accountIdSchema,
  personId: personIdSchema,
  status: z.enum(["active", "suspended", "closed"]),
  ...metadata,
});
export type Account = z.infer<typeof accountSchema>;

export const householdSchema = z.strictObject({
  id: householdIdSchema,
  name: z.string().trim().min(1),
  memberPersonIds: uniqueArray(personIdSchema).min(1),
  status: z.enum(["active", "archived"]),
  ...metadata,
});
export type Household = z.infer<typeof householdSchema>;

export const participantSchema = z.strictObject({
  id: participantIdSchema,
  personId: personIdSchema,
  birthDate: localDateSchema.optional(),
  status: z.enum(["active", "archived"]),
  ...metadata,
});
export type Participant = z.infer<typeof participantSchema>;

export const guardianRelationshipSchema = z.strictObject({
  id: guardianRelationshipIdSchema,
  guardianPersonId: personIdSchema,
  participantId: participantIdSchema,
  relationship: z.enum(["parent", "guardian", "caregiver", "other"]),
  status: z.enum(["active", "revoked"]),
  permissions: uniqueArray(z.enum(["participant.read", "participant.manage"])),
  ...metadata,
});
export type GuardianRelationship = z.infer<typeof guardianRelationshipSchema>;

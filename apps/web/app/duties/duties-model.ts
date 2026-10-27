export interface DutyAssignee {
  readonly personId: string;
  readonly displayName: string;
}

export interface DutySlotView {
  readonly id: string;
  readonly label: string;
  readonly instructions?: string;
  readonly assignee?: DutyAssignee;
}

export interface DutyOccurrenceView {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly whenLabel: string;
  readonly location?: string;
  readonly cancelled: boolean;
  readonly slots: readonly DutySlotView[];
}

export interface DutyAdultOption {
  readonly personId: string;
  readonly displayName: string;
}

export type DutiesBoardProps = {
  readonly teamId: string;
  readonly viewerPersonId: string;
  readonly canManage: boolean;
  readonly adults: readonly DutyAdultOption[];
  readonly occurrences: readonly DutyOccurrenceView[];
};

export interface MyDuty {
  readonly occurrenceId: string;
  readonly slotId: string;
  readonly label: string;
  readonly title: string;
  readonly whenLabel: string;
  readonly cancelled: boolean;
}

const SNACK_LABEL = /snack/i;

export function isSnackSlot(slot: Pick<DutySlotView, "label">): boolean {
  return SNACK_LABEL.test(slot.label);
}

export function sortSlotsSnacksFirst<T extends Pick<DutySlotView, "label">>(
  slots: readonly T[],
): T[] {
  return slots
    .map((slot, index) => ({ slot, index }))
    .sort(
      (left, right) =>
        Number(isSnackSlot(right.slot)) - Number(isSnackSlot(left.slot)) ||
        left.index - right.index,
    )
    .map(({ slot }) => slot);
}

export function myDuties(
  occurrences: readonly DutyOccurrenceView[],
  viewerPersonId: string,
): MyDuty[] {
  return occurrences.flatMap((occurrence) =>
    occurrence.slots
      .filter((slot) => slot.assignee?.personId === viewerPersonId)
      .map((slot) => ({
        occurrenceId: occurrence.id,
        slotId: slot.id,
        label: slot.label,
        title: occurrence.title,
        whenLabel: occurrence.whenLabel,
        cancelled: occurrence.cancelled,
      })),
  );
}

export function openSlotCount(occurrences: readonly DutyOccurrenceView[]): number {
  return occurrences.reduce(
    (total, occurrence) =>
      occurrence.cancelled
        ? total
        : total + occurrence.slots.filter((slot) => slot.assignee === undefined).length,
    0,
  );
}

export type DutyAction =
  | { readonly kind: "claim"; readonly occurrenceId: string; readonly slotId: string }
  | { readonly kind: "release"; readonly occurrenceId: string; readonly slotId: string }
  | {
      readonly kind: "add";
      readonly occurrenceId: string;
      readonly label: string;
      readonly instructions?: string;
    }
  | {
      readonly kind: "assign";
      readonly occurrenceId: string;
      readonly slotId: string;
      readonly assigneePersonId: string | null;
    };

export interface DutiesRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly body?: unknown;
}

export interface DutiesReply {
  readonly status: number;
  readonly json: unknown;
}

export type DutiesTransport = (request: DutiesRequest) => Promise<DutiesReply>;

export interface DutyActionResult {
  readonly ok: boolean;
  readonly message: string;
  readonly slots?: readonly DutySlotView[];
  readonly stale?: boolean;
}

const LIST_REFRESHED = "The list now shows the latest.";
const LIST_MAY_BE_STALE = "The list may be out of date.";

export const fetchTransport: DutiesTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    credentials: "same-origin",
    headers:
      request.body === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "Content-Type": "application/json" },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  let json: unknown;
  try {
    json = (await response.json()) as unknown;
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
};

function slotsPath(teamId: string, occurrenceId: string): string {
  return `/api/teams/${encodeURIComponent(teamId)}/occurrences/${encodeURIComponent(occurrenceId)}/duty-slots`;
}

function slotPath(teamId: string, occurrenceId: string, slotId: string, verb: string): string {
  return `${slotsPath(teamId, occurrenceId)}/${encodeURIComponent(slotId)}/${verb}`;
}

function requestFor(teamId: string, action: DutyAction): DutiesRequest {
  switch (action.kind) {
    case "claim":
      return { method: "POST", url: slotPath(teamId, action.occurrenceId, action.slotId, "claim") };
    case "release":
      return {
        method: "POST",
        url: slotPath(teamId, action.occurrenceId, action.slotId, "release"),
      };
    case "add":
      return {
        method: "POST",
        url: slotsPath(teamId, action.occurrenceId),
        body: {
          label: action.label,
          ...(action.instructions === undefined ? {} : { instructions: action.instructions }),
        },
      };
    case "assign":
      return {
        method: "POST",
        url: slotPath(teamId, action.occurrenceId, action.slotId, "assignment"),
        body: { assigneePersonId: action.assigneePersonId },
      };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAssignee(value: unknown): DutyAssignee | undefined {
  if (!isRecord(value)) return undefined;
  const { personId, displayName } = value as Partial<Record<keyof DutyAssignee, unknown>>;
  if (typeof personId !== "string" || typeof displayName !== "string") return undefined;
  return { personId, displayName };
}

function parseSlot(value: unknown): DutySlotView | undefined {
  if (!isRecord(value)) return undefined;
  const { id, label, instructions, assignee } = value as Partial<
    Record<keyof DutySlotView, unknown>
  >;
  if (typeof id !== "string" || typeof label !== "string") return undefined;
  if (instructions !== undefined && typeof instructions !== "string") return undefined;
  const parsedAssignee = assignee === undefined ? undefined : parseAssignee(assignee);
  if (assignee !== undefined && parsedAssignee === undefined) return undefined;
  return {
    id,
    label,
    ...(instructions === undefined ? {} : { instructions }),
    ...(parsedAssignee === undefined ? {} : { assignee: parsedAssignee }),
  };
}

export function parseDutySlots(value: unknown): DutySlotView[] | undefined {
  if (!isRecord(value)) return undefined;
  const { dutySlots } = value as { dutySlots?: unknown };
  if (!Array.isArray(dutySlots)) return undefined;
  const slots: DutySlotView[] = [];
  for (const entry of dutySlots) {
    const slot = parseSlot(entry);
    if (slot === undefined) return undefined;
    slots.push(slot);
  }
  return sortSlotsSnacksFirst(slots);
}

function parseDutySlotReply(value: unknown): DutySlotView | undefined {
  if (!isRecord(value)) return undefined;
  return parseSlot((value as { dutySlot?: unknown }).dutySlot);
}

export function mergeDutySlot(
  slots: readonly DutySlotView[],
  returned: DutySlotView,
): DutySlotView[] {
  const known = slots.some((slot) => slot.id === returned.id);
  return sortSlotsSnacksFirst(
    known ? slots.map((slot) => (slot.id === returned.id ? returned : slot)) : [...slots, returned],
  );
}

function serverCode(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  const { code } = json as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function holderName(slots: readonly DutySlotView[] | undefined, slotId: string): string {
  return slots?.find((slot) => slot.id === slotId)?.assignee?.displayName ?? "";
}

function slotLabel(slots: readonly DutySlotView[] | undefined, action: DutyAction): string {
  if (action.kind === "add") return action.label;
  return slots?.find((slot) => slot.id === action.slotId)?.label ?? "this duty";
}

function successMessage(
  action: DutyAction,
  label: string,
  slots: readonly DutySlotView[] | undefined,
  adults: readonly DutyAdultOption[],
): string {
  switch (action.kind) {
    case "claim":
      return `You claimed ${label}.`;
    case "release":
      return `You released ${label}. It is open again.`;
    case "add":
      return `Added ${label}.`;
    case "assign": {
      if (action.assigneePersonId === null) return `${label} is open again.`;
      const name =
        holderName(slots, action.slotId) ||
        adults.find((adult) => adult.personId === action.assigneePersonId)?.displayName ||
        "that adult";
      return `${name} now holds ${label}.`;
    }
  }
}

function failureMessage(
  action: DutyAction,
  status: number,
  code: string | undefined,
  label: string,
  slots: readonly DutySlotView[] | undefined,
): string {
  const listState = slots === undefined ? LIST_MAY_BE_STALE : LIST_REFRESHED;
  if (code === "duty_slot_taken") {
    const holder = action.kind === "add" ? "" : holderName(slots, action.slotId);
    return holder === ""
      ? `Someone else claimed ${label} first. ${listState}`
      : `${holder} claimed ${label} first. ${listState}`;
  }
  if (code === "duty_slot_changed") {
    return `${label} changed while you were looking. ${listState}`;
  }
  if (code === "event_occurrence_unavailable") {
    return "This event has started or was cancelled, so its duties are locked.";
  }
  if (status === 401) return "Your session ended. Sign in again to change duties.";
  if (status === 404) return "That duty or event is no longer available to you.";
  if (status === 400 || status === 422) return "Check the duty name and try again.";
  return "That change did not save. Try again.";
}

export async function refreshDutySlots(
  transport: DutiesTransport,
  teamId: string,
  occurrenceId: string,
): Promise<DutySlotView[] | undefined> {
  try {
    const reply = await transport({ method: "GET", url: slotsPath(teamId, occurrenceId) });
    return reply.status === 200 ? parseDutySlots(reply.json) : undefined;
  } catch {
    return undefined;
  }
}

export async function performDutyAction(
  transport: DutiesTransport,
  teamId: string,
  action: DutyAction,
  context: {
    readonly slots: readonly DutySlotView[];
    readonly adults: readonly DutyAdultOption[];
  },
): Promise<DutyActionResult> {
  let reply: DutiesReply | undefined;
  try {
    reply = await transport(requestFor(teamId, action));
  } catch {
    reply = undefined;
  }
  const label = slotLabel(context.slots, action);
  const ok = reply !== undefined && reply.status >= 200 && reply.status < 300;

  if (ok) {
    const returned = parseDutySlotReply(reply?.json);
    const slots =
      returned === undefined
        ? await refreshDutySlots(transport, teamId, action.occurrenceId)
        : mergeDutySlot(context.slots, returned);
    const message = successMessage(action, label, slots, context.adults);
    return slots === undefined
      ? { ok, message: `${message} ${LIST_MAY_BE_STALE}`, stale: true }
      : { ok, message, slots };
  }

  const status = reply?.status ?? 0;
  const raced = status === 404 || status === 409;
  const refreshed = raced
    ? await refreshDutySlots(transport, teamId, action.occurrenceId)
    : undefined;
  const code = reply === undefined ? undefined : serverCode(reply.json);
  const message = failureMessage(action, status, code, label, refreshed);
  if (!raced) return { ok, message };
  if (refreshed !== undefined) return { ok, message, slots: refreshed };
  return {
    ok,
    message: message.endsWith(LIST_MAY_BE_STALE) ? message : `${message} ${LIST_MAY_BE_STALE}`,
    stale: true,
  };
}

const NON_ALPHANUMERIC = /[^A-Za-z0-9]/gu;

export function seedEventIdStem(participantId: string): string {
  const key = participantId.replaceAll(NON_ALPHANUMERIC, "");
  return `evt_${key.length}L${key}`;
}

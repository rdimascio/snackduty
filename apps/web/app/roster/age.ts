const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

function dateParts(date: string): readonly [number, number, number] | undefined {
  const match = ISO_DATE.exec(date);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function ageOn(birthDate: string, today: string): number | undefined {
  const born = dateParts(birthDate);
  const now = dateParts(today);
  if (born === undefined || now === undefined) return undefined;
  const [bornYear, bornMonth, bornDay] = born;
  const [year, month, day] = now;
  const hadBirthday = month > bornMonth || (month === bornMonth && day >= bornDay);
  const age = year - bornYear - (hadBirthday ? 0 : 1);
  return age < 0 ? undefined : age;
}

export function localDateIn(instant: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(instant));
  } catch {
    return new Date(instant).toISOString().slice(0, 10);
  }
}

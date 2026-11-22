export const COACH_BOOK_PATH = "/book";

export const COACH_BOOK_SENT_PATH = "/book/sent";

/** Renders a rejected post on the coach site only; the brand router never forwards it. */
export const COACH_BOOK_RETRY_PATH = "/__coach/book-retry";

export const coachTitle = "DiMascio Baseball";

export const COACH_ORIGIN = "https://dimasciobaseball.com";

export const COACH_LEARN_URL = "https://learn.dimasciobaseball.com/";

export const coachTagline = "Private baseball lessons in Orange County.";

export const COACH_NAME = "Coach Ryan";

export const COACH_AREA_SERVED = "Orange County, CA";

export interface CoachPersonSchema {
  readonly "@type": "Person";
  readonly name: string;
}

export interface CoachBusinessSchema {
  readonly "@type": "SportsActivityLocation";
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly areaServed: string;
  readonly founder: CoachPersonSchema;
  readonly employee: CoachPersonSchema;
}

export const coachPersonSchema: CoachPersonSchema = { "@type": "Person", name: COACH_NAME };

/** Only facts the site already states; no address, phone, price, rating, hours or geo. */
export const coachBusinessSchema: CoachBusinessSchema = {
  "@type": "SportsActivityLocation",
  name: coachTitle,
  url: `${COACH_ORIGIN}/`,
  description: coachTagline,
  areaServed: COACH_AREA_SERVED,
  founder: coachPersonSchema,
  employee: coachPersonSchema,
};

export const PLAYER_AGE_MIN = 5;

export const PLAYER_AGE_MAX = 14;

export const playerAgeRange = `${PLAYER_AGE_MIN} to ${PLAYER_AGE_MAX}`;

export const LESSON_TYPE_IDS = ["private", "small-group", "team-clinic"] as const;

export type LessonTypeId = (typeof LESSON_TYPE_IDS)[number];

export interface LessonType {
  readonly id: LessonTypeId;
  readonly name: string;
  readonly who: string;
  readonly detail: string;
}

export const lessonTypes: readonly LessonType[] = [
  {
    id: "private",
    name: "Private lesson",
    who: "One player",
    detail: "Hitting, throwing, fielding or catching, built around what your player needs next.",
  },
  {
    id: "small-group",
    name: "Small group",
    who: "Two to four players",
    detail: "Siblings or teammates train together. Good reps, and a little friendly competition.",
  },
  {
    id: "team-clinic",
    name: "Team clinic",
    who: "A whole team",
    detail: "A practice plan and a run clinic for your rec or travel team, at your field.",
  },
];

import type { ReactNode } from "react";

import { defineIsland } from "@lesto/ui";

import { LessonAnswers, LessonAnswersShell } from "../lessons/lesson-answers";
import type { LessonAnswersProps } from "../lessons/lesson-answers";

function LessonAnswersIsland(props: LessonAnswersProps): ReactNode {
  return <LessonAnswers {...props} />;
}

export default defineIsland({
  component: LessonAnswersIsland,
  fallback: LessonAnswersShell,
  name: "LessonAnswers",
});

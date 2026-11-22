import type { ReactNode } from "react";

import { JSON_LD_TYPE, jsonLdText } from "./structured-data";
import type { CoachJsonLd } from "./structured-data";

export function JsonLd({ value }: { value: CoachJsonLd }): ReactNode {
  return <script dangerouslySetInnerHTML={{ __html: jsonLdText(value) }} type={JSON_LD_TYPE} />;
}

import { articlePath } from "./articles";
import type { CoachArticle } from "./articles";
import { COACH_ORIGIN, coachBusinessSchema, coachPersonSchema } from "./content";
import type { CoachBusinessSchema, CoachPersonSchema } from "./content";

export const JSON_LD_TYPE = "application/ld+json";

const SCHEMA_CONTEXT = "https://schema.org";

const LESS_THAN = /</gu;

const ESCAPED_LESS_THAN = "\\u003c";

export interface CoachBusinessJsonLd extends CoachBusinessSchema {
  readonly "@context": typeof SCHEMA_CONTEXT;
}

export interface CoachArticleJsonLd {
  readonly "@context": typeof SCHEMA_CONTEXT;
  readonly "@type": "Article";
  readonly headline: string;
  readonly description: string;
  readonly datePublished: string;
  readonly url: string;
  readonly author: CoachPersonSchema;
  readonly publisher: CoachBusinessSchema;
}

export type CoachJsonLd = CoachBusinessJsonLd | CoachArticleJsonLd;

export function coachBusinessJsonLd(): CoachBusinessJsonLd {
  return { "@context": SCHEMA_CONTEXT, ...coachBusinessSchema };
}

export function coachArticleJsonLd(article: CoachArticle): CoachArticleJsonLd {
  return {
    "@context": SCHEMA_CONTEXT,
    "@type": "Article",
    headline: article.title,
    description: article.description,
    datePublished: article.published,
    url: `${COACH_ORIGIN}${articlePath(article)}`,
    author: coachPersonSchema,
    publisher: coachBusinessSchema,
  };
}

/** JSON whose every `<` is `<`, so the text can never close the script element it sits in. */
export function jsonLdText(value: CoachJsonLd): string {
  return JSON.stringify(value).replace(LESS_THAN, ESCAPED_LESS_THAN);
}

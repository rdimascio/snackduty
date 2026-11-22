import { Fragment } from "react";
import type { ReactNode } from "react";

import type { Context } from "@lesto/web";

import { articlePath, COACH_ARTICLE_PATH, COACH_ARTICLES_PATH, episodeUrl } from "./articles";
import type {
  ArticleData,
  ArticleListData,
  CoachArticle,
  CoachArticleLibrary,
  CoachArticlePages,
} from "./articles";
import { COACH_BOOK_PATH, COACH_ORIGIN, coachTitle } from "./content";
import type { MarkdownBlock, MarkdownInline } from "./markdown";
import { CoachShell } from "./shell";

const articlesTitle = "Guides for parents";

const articlesDescription =
  "Plain guides for parents of young baseball players in Orange County: gear, first seasons, and drills at home.";

const headingClass =
  "mt-6 font-display text-5xl font-extrabold uppercase leading-[0.9] tracking-tight";

const buttonClass =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-clay px-6 py-2 text-sm font-bold tracking-[0.2em] text-ink uppercase transition-colors hover:bg-clay/90";

const linkClass = "font-bold text-clay underline underline-offset-4";

const publishedFormat = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeZone: "UTC",
});

function publishedLabel(published: string): string {
  return publishedFormat.format(new Date(`${published}T00:00:00Z`));
}

function InlineText({ nodes }: { nodes: readonly MarkdownInline[] }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return <Fragment key={index}>{node.text}</Fragment>;
      case "strong":
        return (
          <strong key={index}>
            <InlineText nodes={node.children} />
          </strong>
        );
      case "emphasis":
        return (
          <em key={index}>
            <InlineText nodes={node.children} />
          </em>
        );
      case "link":
        return (
          <a className={linkClass} href={node.href} key={index}>
            <InlineText nodes={node.children} />
          </a>
        );
    }
  });
}

function Block({ block }: { block: MarkdownBlock }): ReactNode {
  switch (block.kind) {
    case "heading":
      return block.level === 2 ? (
        <h2 className="mt-10 font-display text-2xl font-bold uppercase tracking-tight">
          <InlineText nodes={block.children} />
        </h2>
      ) : (
        <h3 className="mt-8 text-lg font-bold">
          <InlineText nodes={block.children} />
        </h3>
      );
    case "paragraph":
      return (
        <p className="mt-4 text-lg leading-relaxed">
          <InlineText nodes={block.children} />
        </p>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <InlineText nodes={item} />
        </li>
      ));
      return block.ordered ? (
        <ol className="mt-4 list-decimal space-y-2 pl-6 text-lg leading-relaxed">{items}</ol>
      ) : (
        <ul className="mt-4 list-disc space-y-2 pl-6 text-lg leading-relaxed">{items}</ul>
      );
    }
  }
}

function ArticleList({ articles }: ArticleListData): ReactNode {
  return (
    <CoachShell>
      <h1 className={headingClass}>{articlesTitle}</h1>
      <p className="mt-6 text-muted">{articlesDescription}</p>
      {articles.length === 0 ? (
        <p className="mt-10 text-muted">New guides are on the way.</p>
      ) : (
        <ul className="mt-10 grid gap-6">
          {articles.map((article) => (
            <li className="rounded-lg border border-line p-6" key={article.slug}>
              <h2 className="text-xl font-bold">
                <a className="hover:text-clay" href={articlePath(article)}>
                  {article.title}
                </a>
              </h2>
              <p className="mt-2 text-sm text-muted">
                <time dateTime={article.published}>{publishedLabel(article.published)}</time>
              </p>
              <p className="mt-4 text-muted">{article.description}</p>
            </li>
          ))}
        </ul>
      )}
      <a className={`mt-10 ${buttonClass}`} href={COACH_BOOK_PATH}>
        Request a lesson
      </a>
    </CoachShell>
  );
}

function EpisodeLink({ episode }: { episode: string }): ReactNode {
  return (
    <aside className="mt-10 rounded-lg border border-line p-6">
      <h2 className="font-display text-2xl font-bold uppercase tracking-tight">
        Watch with your player
      </h2>
      <p className="mt-2 text-muted">A short Coach Blooper cartoon on the same idea.</p>
      <a className={`mt-4 inline-block ${linkClass}`} href={episodeUrl(episode)}>
        Watch the episode
      </a>
    </aside>
  );
}

function ArticlePage({ article }: ArticleData): ReactNode {
  return (
    <CoachShell>
      <article>
        <p className="mt-6 text-sm">
          <a className={linkClass} href={COACH_ARTICLES_PATH}>
            {articlesTitle}
          </a>
        </p>
        <h1 className={headingClass}>{article.title}</h1>
        <p className="mt-4 text-sm text-muted">
          <time dateTime={article.published}>{publishedLabel(article.published)}</time>
        </p>
        <p className="mt-6 text-xl text-muted">{article.description}</p>
        {article.body.map((block, index) => (
          <Block block={block} key={index} />
        ))}
      </article>
      {article.episode === undefined ? null : <EpisodeLink episode={article.episode} />}
      <section className="mt-10 rounded-lg border border-line p-6">
        <h2 className="font-display text-2xl font-bold uppercase tracking-tight">
          Want some help?
        </h2>
        <p className="mt-2 text-muted">I teach private and small group lessons in Orange County.</p>
        <a className={`mt-6 ${buttonClass}`} href={COACH_BOOK_PATH}>
          Request a lesson
        </a>
      </section>
    </CoachShell>
  );
}

function summary({ body: _body, ...rest }: CoachArticle): Omit<CoachArticle, "body"> {
  return rest;
}

function servedArticle(
  library: CoachArticleLibrary,
  c: Context<typeof COACH_ARTICLE_PATH>,
): CoachArticle {
  const article = library.find(c.param("slug"));
  if (article === undefined)
    throw new Error("The brand router forwards only served article slugs.");
  return article;
}

export function coachArticlePages(library: CoachArticleLibrary): CoachArticlePages {
  return {
    list: {
      component: ArticleList,
      load: () => ({ articles: library.articles.map((article) => summary(article)) }),
      metadata: () => ({
        title: `${articlesTitle} | ${coachTitle}`,
        description: articlesDescription,
        links: [{ rel: "canonical", href: `${COACH_ORIGIN}${COACH_ARTICLES_PATH}` }],
      }),
    },
    article: {
      component: ArticlePage,
      load: (c) => ({ article: servedArticle(library, c) }),
      metadata: ({ article }) => ({
        title: `${article.title} | ${coachTitle}`,
        description: article.description,
        links: [{ rel: "canonical", href: `${COACH_ORIGIN}${articlePath(article)}` }],
      }),
    },
  };
}

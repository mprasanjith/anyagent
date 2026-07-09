import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";

import { docsContentRoute, docsImageRoute, docsRoute } from "./shared";

export const source = loader({
  baseUrl: docsRoute,
  plugins: [lucideIconsPlugin()],
  source: docs.toFumadocsSource(),
});

type Page = (typeof source)["$inferPage"];

const pageAsset = (page: Page, route: string, file: string) => {
  const segments = [...page.slugs, file];

  return {
    segments,
    url: `${route}/${segments.join("/")}`,
  };
};

export const getPageImage = (page: Page) =>
  pageAsset(page, docsImageRoute, "image.png");

export const getPageMarkdownUrl = (page: Page) =>
  pageAsset(page, docsContentRoute, "content.md");

export const getLLMText = async (page: Page) => {
  const processed = await page.data.getText("processed");

  return `# ${page.data.title} (${page.url})

${processed}`;
};

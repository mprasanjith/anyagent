import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";

import { docsContentRoute, docsImageRoute, docsRoute } from "./shared";

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  plugins: [lucideIconsPlugin()],
  source: docs.toFumadocsSource(),
});

export const getPageImage = (page: (typeof source)["$inferPage"]) => {
  const segments = [...page.slugs, "image.png"];

  return {
    segments,
    url: `${docsImageRoute}/${segments.join("/")}`,
  };
};

export const getPageMarkdownUrl = (page: (typeof source)["$inferPage"]) => {
  const segments = [...page.slugs, "content.md"];

  return {
    segments,
    url: `${docsContentRoute}/${segments.join("/")}`,
  };
};

export const getLLMText = async (page: (typeof source)["$inferPage"]) => {
  const processed = await page.data.getText("processed");

  return `# ${page.data.title} (${page.url})

${processed}`;
};

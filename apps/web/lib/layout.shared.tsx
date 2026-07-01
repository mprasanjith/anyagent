import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { appName, gitConfig } from "./shared";

export const baseOptions = (): BaseLayoutProps => ({
  githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  nav: {
    title: appName,
  },
});

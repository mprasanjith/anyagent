import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    "**/dist",
    "**/test/fixtures",
    "**/.next",
    "**/.source",
    "**/.turbo",
  ],
});

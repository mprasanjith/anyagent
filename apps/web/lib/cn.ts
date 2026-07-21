import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge cannot tell a custom text size (text-hm-label) from a custom
// text color (text-hm-accent) by name alone; without this split it treats
// them as one conflicting group and drops whichever comes first.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: ["hm-label", "hm-sm", "hm-md", "hm-lg", "hm-2xl", "hm-display"],
        },
      ],
      "text-color": [
        {
          text: [
            "hm-paper",
            "hm-paper-2",
            "hm-ink",
            "hm-ink-2",
            "hm-muted",
            "hm-rule",
            "hm-rule-2",
            "hm-accent",
            "hm-accent-ink",
            "hm-focus",
          ],
        },
      ],
    },
  },
});

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));

import { TypeTable } from "fumadocs-ui/components/type-table";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { CapabilityMatrix } from "@/components/capability-matrix";
import { SupportedBy } from "@/components/supported-by";

export const getMDXComponents = (components?: MDXComponents) =>
  ({
    ...defaultMdxComponents,
    CapabilityMatrix,
    SupportedBy,
    TypeTable,
    ...components,
  }) satisfies MDXComponents;

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}

import { isMarkdownPreferred, rewritePath } from "fumadocs-core/negotiation";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { docsContentRoute, docsRoute } from "@/lib/shared";

const { rewrite: rewriteDocs } = rewritePath(
  `${docsRoute}{/*path}`,
  `${docsContentRoute}{/*path}/content.md`
);
const { rewrite: rewriteSuffix } = rewritePath(
  `${docsRoute}{/*path}.md`,
  `${docsContentRoute}{/*path}/content.md`
);

const proxy = (request: NextRequest) => {
  const suffixTarget = rewriteSuffix(request.nextUrl.pathname);
  if (suffixTarget) {
    return NextResponse.rewrite(new URL(suffixTarget, request.nextUrl));
  }

  if (isMarkdownPreferred(request)) {
    const docsTarget = rewriteDocs(request.nextUrl.pathname);

    if (docsTarget) {
      return NextResponse.rewrite(new URL(docsTarget, request.nextUrl));
    }
  }

  return NextResponse.next();
};

export default proxy;

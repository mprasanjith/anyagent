import { getLLMText, source } from "@/lib/source";

export const revalidate = false;

export const GET = async () => {
  const pages = await Promise.all(source.getPages().map(getLLMText));

  return new Response(pages.join("\n\n"));
};

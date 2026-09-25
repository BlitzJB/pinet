import { memo, useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

/** Memoised so re-renders elsewhere in the transcript don't re-parse markdown. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const rendered = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
  }, [text]);
  return <div className="md text-[15px] leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />;
});

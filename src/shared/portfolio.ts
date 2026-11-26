// The link a generated work-samples PDF carries (background/yolo/index.ts PORTFOLIO_PDF, content's portfolio upload).
import type { Profile } from "./profileSchema";

/**
 * The Profile's portfolio site, else its website, else its GitHub (a code repository also answers "portfolio site or
 * code repository"), as an absolute http(s) URL; null when none is set or it isn't a web address.
 */
export function portfolioLink(links: Profile["personal"]["links"]): { label: string; url: string } | null {
  const [label, raw] = links.portfolio.trim()
    ? ["Portfolio", links.portfolio]
    : links.website.trim()
      ? ["Website", links.website]
      : ["GitHub", links.github];
  const t = raw.trim();
  if (!t) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    return /^https?:$/.test(u.protocol) && u.hostname.includes(".") ? { label, url: u.href } : null;
  } catch {
    return null;
  }
}

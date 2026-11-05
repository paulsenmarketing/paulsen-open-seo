import { CrawlerCredentialService } from "@/server/features/audit/services/CrawlerCredentialService";
import { readSitemaps } from "@/server/features/sitemap-export/readSitemaps";
import {
  normalizeAndValidateStartUrl,
  resolveStartUrlRedirects,
} from "@/server/lib/audit/url-policy";

async function exportSitemap(input: {
  organizationId: string;
  projectId: string;
  url: string;
}) {
  const startUrl = await normalizeAndValidateStartUrl(input.url);
  // The project's saved crawler access, as an audit of this host would use, so
  // bot-protected stores serve their sitemaps here too.
  const credential = await CrawlerCredentialService.resolveCrawlerAccess(
    input.organizationId,
    input.projectId,
    new URL(startUrl).hostname,
  );
  const access = await CrawlerCredentialService.openCrawlerAccess(
    credential?.sealed,
  );
  // A domain that redirects elsewhere (apex to www, .net to .com) keeps its
  // sitemaps on the origin it lands on.
  const { url } = await resolveStartUrlRedirects(startUrl, access);
  return readSitemaps(url, access);
}

export const SitemapExportService = { exportSitemap };

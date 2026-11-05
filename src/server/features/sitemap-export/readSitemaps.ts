/**
 * Reads a site's sitemaps for the CSV export.
 *
 * The crawler's discoverUrls can't serve this: it keeps only normalized URLs
 * (no lastmod, tracking params stripped) and only logs the sitemaps it failed
 * to read. An export has to report what the sitemap says and say when it is
 * incomplete. The fetching itself is the crawler's, so the same redirect and
 * SSRF rules apply.
 */
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import {
  createRateLimitWait,
  type RateLimitWait,
} from "@/server/lib/audit/crawl-throttle";
import {
  fetchFollowingRedirects,
  fetchRobotsTxtText,
  isProbablySitemapXml,
  parseRobotsTxt,
} from "@/server/lib/audit/discovery";
import { readBodyCapped } from "@/server/lib/audit/html-response";
import { isCrawlableUrl } from "@/server/lib/audit/url-policy";
import { isSameOrigin } from "@/server/lib/audit/url-utils";
import type { CrawlerAccess } from "@/shared/crawler-access";
import {
  SITEMAP_EXPORT_MAX_FILES,
  SITEMAP_EXPORT_MAX_URLS,
} from "@/types/schemas/sitemapExport";

const MAX_NESTING_DEPTH = 3;
const CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_SITEMAP_BYTES = 10 * 1024 * 1024;

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  // Keep values as written: the default turns a priority of "1.0" into 1.
  parseTagValue: false,
  isArray: (name) => name === "sitemap" || name === "url",
});

const optionalText = z.string().optional().catch(undefined);
const entrySchema = z.object({
  loc: z.string(),
  lastmod: optionalText,
  changefreq: optionalText,
  priority: optionalText,
});
// An empty <urlset/> parses to a string.
const documentSchema = z.object({
  urlset: z
    .union([z.object({ url: z.array(z.unknown()).optional() }), z.string()])
    .optional(),
  sitemapindex: z
    .union([z.object({ sitemap: z.array(z.unknown()).optional() }), z.string()])
    .optional(),
});

type SitemapEntry = {
  url: string;
  lastModified: string | null;
  changeFrequency: string | null;
  priority: string | null;
  sitemap: string;
};

type SitemapDocument = {
  finalUrl: string;
  entries: SitemapEntry[];
  nestedSitemaps: string[];
};

function httpUrl(location: string, base: string): string | null {
  try {
    const parsed = new URL(location.trim(), base);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function presentText(value: string | undefined): string | null {
  return value?.trim() || null;
}

/**
 * A sitemap served as a .gz file. Content-Encoding is left out because fetch
 * has already decoded those. The byte cap then applies to the decompressed
 * size, so a small file can't expand past it.
 */
function decompressGzipFile(response: Response, url: string): Response {
  const isGzipFile =
    new URL(url).pathname.toLowerCase().endsWith(".gz") ||
    response.headers.get("content-type")?.toLowerCase().includes("gzip");
  if (
    !response.body ||
    !isGzipFile ||
    response.headers.has("content-encoding")
  ) {
    return response;
  }
  return new Response(
    response.body.pipeThrough(new DecompressionStream("gzip")),
    { headers: response.headers },
  );
}

function parseSitemapDocument(
  body: string,
  finalUrl: string,
): SitemapDocument | null {
  const document = documentSchema.safeParse(xmlParser.parse(body));
  if (!document.success) return null;
  const { urlset, sitemapindex } = document.data;
  if (urlset === undefined && sitemapindex === undefined) return null;

  const rawEntries = typeof urlset === "object" ? (urlset.url ?? []) : [];
  const rawNested =
    typeof sitemapindex === "object" ? (sitemapindex.sitemap ?? []) : [];

  const entries: SitemapEntry[] = [];
  for (const raw of rawEntries) {
    const entry = entrySchema.safeParse(raw);
    const url = entry.success ? httpUrl(entry.data.loc, finalUrl) : null;
    if (!entry.success || !url) continue;
    entries.push({
      url,
      lastModified: presentText(entry.data.lastmod),
      changeFrequency: presentText(entry.data.changefreq),
      priority: presentText(entry.data.priority),
      sitemap: finalUrl,
    });
  }

  const nestedSitemaps: string[] = [];
  for (const raw of rawNested) {
    const nested = entrySchema.safeParse(raw);
    const url = nested.success ? httpUrl(nested.data.loc, finalUrl) : null;
    if (url) nestedSitemaps.push(url);
  }

  return { finalUrl, entries, nestedSitemaps };
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/** One sitemap file, or why it couldn't be read. */
async function readSitemapFile(
  url: string,
  access: CrawlerAccess | null | undefined,
  waitForRateLimit: RateLimitWait,
): Promise<SitemapDocument | { problem: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const fetched = await fetchFollowingRedirects(
        url,
        FETCH_TIMEOUT_MS,
        access,
      );
      if (!fetched) return { problem: "Redirect could not be followed" };
      const { response, finalUrl } = fetched;

      if (!isSameOrigin(finalUrl, url)) {
        await response.body?.cancel();
        return { problem: "Redirects to another host" };
      }
      if (
        response.status === 429 &&
        attempt === 0 &&
        (await waitForRateLimit(response))
      ) {
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { problem: `HTTP ${response.status}` };
      }

      const body = await readBodyCapped(
        decompressGzipFile(response, finalUrl),
        MAX_SITEMAP_BYTES,
      );
      if (body === null) return { problem: "Larger than 10 MB" };
      const document = isProbablySitemapXml(
        response.headers.get("content-type"),
        body,
      )
        ? parseSitemapDocument(body, finalUrl)
        : null;
      return document ?? { problem: "Not a sitemap" };
    } catch (error) {
      if (isTimeout(error) && attempt === 0) continue;
      console.warn(`Could not read sitemap ${url}:`, error);
      return { problem: isTimeout(error) ? "Timed out" : "Could not be read" };
    }
  }
}

type QueuedSitemap = {
  url: string;
  depth: number;
  /** The /sitemap.xml guess: a site without one has nothing missing. */
  guessed: boolean;
};

export async function readSitemaps(
  startUrl: string,
  access?: CrawlerAccess | null,
) {
  const waitForRateLimit = createRateLimitWait();
  const start = new URL(startUrl);
  const origin = start.origin;

  const entries = new Map<string, SitemapEntry>();
  const readFiles = new Set<string>();
  const unreadSitemaps: { url: string; reason: string }[] = [];
  const queuedUrls = new Set<string>();
  const queue: QueuedSitemap[] = [];
  let stoppedAtLimit = false;

  const enqueue = (url: string, depth: number, guessed = false) => {
    if (queuedUrls.has(url)) return;
    queuedUrls.add(url);
    if (!isCrawlableUrl(url) || !isSameOrigin(url, origin)) {
      unreadSitemaps.push({ url, reason: "On another host" });
    } else if (depth <= 0) {
      unreadSitemaps.push({ url, reason: "Nested too deeply" });
    } else {
      queue.push({ url, depth, guessed });
    }
  };

  // A pasted sitemap URL exports that sitemap alone.
  if (/\.xml(\.gz)?$/i.test(start.pathname)) {
    enqueue(start.href, MAX_NESTING_DEPTH);
  } else {
    const robotsText = await fetchRobotsTxtText(
      origin,
      access,
      waitForRateLimit,
    );
    for (const declared of parseRobotsTxt(origin, robotsText).sitemapUrls) {
      const url = httpUrl(declared, origin);
      if (url) enqueue(url, MAX_NESTING_DEPTH);
    }
    enqueue(`${origin}/sitemap.xml`, MAX_NESTING_DEPTH, true);
  }

  let filesFetched = 0;
  while (queue.length > 0) {
    if (
      filesFetched >= SITEMAP_EXPORT_MAX_FILES ||
      entries.size >= SITEMAP_EXPORT_MAX_URLS
    ) {
      stoppedAtLimit = true;
      break;
    }
    const batch = queue.splice(
      0,
      Math.min(CONCURRENCY, SITEMAP_EXPORT_MAX_FILES - filesFetched),
    );
    filesFetched += batch.length;
    const results = await Promise.all(
      batch.map(({ url }) => readSitemapFile(url, access, waitForRateLimit)),
    );

    results.forEach((result, index) => {
      const source = batch[index];
      if ("problem" in result) {
        if (!source.guessed) {
          unreadSitemaps.push({ url: source.url, reason: result.problem });
        }
        return;
      }
      readFiles.add(result.finalUrl);
      for (const entry of result.entries) {
        if (entries.has(entry.url)) continue;
        if (entries.size >= SITEMAP_EXPORT_MAX_URLS) {
          stoppedAtLimit = true;
          break;
        }
        entries.set(entry.url, entry);
      }
      for (const nested of result.nestedSitemaps) {
        enqueue(nested, source.depth - 1);
      }
    });
  }

  return {
    origin,
    entries: Array.from(entries.values()),
    sitemapsRead: readFiles.size,
    unreadSitemaps,
    stoppedAtLimit,
  };
}

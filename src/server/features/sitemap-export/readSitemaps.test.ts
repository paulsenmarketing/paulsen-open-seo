import { afterEach, describe, expect, it, vi } from "vitest";
import { readSitemaps } from "@/server/features/sitemap-export/readSitemaps";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const XML_HEADERS = { "content-type": "application/xml" };

function urlset(entries: string): string {
  return `<?xml version="1.0"?><urlset>${entries}</urlset>`;
}

/** Serves `site`, keyed by URL; anything else is a 404. */
function serve(site: Record<string, () => Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(site[url]?.() ?? new Response("", { status: 404 })),
    ),
  );
}

describe("readSitemaps", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // What separates this from crawl discovery: every field as the sitemap wrote
  // it. The XML parser's defaults would turn a priority of "1.0" into 1, and
  // the crawler's URL normalization would drop the utm parameter.
  it("reports each entry as the sitemap wrote it", async () => {
    serve({
      "https://example.com/sitemap.xml": () =>
        new Response(
          urlset(
            `<url><loc>https://example.com/a?utm_source=x&amp;b=1</loc><lastmod>2026-01-02</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>
             <url><loc>https://example.com/b</loc></url>`,
          ),
          { headers: XML_HEADERS },
        ),
    });

    const result = await readSitemaps("https://example.com/");

    expect(result.entries).toEqual([
      {
        url: "https://example.com/a?utm_source=x&b=1",
        lastModified: "2026-01-02",
        changeFrequency: "daily",
        priority: "1.0",
        sitemap: "https://example.com/sitemap.xml",
      },
      {
        url: "https://example.com/b",
        lastModified: null,
        changeFrequency: null,
        priority: null,
        sitemap: "https://example.com/sitemap.xml",
      },
    ]);
  });

  // A silently short export is the failure that matters: someone relying on
  // the CSV can't tell a shard is missing unless it says so.
  it("names the sitemaps it could not read and keeps the rest", async () => {
    serve({
      "https://example.com/robots.txt": () =>
        new Response(
          "Sitemap: https://example.com/index.xml\nSitemap: https://cdn.example.net/other.xml",
        ),
      "https://example.com/index.xml": () =>
        new Response(
          `<sitemapindex>
             <sitemap><loc>https://example.com/good.xml</loc></sitemap>
             <sitemap><loc>https://example.com/gone.xml</loc></sitemap>
           </sitemapindex>`,
          { headers: XML_HEADERS },
        ),
      "https://example.com/good.xml": () =>
        new Response(urlset("<url><loc>https://example.com/a</loc></url>"), {
          headers: XML_HEADERS,
        }),
    });

    const result = await readSitemaps("https://example.com/");

    expect(result.entries.map((entry) => entry.url)).toEqual([
      "https://example.com/a",
    ]);
    expect(result.sitemapsRead).toBe(2);
    expect(result.unreadSitemaps).toEqual([
      { url: "https://cdn.example.net/other.xml", reason: "On another host" },
      { url: "https://example.com/gone.xml", reason: "HTTP 404" },
    ]);
  });

  // /sitemap.xml is our guess, not something the site promised.
  it("does not report a missing /sitemap.xml as unread", async () => {
    serve({});

    const result = await readSitemaps("https://example.com/");

    expect(result.entries).toEqual([]);
    expect(result.unreadSitemaps).toEqual([]);
  });

  it("reads a gzipped sitemap", async () => {
    const gzipped = new Response(
      new Blob([urlset("<url><loc>https://example.com/zipped</loc></url>")])
        .stream()
        .pipeThrough(new CompressionStream("gzip")),
    );
    const bytes = await gzipped.arrayBuffer();
    serve({
      "https://example.com/sitemap.xml.gz": () =>
        new Response(bytes, {
          headers: { "content-type": "application/x-gzip" },
        }),
    });

    const result = await readSitemaps("https://example.com/sitemap.xml.gz");

    expect(result.entries.map((entry) => entry.url)).toEqual([
      "https://example.com/zipped",
    ]);
  });

  it("does not fetch a sitemap that fails the crawl policy", async () => {
    serve({
      "https://example.com/robots.txt": () =>
        new Response("Sitemap: http://169.254.169.254/latest/meta-data.xml"),
    });

    const result = await readSitemaps("https://example.com/");

    expect(fetch).not.toHaveBeenCalledWith(
      "http://169.254.169.254/latest/meta-data.xml",
      expect.anything(),
    );
    expect(result.unreadSitemaps).toEqual([
      {
        url: "http://169.254.169.254/latest/meta-data.xml",
        reason: "On another host",
      },
    ]);
  });
});

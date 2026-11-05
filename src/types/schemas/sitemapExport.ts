import { z } from "zod";

export const SITEMAP_EXPORT_MAX_URLS = 50_000;
export const SITEMAP_EXPORT_MAX_FILES = 300;

export const exportSitemapSchema = z.object({
  projectId: z.string().min(1),
  url: z.string().min(1, "URL is required").max(2048),
});

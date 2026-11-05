import { createServerFn } from "@tanstack/react-start";
import { SitemapExportService } from "@/server/features/sitemap-export/SitemapExportService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { exportSitemapSchema } from "@/types/schemas/sitemapExport";

export const exportSitemap = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(exportSitemapSchema)
  .handler(async ({ data, context }) => {
    return SitemapExportService.exportSitemap({
      organizationId: context.organizationId,
      projectId: context.projectId,
      url: data.url,
    });
  });

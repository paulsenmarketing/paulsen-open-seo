import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/client/components/ui/card";
import { Input } from "@/client/components/ui/input";
import { projectsQueryOptions } from "@/client/features/projects/projectQueries";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { exportRows } from "@/client/lib/exportRows";
import { exportSitemap } from "@/serverFunctions/sitemapExport";
import {
  SITEMAP_EXPORT_MAX_FILES,
  SITEMAP_EXPORT_MAX_URLS,
} from "@/types/schemas/sitemapExport";

type SitemapExport = Awaited<ReturnType<typeof exportSitemap>>;

const HEADERS = [
  "URL",
  "Last Modified",
  "Change Frequency",
  "Priority",
  "Sitemap",
];
const UNREAD_SITEMAPS_SHOWN = 5;

function downloadCsv(result: SitemapExport) {
  void exportRows({
    format: "csv",
    feature: "sitemap_export",
    headers: HEADERS,
    rows: result.entries.map((entry) => [
      entry.url,
      entry.lastModified,
      entry.changeFrequency,
      entry.priority,
      entry.sitemap,
    ]),
    filename: `sitemap-${new URL(result.origin).hostname}`,
  });
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

export function SitemapExportCard({ projectId }: { projectId: string }) {
  const projects = useQuery(projectsQueryOptions());
  const domain = projects.data?.find((row) => row.id === projectId)?.domain;

  const mutation = useMutation({
    mutationFn: (url: string) => exportSitemap({ data: { projectId, url } }),
    onSuccess: (result) => {
      if (result.entries.length > 0) downloadCsv(result);
    },
  });

  const form = useForm({
    defaultValues: { url: domain ?? "" },
    onSubmit: async ({ value }) => {
      // Shown from the mutation's own state below.
      await mutation.mutateAsync(value.url.trim()).catch(() => undefined);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Export Sitemap</h2>
        </CardTitle>
        <CardDescription>
          Download every URL in a site&apos;s sitemaps as a CSV, with last
          modified date, change frequency, priority and source sitemap. Enter a
          domain, or a sitemap URL to export just that file. No credits used.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid grid-cols-1 gap-3 lg:grid-cols-12 lg:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="url">
            {(field) => (
              <Input
                className="lg:col-span-9"
                aria-label="Domain or sitemap URL"
                placeholder="example.com or https://example.com/sitemap.xml"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            )}
          </form.Field>
          <form.Subscribe
            selector={(state) => ({
              isEmpty: !state.values.url.trim(),
              isSubmitting: state.isSubmitting,
            })}
          >
            {({ isEmpty, isSubmitting }) => (
              <Button
                type="submit"
                variant="outline"
                className="w-full lg:col-span-3"
                disabled={isEmpty}
                pending={isSubmitting}
              >
                {isSubmitting ? "Reading sitemaps..." : "Export CSV"}
              </Button>
            )}
          </form.Subscribe>
        </form>

        {mutation.isError ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>
              {getStandardErrorMessage(
                mutation.error,
                "Could not read this site's sitemaps",
              )}
            </AlertTitle>
          </Alert>
        ) : null}
        {mutation.isSuccess ? <ExportResult result={mutation.data} /> : null}
      </CardContent>
    </Card>
  );
}

function ExportResult({ result }: { result: SitemapExport }) {
  const urlCount = result.entries.length;
  const { unreadSitemaps, stoppedAtLimit } = result;
  const incomplete = unreadSitemaps.length > 0 || stoppedAtLimit;

  return (
    <div className="space-y-3">
      {urlCount > 0 ? (
        <p className="text-sm text-muted-foreground">
          Exported {plural(urlCount, "URL")} from{" "}
          {plural(result.sitemapsRead, "sitemap")}.
        </p>
      ) : null}

      {urlCount === 0 && !incomplete ? (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>No sitemap URLs found</AlertTitle>
          <AlertDescription>
            Checked robots.txt and /sitemap.xml on {result.origin}. If the
            sitemap is somewhere else, enter its full URL.
          </AlertDescription>
        </Alert>
      ) : null}

      {incomplete ? (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>
            {urlCount > 0
              ? "This export is incomplete"
              : "No URLs could be exported"}
          </AlertTitle>
          <AlertDescription>
            {stoppedAtLimit ? (
              <p>
                Stopped at the export limit of{" "}
                {SITEMAP_EXPORT_MAX_URLS.toLocaleString()} URLs or{" "}
                {SITEMAP_EXPORT_MAX_FILES} sitemap files.
              </p>
            ) : null}
            {unreadSitemaps.length > 0 ? (
              <>
                <p>
                  {plural(unreadSitemaps.length, "sitemap")} could not be read:
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {unreadSitemaps
                    .slice(0, UNREAD_SITEMAPS_SHOWN)
                    .map(({ url, reason }) => (
                      <li key={url} className="break-all">
                        {url} ({reason})
                      </li>
                    ))}
                </ul>
                {unreadSitemaps.length > UNREAD_SITEMAPS_SHOWN ? (
                  <p className="mt-1">
                    …and {unreadSitemaps.length - UNREAD_SITEMAPS_SHOWN} more.
                  </p>
                ) : null}
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

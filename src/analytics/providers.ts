import type {
  AnalyticsCapabilities,
  AnalyticsProvider,
  ArticleMetricRequest,
  SiteMetricRequest,
} from "./interfaces";

export interface SearchConsoleTransport {
  query(input: {
    siteUrl: string;
    startDate: string;
    endDate: string;
    dimensions: string[];
    startRow: number;
    rowLimit: number;
  }): Promise<{
    rows?: Array<{
      keys: string[];
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
    }>;
  }>;
}

export class SearchConsoleAnalyticsAdapter implements AnalyticsProvider {
  readonly provider = "google_search_console" as const;
  constructor(
    private options: {
      siteUrl: string;
      transport: SearchConsoleTransport;
      pageSize?: number;
      maximumPages?: number;
    },
  ) {}
  async getCapabilities(): Promise<AnalyticsCapabilities> {
    return {
      metrics: ["clicks", "impressions", "ctr", "position"],
      dimensions: ["query", "page", "country", "device", "date"],
      supportsPagination: true,
      liveAccess: true,
    };
  }
  async collectArticleMetrics(input: ArticleMetricRequest) {
    const pageSize = this.options.pageSize ?? 25_000;
    const maximumPages = this.options.maximumPages ?? 20;
    const output: unknown[] = [];
    for (let page = 0; page < maximumPages; page++) {
      const result = await this.options.transport.query({
        siteUrl: this.options.siteUrl,
        startDate: input.windowStart.slice(0, 10),
        endDate: input.windowEnd.slice(0, 10),
        dimensions: input.dimensions,
        startRow: page * pageSize,
        rowLimit: pageSize,
      });
      const rows = result.rows ?? [];
      output.push(...rows);
      if (rows.length < pageSize) break;
    }
    return output;
  }
  async collectSiteMetrics(input: SiteMetricRequest) {
    return this.collectArticleMetrics({
      canonicalUrls: [],
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      dimensions: ["date"],
    });
  }
}

export class UnavailableVercelAnalyticsAdapter implements AnalyticsProvider {
  readonly provider = "vercel_web_analytics" as const;
  async getCapabilities(): Promise<AnalyticsCapabilities> {
    return {
      metrics: [],
      dimensions: [],
      supportsPagination: false,
      liveAccess: false,
    };
  }
  async collectArticleMetrics(): Promise<unknown[]> {
    throw new Error(
      "Vercel Web Analytics has no configured stable read adapter; use a manual aggregate export",
    );
  }
  async collectSiteMetrics(): Promise<unknown> {
    throw new Error(
      "Vercel Web Analytics has no configured stable read adapter; use a manual aggregate export",
    );
  }
}

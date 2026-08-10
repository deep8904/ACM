import type { SourceConfig } from "../config/source-config";
import type { SourceItem } from "../models/source-item";

export type FetchImplementation = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AdapterWarning {
  code: string;
  message: string;
  itemReference?: string;
}

export interface AdapterContext {
  runId: string;
  retrievedAt: string;
  lookbackSince?: string;
  maxItems?: number;
  fetch: FetchImplementation;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface AdapterResult {
  items: SourceItem[];
  warnings: AdapterWarning[];
}

export interface TrendSourceAdapter {
  readonly supportedTypes: readonly SourceConfig["type"][];
  fetchItems(
    source: SourceConfig,
    context: AdapterContext,
  ): Promise<AdapterResult>;
}

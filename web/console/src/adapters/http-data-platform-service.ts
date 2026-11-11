/**
 * HTTP adapter for the internal data-platform API (/v1/internal/data-platform/**).
 *
 * Wire format: POST query rows returns string-encoded numerics (precision-safe),
 * converted to number on this boundary before reaching React state.
 */

import { requestJson, type HttpFetch } from './http-common';

export type DataPlatformDomain = 'quote' | 'flow' | 'fundamental' | 'research' | 'sector' | 'shareholder' | 'index' | 'fund' | 'futures' | 'options' | 'bond' | 'fx';

export interface DatasetMeta {
  readonly name: string;
  readonly domain: DataPlatformDomain;
  readonly title: string;
  readonly description: string;
  /** null = AKshare 源（非 tushare 计费）。 */
  readonly pointsMin: number | null;
  readonly docId: number | null;
  readonly source: string;
  readonly mode: 'daily' | 'snapshot' | 'per_instrument' | 'realtime';
  readonly viewName: string;
}

export interface DatasetStats extends DatasetMeta {
  readonly rowCount: number;
  readonly latestAsOf: string | null;
  readonly latestDate: string | null;
}

export interface CatalogResponse {
  readonly datasets: readonly DatasetStats[];
  readonly as_of: string;
}

export interface ResearchRow {
  readonly [key: string]: string | number | boolean | null;
}

export interface QueryResponse {
  readonly dataset: string;
  readonly rows: readonly ResearchRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly as_of: string;
}

export interface QueryRequest {
  readonly limit?: number;
  readonly offset?: number;
  readonly from?: string;
  readonly to?: string;
  readonly instrumentId?: string;
  readonly exchange?: 'SSE' | 'SZSE' | 'BSE';
}

export interface HttpDataPlatformServiceOptions {
  readonly fetchImpl: HttpFetch;
  readonly baseUrl: string;
  readonly environment: 'dev' | 'staging' | 'prod';
  readonly authHeaders: () => Record<string, string>;
}

export class HttpDataPlatformService {
  constructor(private readonly options: HttpDataPlatformServiceOptions) {}

  async listDatasets(): Promise<CatalogResponse> {
    const { body } = await requestJson(this.options.fetchImpl, `${this.options.baseUrl}/internal/data-platform/catalog`, this.options.authHeaders, { method: 'GET' });
    const parsed = body as CatalogResponse;
    return {
      as_of: parsed.as_of,
      datasets: parsed.datasets.map((item) => ({ ...item, rowCount: Number(item.rowCount ?? 0) })),
    };
  }

  async getDatasetMeta(name: string): Promise<DatasetMeta> {
    const { body } = await requestJson(this.options.fetchImpl, `${this.options.baseUrl}/internal/data-platform/datasets/${encodeURIComponent(name)}`, this.options.authHeaders, { method: 'GET' });
    return body as DatasetMeta;
  }

  async queryDataset(name: string, query: QueryRequest): Promise<QueryResponse> {
    const { body } = await requestJson(this.options.fetchImpl, `${this.options.baseUrl}/internal/data-platform/datasets/${encodeURIComponent(name)}/query`, this.options.authHeaders, { method: 'POST', body: query });
    return body as QueryResponse;
  }
}

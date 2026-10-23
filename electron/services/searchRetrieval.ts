import type { SearchIndexService, SearchQueryRequest, SearchQueryResult } from './searchIndexService'

let provider: (() => SearchIndexService) | undefined
/** Main registers its lazy singleton; callers never load appMain or initialize WCDB. */
export function registerSearchRetrieval(resolve: () => SearchIndexService): void { provider = resolve }
export async function retrieveIndexedMessages(request: SearchQueryRequest): Promise<SearchQueryResult> {
  if (!provider) return { hits: [], total: 0, cursor: null, elapsedMs: 0, truncated: false, error: '搜索索引服务尚未启动' }
  return provider().retrieve(request)
}

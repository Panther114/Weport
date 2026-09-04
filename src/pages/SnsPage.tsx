import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  CalendarDays,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Images,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Users2,
  X,
} from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type { SnsPost } from '../types/sns'
import { Avatar } from '../components/Avatar'
import { CountUp } from '../components/CountUp'
import { SnsPostItem } from '../components/sns/SnsPostItem'
import { SnsPreviewLightbox } from '../components/sns/SnsPreviewLightbox'
import { ContactSnsTimelineDialog } from '../components/sns/ContactSnsTimelineDialog'
import { SnsExportDialog } from '../components/sns/SnsExportDialog'
import { useEscape } from '../utils/useEscape'
import { EmptyState } from '../components/EmptyState'
import { isSnsVideoUrl } from '../utils/snsParse'

const PAGE_SIZE = 20
const SNS_PAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const SNS_PAGE_CACHE_POST_LIMIT = 200
const SNS_AUTHOR_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const SNS_PAGE_CACHE_SCOPE_FALLBACK = '__default__'

interface SnsAuthor {
  username: string
  displayName: string
  avatarUrl?: string
  postCount?: number
}

interface OverviewStats {
  totalPosts: number
  totalFriends: number
  myPosts: number | null
}

interface CacheMigrationStatus {
  needed: boolean
  inProgress: boolean
  totalFiles: number
  items: { label: string; fileCount: number }[]
}

interface SnsPageCachePayload {
  updatedAt: number
  overviewStats?: OverviewStats
  posts: unknown[]
}

interface SnsAuthorCachePayload {
  updatedAt: number
  authors: SnsAuthor[]
}

const toDayStart = (ts: number) => Math.floor(new Date(ts * 1000).setHours(0, 0, 0, 0) / 1000)
const toDayKey = (ts: number) => {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export default function SnsPage() {
  const [authors, setAuthors] = useState<SnsAuthor[]>([])
  const [authorsLoading, setAuthorsLoading] = useState(true)
  const [authorSearch, setAuthorSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [keyword, setKeyword] = useState('')
  const [keywordDraft, setKeywordDraft] = useState('')
  const [searchComments, setSearchComments] = useState(false)
  const [dateJump, setDateJump] = useState<{ start: number; end: number } | null>(null)
  const [posts, setPosts] = useState<SnsPost[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [feedLoading, setFeedLoading] = useState(false)
  const [feedError, setFeedError] = useState<string | null>(null)
  const [overview, setOverview] = useState<OverviewStats | null>(null)
  const [antiDelete, setAntiDelete] = useState<'unknown' | 'installed' | 'uninstalled'>('unknown')
  const [antiDeleteBusy, setAntiDeleteBusy] = useState(false)
  const [migration, setMigration] = useState<CacheMigrationStatus | null>(null)
  const [migrationProgress, setMigrationProgress] = useState<{ current: number; total: number; status: string } | null>(null)
  const [migrationBusy, setMigrationBusy] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [authorDialog, setAuthorDialog] = useState<SnsAuthor | null>(null)
  const [debugPost, setDebugPost] = useState<SnsPost | null>(null)
  const [previewItems, setPreviewItems] = useState<Array<{ src: string; isVideo?: boolean }>>([])
  const [previewIndex, setPreviewIndex] = useState(-1)
  const [hasNewer, setHasNewer] = useState(false)
  const [refreshSpin, setRefreshSpin] = useState(false)
  const [showJumpPopover, setShowJumpPopover] = useState(false)
  const [jumpPopoverDate, setJumpPopoverDate] = useState<Date>(new Date())
  const [jumpDateCounts, setJumpDateCounts] = useState<Record<string, number>>({})
  const [jumpDateCountsLoading, setJumpDateCountsLoading] = useState(false)
  const postsRef = useRef(posts)
  postsRef.current = posts
  const feedRef = useRef<HTMLDivElement | null>(null)
  const virtuosoRef = useRef<VirtuosoHandle | null>(null)
  const loadingRef = useRef(false)
  const transientRetryRef = useRef(0)
  const requestSeqRef = useRef(0)
  const scrollAdjustmentRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  const autoRefreshScheduledRef = useRef(false)
  // 媒体解密产物注册表：postId:mediaIndex → 本地可显示地址（灯箱复用）
  const previewSrcsRef = useRef<Map<string, { src: string; isVideo?: boolean }>>(new Map())
  // 时间跳转月份计数缓存（monthKey → 日期计数）
  const jumpDateCountsCacheRef = useRef<Map<string, Record<string, number>>>(new Map())
  // 朋友圈页缓存作用域（按账号隔离）
  const cacheScopeRef = useRef<string | null>(null)
  const feedElRef = useRef<HTMLElement | null>(null)

  const activeUsernames = useMemo(() => Array.from(selected), [selected])
  const scopeKey = useMemo(
    () => `${activeUsernames.join(',')}|${keyword}|${searchComments ? 'c' : ''}|${dateJump ? `${dateJump.start}-${dateJump.end}` : ''}`,
    [activeUsernames, keyword, searchComments, dateJump],
  )
  // 发布者侧栏搜索：只过滤列表显示，不影响动态流查询（中英/拼音前缀按 displayName 匹配）
  const authorKw = authorSearch.trim().toLowerCase()
  const visibleAuthors = useMemo(() => {
    if (!authorKw) return authors
    return authors.filter((a) =>
      (a.displayName || '').toLowerCase().includes(authorKw) ||
      (a.username || '').toLowerCase().includes(authorKw),
    )
  }, [authors, authorKw])

  // ------------------------------------------------------------------ 页缓存
  const ensureCacheScope = useCallback(async (): Promise<string> => {
    if (cacheScopeRef.current) return cacheScopeRef.current
    let wxid = ''
    try {
      wxid = String((await window.electronAPI.config.get('myWxid')) || '').trim()
    } catch { /* noop */ }
    cacheScopeRef.current = `sns_page:${wxid || SNS_PAGE_CACHE_SCOPE_FALLBACK}`
    return cacheScopeRef.current
  }, [])

  const persistPageCache = useCallback(async () => {
    if (selected.size > 0 || keyword || dateJump) return
    try {
      const scope = await ensureCacheScope()
      const existing = await window.electronAPI.config.get('snsPageCacheMap')
      const map = existing && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {}
      const cached = (map[scope] as SnsPageCachePayload | undefined) || null
      const postsToStore = postsRef.current.slice(0, SNS_PAGE_CACHE_POST_LIMIT)
      if (postsToStore.length === 0 && cached && Array.isArray(cached.posts)) {
        return
      }
      map[scope] = {
        updatedAt: Date.now(),
        overviewStats: overview || cached?.overviewStats,
        posts: postsToStore,
      }
      await window.electronAPI.config.set('snsPageCacheMap', map)
    } catch {
      /* 缓存失败不影响主流程 */
    }
  }, [selected, keyword, dateJump, overview, ensureCacheScope])

  /** 从页缓存即时恢复上次浏览内容（秒开），随后由真实查询替换 */
  const hydratePageCache = useCallback(async (): Promise<boolean> => {
    try {
      const scope = await ensureCacheScope()
      const existing = await window.electronAPI.config.get('snsPageCacheMap')
      const map = existing && typeof existing === 'object' ? (existing as Record<string, unknown>) : {}
      const cached = map[scope] as SnsPageCachePayload | undefined
      if (!cached || typeof cached !== 'object') return false
      if (Date.now() - Number(cached.updatedAt || 0) > SNS_PAGE_CACHE_TTL_MS) return false
      if (cached.overviewStats && typeof cached.overviewStats === 'object') {
        const o = cached.overviewStats as OverviewStats
        setOverview({
          totalPosts: Math.max(0, Number(o.totalPosts) || 0),
          totalFriends: Math.max(0, Number(o.totalFriends) || 0),
          myPosts: typeof o.myPosts === 'number' && o.myPosts >= 0 ? Math.floor(o.myPosts) : null,
        })
      }
      if (Array.isArray(cached.posts)) {
        const valid = (cached.posts as unknown[])
          .filter((raw): raw is SnsPost => !!raw && typeof raw === 'object' && typeof (raw as SnsPost).id === 'string' && typeof (raw as SnsPost).createTime === 'number')
          .slice(0, SNS_PAGE_CACHE_POST_LIMIT)
          .sort((a, b) => b.createTime - a.createTime)
        if (valid.length > 0) {
          setPosts(valid)
          setHasMore(true)
          return true
        }
      }
      return false
    } catch {
      return false
    }
  }, [ensureCacheScope])

  // ------------------------------------------------------------------ 概览
  const loadOverview = useCallback(async () => {
    try {
      const r = await window.electronAPI.sns.getExportStats({ allowTimelineFallback: true })
      if (r.success && r.data) setOverview(r.data)
    } catch {
      /* noop */
    }
  }, [])

  // ------------------------------------------------------------------ 作者
  const loadAuthors = useCallback(async () => {
    let hydrated = false
    try {
      const scope = await ensureCacheScope()
      const existing = await window.electronAPI.config.get('snsAuthorCacheMap')
      const map = existing && typeof existing === 'object' ? (existing as Record<string, unknown>) : {}
      const cached = map[scope] as SnsAuthorCachePayload | undefined
      if (
        cached &&
        Date.now() - Number(cached.updatedAt || 0) <= SNS_AUTHOR_CACHE_TTL_MS &&
        Array.isArray(cached.authors) &&
        cached.authors.length > 0
      ) {
        setAuthors(cached.authors)
        hydrated = true
      }
    } catch {
      /* cached author data is optional */
    }
    // 若已从缓存恢复出正确排序的作者列表，保持显示直到真实计数返回，避免首屏闪现未排序的“奇怪联系人”
    if (hydrated) {
      setAuthorsLoading(false)
    } else {
      setAuthorsLoading(true)
    }
    try {
      // 先并发拉取：用户名与计数（计数 preferCache 命中时很快，未命中则需扫描，绝不能先以空计数渲染未排序列表）
      const countsPromise = window.electronAPI.sns.getUserPostCounts({ preferCache: true })
      const usersRes = await window.electronAPI.sns.getSnsUsernames()
      const usernames = usersRes.success ? usersRes.usernames || [] : []
      const enriched: Record<string, { displayName?: string; avatarUrl?: string }> = {}
      if (usernames.length > 0) {
        const enr = await window.electronAPI.chat.enrichSessionsContactInfo(usernames)
        if (enr.success && enr.contacts) Object.assign(enriched, enr.contacts)
      }
      let authorCacheWrite: Promise<void> = Promise.resolve()
      const applyAuthors = (counts: Record<string, number>, hasCounts: boolean) => {
        const list: SnsAuthor[] = usernames
          .filter((u) => enriched[u]?.displayName)
          .map((u) => ({
            username: u,
            displayName: enriched[u]?.displayName || u,
            avatarUrl: enriched[u]?.avatarUrl,
            postCount: typeof counts[u] === 'number' ? counts[u] : undefined,
          }))
          .sort((a, b) => {
            // 有真实计数时严格按发帖数降序；无计数时保持用户名稳定顺序，避免与计数排序结果混淆
            if (hasCounts) return (b.postCount ?? 0) - (a.postCount ?? 0)
            return a.displayName.localeCompare(b.displayName, 'zh-Hans-CN')
          })
        // 仅当拿到真实计数或无缓存兜底时才覆盖首屏；已 hydration 的缓存列表不会被空计数阶段的未排序结果闪掉
        if (hasCounts || !hydrated) {
          setAuthors(list)
        } else if (!hasCounts && !hydrated) {
          // 理论不可达：兜底
          setAuthors(list)
        }
        if (hasCounts) {
          authorCacheWrite = authorCacheWrite.catch(() => undefined).then(async () => {
            try {
              const scope = await ensureCacheScope()
              const existing = await window.electronAPI.config.get('snsAuthorCacheMap')
              const map = existing && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {}
              map[scope] = { updatedAt: Date.now(), authors: list }
              await window.electronAPI.config.set('snsAuthorCacheMap', map)
            } catch {
              /* cache failure does not affect the live sidebar */
            }
          })
        }
      }
      // 等计数就绪后再首次渲染作者列表，保证发布者始终按发帖数正确排序
      try {
        const countsRes = await countsPromise
        if (countsRes.success) {
          applyAuthors(countsRes.counts || {}, true)
        } else {
          // 计数失败时仍按展示名稳定排序，避免空计数导致的“奇怪顺序”
          applyAuthors({}, false)
        }
      } catch {
        applyAuthors({}, false)
      }
    } catch {
      /* noop */
    } finally {
      setAuthorsLoading(false)
    }
  }, [ensureCacheScope])

  // ------------------------------------------------------------------ 时间线
  /**
   * 取回一批帖子（支持按时间窗分页 + 评论搜索客户端过滤）。
   * 评论搜索开启时 DLL 关键词只匹配正文，这里按 200 条分块拉取后
   * 在渲染层同时匹配正文与评论，与 WeFlow 行为一致。
   */
  const fetchChunk = useCallback(
    async (limitToFetch: number, fromStartTs: number | undefined, fromEndTs: number | undefined): Promise<SnsPost[]> => {
      const kw = keyword || undefined
      if (searchComments && kw) {
        let accumulated: SnsPost[] = []
        let loopEndTs = fromEndTs
        let loops = 0
        const chunkSize = 200
        const lowerKw = kw.toLowerCase()
        while (accumulated.length < limitToFetch && loops < 50) {
          loops += 1
          const res = await window.electronAPI.sns.getTimeline(
            chunkSize,
            0,
            activeUsernames.length > 0 ? activeUsernames : undefined,
            '',
            fromStartTs ?? 0,
            loopEndTs ?? 0,
          )
          if (!res.success || !res.timeline || res.timeline.length === 0) break
          const matching = res.timeline.filter((p) => {
            if ((p.contentDesc || '').toLowerCase().includes(lowerKw)) return true
            if (Array.isArray(p.comments)) {
              return p.comments.some((c: { content?: string }) => (c.content || '').toLowerCase().includes(lowerKw))
            }
            return false
          })
          accumulated = [...accumulated, ...matching]
          if (res.timeline.length < chunkSize) break
          loopEndTs = res.timeline[res.timeline.length - 1].createTime - 1
        }
        return accumulated.slice(0, limitToFetch)
      }
      const result = await window.electronAPI.sns.getTimeline(
        limitToFetch,
        0,
        activeUsernames.length > 0 ? activeUsernames : undefined,
        kw,
        fromStartTs ?? 0,
        fromEndTs ?? 0,
      )
      return result.success ? result.timeline || [] : []
    },
    [activeUsernames, keyword, searchComments],
  )

  const loadTimeline = useCallback(
    async (reset: boolean) => {
      if (loadingRef.current) return
      if (!reset && !hasMore) return
      loadingRef.current = true
      setFeedLoading(true)
      if (reset) {
        setFeedError(null)
        setHasNewer(false)
      }
      const seq = ++requestSeqRef.current
      try {
        const currentPosts = postsRef.current
        let startTs: number | undefined = undefined
        let endTs: number | undefined = undefined
        if (reset && dateJump) {
          startTs = dateJump.start
          endTs = dateJump.end
        } else if (!reset && currentPosts.length > 0) {
          // 时间窗分页：从当前最旧一条继续往前（与评论搜索共用，避免 offset 漂移）
          endTs = currentPosts[currentPosts.length - 1].createTime - 1
        }
        const list = await fetchChunk(PAGE_SIZE, startTs, endTs)
        if (seq !== requestSeqRef.current) return
        if (list.length > 0 || reset) {
          const merged = reset ? list : [...currentPosts, ...list]
          setPosts(merged)
          setHasMore(list.length >= PAGE_SIZE)
          if (reset) {
            void persistPageCache()
          }
        }
        if (list.length === 0 && !reset) setHasMore(false)
      } catch (e) {
        if (seq === requestSeqRef.current) setFeedError(String(e))
      } finally {
        if (seq === requestSeqRef.current) {
          loadingRef.current = false
          setFeedLoading(false)
        }
      }
    },
    [hasMore, dateJump, fetchChunk, persistPageCache],
  )

  /** 拉取时间线顶部的更新并前置合并（保留滚动位置，WeFlow 同款） */
  const loadNewer = useCallback(async () => {
    if (loadingRef.current) return
    const currentPosts = postsRef.current
    if (currentPosts.length === 0) return
    loadingRef.current = true
    try {
      const topTs = currentPosts[0].createTime
      const newer = await fetchChunk(PAGE_SIZE, topTs + 1, undefined)
      if (newer.length === 0) {
        setHasNewer(false)
        return
      }
      const existingIds = new Set(currentPosts.map((p) => p.id))
      const unique = newer.filter((p) => !existingIds.has(p.id))
      if (unique.length > 0) {
        const scroller = feedElRef.current
        if (scroller) {
          scrollAdjustmentRef.current = {
            scrollHeight: scroller.scrollHeight,
            scrollTop: scroller.scrollTop,
          }
        }
        const merged = [...unique, ...currentPosts].sort((a, b) => b.createTime - a.createTime)
        setPosts(merged)
        void persistPageCache()
      }
      setHasNewer(unique.length >= PAGE_SIZE)
    } catch {
      /* 静默 */
    } finally {
      loadingRef.current = false
    }
  }, [fetchChunk, persistPageCache])

  // 筛选条件变化 → 重置并重新加载
  useEffect(() => {
    requestSeqRef.current++
    setPosts([])
    setHasMore(false)
    loadingRef.current = false
    void loadTimeline(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  // 首次挂载：先秒开页缓存，再加载真实数据
  useEffect(() => {
    void loadOverview()
    void loadAuthors()
    void window.electronAPI.sns.checkBlockDeleteTrigger().then((r) => {
      if (r.success) setAntiDelete(r.installed ? 'installed' : 'uninstalled')
    })
    void window.electronAPI.sns.getCacheMigrationStatus().then((r) => {
      if (r.success) setMigration({ needed: r.needed, inProgress: r.inProgress, totalFiles: r.totalFiles || 0, items: r.items || [] })
    })
    void hydratePageCache().then((hydrated) => {
      if (hydrated) void loadTimeline(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadOverview, loadAuthors])

  // 前置合并后修正滚动位置（新内容插入列表顶部导致视口下移）
  useLayoutEffect(() => {
    const snapshot = scrollAdjustmentRef.current
    if (snapshot && feedElRef.current) {
      const el = feedElRef.current
      const addedHeight = el.scrollHeight - snapshot.scrollHeight
      if (addedHeight > 0) {
        el.scrollTop = snapshot.scrollTop + addedHeight
      }
      scrollAdjustmentRef.current = null
    }
  }, [posts])

  // ------------------------------------------------------------------ 新动态
  const checkNewer = useCallback(async () => {
    if (loadingRef.current) return
    try {
      const currentTop = postsRef.current[0]
      if (!currentTop) return
      const topTs = currentTop.createTime
      const newest = await fetchChunk(1, topTs + 1, undefined)
      if (newest.length === 0) return
      const top = newest[0]
      if (String(top.id) !== String(currentTop.id) || Number(top.createTime) > Number(currentTop.createTime)) {
        setHasNewer(true)
        if (autoRefreshScheduledRef.current) return
        autoRefreshScheduledRef.current = true
        window.setTimeout(() => {
          autoRefreshScheduledRef.current = false
          if (!document.hidden) void loadNewer()
        }, 1500)
      }
    } catch {
      /* 轮询失败静默 */
    }
  }, [fetchChunk, loadNewer])

  useEffect(() => {
    setHasNewer(false)
    const timer = window.setInterval(() => void checkNewer(), 15000)
    const onFocus = () => void checkNewer()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [checkNewer])

  // ------------------------------------------------------------------ 时间跳转
  const loadJumpDateCounts = useCallback(async (monthDate: Date) => {
    const monthKey = `${monthDate.getFullYear()}-${monthDate.getMonth() + 1}`
    const cached = jumpDateCountsCacheRef.current.get(monthKey)
    if (cached) {
      setJumpDateCounts(cached)
      return
    }
    setJumpDateCountsLoading(true)
    setJumpDateCounts({})
    try {
      const year = monthDate.getFullYear()
      const month = monthDate.getMonth()
      const startTs = Math.floor(new Date(year, month, 1).getTime() / 1000)
      const endTs = Math.floor(new Date(year, month + 1, 1).getTime() / 1000) - 1
      const counts: Record<string, number> = {}
      let offset = 0
      for (let i = 0; i < 50; i += 1) {
        const res = await window.electronAPI.sns.getTimeline(200, offset, undefined, '', startTs, endTs)
        if (!res.success || !res.timeline || res.timeline.length === 0) break
        for (const p of res.timeline) {
          const key = toDayKey(p.createTime)
          counts[key] = (counts[key] || 0) + 1
        }
        if (res.timeline.length < 200) break
        offset += res.timeline.length
      }
      jumpDateCountsCacheRef.current.set(monthKey, counts)
      if (jumpDateCountsCacheRef.current.size > 24) {
        const oldestKey = jumpDateCountsCacheRef.current.keys().next().value as string | undefined
        if (oldestKey) jumpDateCountsCacheRef.current.delete(oldestKey)
      }
      setJumpDateCounts(counts)
    } finally {
      setJumpDateCountsLoading(false)
    }
  }, [])

  const openJumpPopover = useCallback(() => {
    const nextDate = dateJump ? new Date(dateJump.start * 1000) : new Date()
    setJumpPopoverDate(nextDate)
    void loadJumpDateCounts(nextDate)
    setShowJumpPopover((prev) => !prev)
  }, [dateJump, loadJumpDateCounts])

  const jumpToDate = useCallback((day: Date) => {
    const start = Math.floor(new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() / 1000)
    setDateJump({ start, end: start + 86399 })
    setShowJumpPopover(false)
  }, [])

  const shiftJumpMonth = useCallback(
    (delta: number) => {
      const next = new Date(jumpPopoverDate.getFullYear(), jumpPopoverDate.getMonth() + delta, 1)
      setJumpPopoverDate(next)
      void loadJumpDateCounts(next)
    },
    [jumpPopoverDate, loadJumpDateCounts],
  )

  const jumpCalendarDays = useMemo(() => {
    const year = jumpPopoverDate.getFullYear()
    const month = jumpPopoverDate.getMonth()
    const firstWeekday = new Date(year, month, 1).getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const cells: Array<Date | null> = []
    for (let i = 0; i < firstWeekday; i += 1) cells.push(null)
    for (let d = 1; d <= daysInMonth; d += 1) cells.push(new Date(year, month, d))
    return cells
  }, [jumpPopoverDate])

  // ------------------------------------------------------------------ 交互
  const toggleAuthor = (username: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(username)) next.delete(username)
      else next.add(username)
      return next
    })
  }

  const applyKeyword = () => {
    setKeyword(keywordDraft.trim())
  }

  const clearFilters = () => {
    setSelected(new Set())
    setKeyword('')
    setKeywordDraft('')
    setSearchComments(false)
    setDateJump(null)
  }

  const toggleAntiDelete = async () => {
    if (antiDeleteBusy) return
    setAntiDeleteBusy(true)
    try {
      if (antiDelete === 'installed') {
        const r = await window.electronAPI.sns.uninstallBlockDeleteTrigger()
        if (r.success) setAntiDelete('uninstalled')
      } else {
        const r = await window.electronAPI.sns.installBlockDeleteTrigger()
        if (r.success) setAntiDelete(r.alreadyInstalled ? 'installed' : 'installed')
      }
    } finally {
      setAntiDeleteBusy(false)
    }
  }

  const startMigration = async () => {
    if (migrationBusy) return
    setMigrationBusy(true)
    setMigrationProgress({ current: 0, total: migration?.totalFiles || 0, status: '准备迁移…' })
    const off = window.electronAPI.sns.onCacheMigrationProgress((p) => {
      setMigrationProgress({ current: p.current, total: p.total, status: p.message || p.status })
    })
    try {
      const r = await window.electronAPI.sns.startCacheMigration()
      if (r.success) {
        setMigration(null)
        setMigrationProgress(null)
      } else {
        setMigrationProgress({ current: 0, total: 0, status: r.error || '迁移失败' })
      }
    } finally {
      off()
      setMigrationBusy(false)
    }
  }

  const handleRefresh = async () => {
    if (refreshSpin) return
    setRefreshSpin(true)
    try {
      await Promise.all([loadTimeline(true), loadOverview(), loadAuthors()])
    } finally {
      window.setTimeout(() => setRefreshSpin(false), 300)
    }
  }

  // 预览：构建跨帖媒体列表并定位（稳定回调，配合 React.memo 减少重渲染）
  const handlePreviewPost = useCallback((post: SnsPost, src: string, isVideo?: boolean, _live?: string, mediaIndex?: number) => {
    if (typeof mediaIndex === 'number') {
      // 记录该条媒体的解密产物（全图本地文件/视频本地文件）：
      // 灯箱必须用解密后的本地地址，否则直接加载 CDN 密文 URL → 无法显示
      if (src) previewSrcsRef.current.set(`${post.id}:${mediaIndex}`, { src, isVideo })
      const list = postsRef.current
      let base = 0
      for (const p of list) {
        if (p.id === post.id) break
        base += p.media.length
      }
      const allItems: Array<{ src: string; isVideo?: boolean }> = []
      // 注册表键是「post.id + 该帖内媒体下标」，重建时必须用同款键查询；
      // 此前误用全局下标，第一帖之后的媒体全部查不到本地解密产物，
      // 灯箱退回原始 CDN 密文 URL → 图片无法查看
      for (const p of list) {
        p.media.forEach((m, mediaIdx) => {
          const known = previewSrcsRef.current.get(`${p.id}:${mediaIdx}`)
          allItems.push({
            src: known?.src || m.thumb || m.url,
            isVideo: known?.isVideo ?? isSnsVideoUrl(m.url),
          })
        })
      }
      setPreviewItems(allItems)
      setPreviewIndex(base + mediaIndex)
    } else {
      setPreviewItems([{ src, isVideo }])
      setPreviewIndex(0)
    }
  }, [])

  const handleDeletePost = useCallback((postId: string) => {
    setPosts((prev) => prev.filter((p) => p.id !== postId))
    loadOverview().catch(() => undefined)
  }, [loadOverview])

  const handlePostDelete = useCallback((postId: string, _username: string) => {
    handleDeletePost(postId)
  }, [handleDeletePost])

  const handleOpenAuthor = useCallback(
    (p: SnsPost) => {
      const author = authors.find((a) => a.username === p.username) || {
        username: p.username,
        displayName: p.nickname,
        avatarUrl: p.avatarUrl,
      }
      setAuthorDialog(author)
    },
    [authors],
  )

  useEscape(() => setDebugPost(null), !!debugPost)
  useEscape(() => setShowJumpPopover(false), showJumpPopover)

  const selectAllAuthors = () => {
    setSelected(new Set(authors.map((a) => a.username)))
  }

  // Virtuoso 头尾部件
  const snsVirtuosoComponents = useMemo(
    () => ({
      Header: () => (
        <>
          {hasNewer && (
            <button type="button" className="sns-newer-pill" onClick={() => void loadNewer()}>
              <RefreshCw size={13} />
              有新动态，点击刷新
            </button>
          )}
        </>
      ),
      Footer: () => (
        <div className="sns-feed-sentinel">
          {feedLoading && (
            <div className="wp-loading">
              <Loader2 className="spin" size={16} />
              加载中…
            </div>
          )}
          {!feedLoading && !hasMore && posts.length > 0 && <div className="sns-feed-end">已加载全部 {posts.length} 条动态</div>}
        </div>
      ),
    }),
    [hasNewer, feedLoading, hasMore, posts.length, loadNewer],
  )

  const renderPostItem = useCallback(
    (index: number, post: SnsPost) => (
      <SnsPostItem
        key={post.id}
        post={post}
        onPreview={(src, isVideo, live, mediaIndex) => handlePreviewPost(post, src, isVideo, live, mediaIndex)}
        onDecrypt={(mediaIndex, src, isVideo) => previewSrcsRef.current.set(`${post.id}:${mediaIndex}`, { src, isVideo })}
        onDebug={setDebugPost}
        onDelete={handlePostDelete}
        onOpenAuthorPosts={handleOpenAuthor}
      />
    ),
    [handlePreviewPost, handlePostDelete, handleOpenAuthor],
  )

  return (
    <div className="v09-page sns-page">
      {/* 缓存迁移提示 */}
      {migration?.needed && !migration.inProgress && (
        <div className="sns-migration-banner">
          <RefreshCw size={14} />
          <span>
            检测到旧版朋友圈缓存（{migration.totalFiles} 个文件），迁移后可加速媒体加载。
          </span>
          <button className="ghost-btn" disabled={migrationBusy} onClick={() => void startMigration()}>
            {migrationBusy ? '迁移中…' : '开始迁移'}
          </button>
        </div>
      )}
      {migrationProgress && (
        <div className="sns-migration-banner">
          <Loader2 className="spin" size={14} />
          <span>{migrationProgress.status}</span>
          {migrationProgress.total > 0 && (
            <div className="progress-track migration-track">
              <div
                className="progress-fill"
                style={{ width: `${Math.min(100, (migrationProgress.current / migrationProgress.total) * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {(selected.size > 0 || keyword || searchComments || dateJump) && (
        <div className="sns-filter-summary">
          <span className="sns-filter-summary-label">当前筛选</span>
          {selected.size > 0 && (
            <button className="chip chip-active" onClick={() => setSelected(new Set())} title="清除发布者筛选">
              <Users2 size={12} />
              {selected.size} 位发布者
              <X size={11} />
            </button>
          )}
          {keyword && (
            <button className="chip chip-active" onClick={() => { setKeyword(''); setKeywordDraft('') }} title="清除关键词">
              <Search size={12} />
              “{keyword}”{searchComments ? '（含评论）' : ''}
              <X size={11} />
            </button>
          )}
          {dateJump && (
            <button className="chip chip-active" onClick={() => { setDateJump(null); setShowJumpPopover(false) }} title="清除日期筛选">
              <CalendarDays size={12} />
              {new Date(dateJump.start * 1000).toLocaleDateString('zh-CN')}
              <X size={11} />
            </button>
          )}
        </div>
      )}

      <div className="sns-main">
        {/* 筛选侧栏（含页面头部：标题 / 统计 / 操作，紧凑布局） */}
        <aside className="sns-sidebar">
          <div className="sns-sidebar-hero">
            <div className="sns-sidebar-title">
              <Images size={15} />
              <span>朋友圈</span>
              <span className="v09-sub">本地归档</span>
            </div>
            <div className="sns-sidebar-stats">
              <div className="v09-stat">
                <b>
                  <CountUp value={overview?.totalPosts ?? 0} />
                </b>
                <span>总动态</span>
              </div>
              <div className="v09-stat">
                <b>
                  <CountUp value={overview?.totalFriends ?? 0} />
                </b>
                <span>好友</span>
              </div>
              {overview?.myPosts !== null && (
                <div className="v09-stat">
                  <b>
                    <CountUp value={overview?.myPosts ?? 0} />
                  </b>
                  <span>我的动态</span>
                </div>
              )}
            </div>
            <div className="sns-sidebar-actions">
              <button
                type="button"
                className={`chip ${antiDelete === 'installed' ? 'chip-active' : ''}`}
                disabled={antiDeleteBusy || antiDelete === 'unknown'}
                onClick={() => void toggleAntiDelete()}
                title="安装朋友圈删除拦截触发器（防删除）"
              >
                {antiDelete === 'installed' ? <ShieldCheck size={13} /> : <ShieldOff size={13} />}
                {antiDeleteBusy ? '处理中…' : antiDelete === 'installed' ? '防删除已开启' : '防删除'}
              </button>
              <button type="button" className="chip" onClick={() => setExportOpen(true)}>
                <Download size={13} />
                导出
              </button>
              <button type="button" className="chip" onClick={() => void handleRefresh()} title="刷新动态流与统计">
                <RefreshCw size={13} className={refreshSpin ? 'spin' : ''} />
                刷新
              </button>
            </div>
          </div>

          <div className="sns-sidebar-search">
            <Search size={14} />
            <input
              value={keywordDraft}
              placeholder="搜索动态内容…"
              onChange={(e) => setKeywordDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyKeyword()
              }}
            />
            {keyword && (
              <button className="sns-sidebar-clear" title="清除关键词" onClick={() => { setKeyword(''); setKeywordDraft('') }}>
                <X size={13} />
              </button>
            )}
          </div>
          <label className="sns-search-comments" title="开启后同时搜索正文与评论（数据量大时稍慢）">
            <input
              type="checkbox"
              checked={searchComments}
              onChange={(e) => {
                setSearchComments(e.target.checked)
                if (keyword) setKeyword(keyword.trim() || '')
              }}
            />
            <span>同时搜索评论</span>
          </label>

          <div className="sns-sidebar-date">
            <CalendarDays size={14} />
            <button
              type="button"
              className={`sns-date-jump-btn ${dateJump ? 'active' : ''}`}
              onClick={openJumpPopover}
              title={dateJump ? new Date(dateJump.start * 1000).toLocaleDateString('zh-CN') : '按日期跳转'}
            >
              {dateJump ? new Date(dateJump.start * 1000).toLocaleDateString('zh-CN') : '按日期跳转'}
            </button>
            {dateJump && (
              <button className="sns-sidebar-clear" title="清除日期筛选" onClick={() => { setDateJump(null); setShowJumpPopover(false) }}>
                <X size={13} />
              </button>
            )}
            {showJumpPopover && (
              <div className="sns-calendar-popover">
                <div className="sns-calendar-head">
                  <button type="button" className="sns-calendar-nav" onClick={() => shiftJumpMonth(-1)} title="上个月">
                    <ChevronLeft size={14} />
                  </button>
                  <span className="sns-calendar-title">
                    {jumpPopoverDate.getFullYear()}年{jumpPopoverDate.getMonth() + 1}月
                  </span>
                  <button type="button" className="sns-calendar-nav" onClick={() => shiftJumpMonth(1)} title="下个月">
                    <ChevronRight size={14} />
                  </button>
                </div>
                <div className="sns-calendar-grid">
                  {['日', '一', '二', '三', '四', '五', '六'].map((w) => (
                    <span key={w} className="sns-calendar-weekday">
                      {w}
                    </span>
                  ))}
                  {jumpCalendarDays.map((day, idx) =>
                    day ? (
                      <button
                        key={idx}
                        type="button"
                        className={`sns-calendar-day ${dateJump && toDayKey(dateJump.start) === toDayKey(day.getTime() / 1000) ? 'selected' : ''}`}
                        onClick={() => jumpToDate(day)}
                      >
                        {day.getDate()}
                        {(jumpDateCounts[toDayKey(day.getTime() / 1000)] || 0) > 0 && <i className="sns-calendar-dot" />}
                      </button>
                    ) : (
                      <span key={idx} className="sns-calendar-empty" />
                    ),
                  )}
                </div>
                <div className="sns-calendar-foot">
                  {jumpDateCountsLoading ? (
                    <Loader2 size={12} className="spin" />
                  ) : (
                    <span>点击日期跳转到当天动态</span>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="sns-sidebar-head">
            <span>发布者</span>
            <div className="sns-sidebar-head-actions">
              <button
                className="sns-sidebar-reset"
                title="刷新发布者列表与统计"
                onClick={() => {
                  void loadOverview()
                  void loadAuthors()
                }}
              >
                <RefreshCw size={12} />
                刷新
              </button>
              <button className="sns-sidebar-reset" onClick={selectAllAuthors}>
                <CheckSquare size={12} />
                全选
              </button>
              {(selected.size > 0 || keyword || searchComments || dateJump) && (
                <button className="sns-sidebar-reset" onClick={clearFilters}>
                  <X size={12} />
                  重置
                </button>
              )}
            </div>
          </div>

          <div className="sns-author-search">
            <Search size={13} />
            <input
              value={authorSearch}
              placeholder="搜索发布者"
              spellCheck={false}
              onChange={(e) => setAuthorSearch(e.target.value)}
            />
            {authorSearch && (
              <button
                className="sns-author-search-clear"
                title="清除发布者搜索"
                onClick={() => setAuthorSearch('')}
              >
                <X size={12} />
              </button>
            )}
          </div>

          <div className="sns-author-list">
            {authorsLoading && <div className="wp-loading">加载发布者…</div>}
            {!authorsLoading && authors.length === 0 && <div className="wp-empty">未找到朋友圈数据</div>}
            {!authorsLoading && authors.length > 0 && visibleAuthors.length === 0 && (
              <div className="wp-empty">无匹配发布者</div>
            )}
            {visibleAuthors.map((a) => (
              <button
                key={a.username}
                type="button"
                className={`sns-author ${selected.has(a.username) ? 'sns-author-active' : ''}`}
                onClick={() => toggleAuthor(a.username)}
              >
                <Avatar src={a.avatarUrl} name={a.displayName} size={26} shape="circle" />
                <span className="sns-author-name">{a.displayName}</span>
                <span className="sns-author-count">{a.postCount ?? ''}</span>
              </button>
            ))}
          </div>
        </aside>

        {/* 动态流（虚拟滚动：长列表仅渲染可视区域，显著降低 DOM 与内存占用） */}
        <div className="sns-feed">
          {feedError && <div className="wp-error">{feedError}</div>}
          {posts.length === 0 && !feedLoading && !feedError && (
            <EmptyState
              icon={Images}
              title={selected.size > 0 || keyword || searchComments || dateJump ? '没有匹配的动态' : '暂无朋友圈数据'}
              hint={selected.size > 0 || keyword || searchComments || dateJump ? '试试调整筛选条件' : '请确认已连接微信账号'}
            />
          )}

          {posts.length > 0 && (
            <Virtuoso
              ref={virtuosoRef}
              className="sns-feed-scroll"
              data={posts}
              computeItemKey={(_, post) => post.id}
              itemContent={renderPostItem}
              components={snsVirtuosoComponents}
              endReached={() => {
                if (hasMore && !loadingRef.current) void loadTimeline(false)
              }}
              scrollerRef={(ref) => {
                feedElRef.current = ref instanceof HTMLElement ? ref : null
              }}
              defaultItemHeight={240}
              increaseViewportBy={{ top: 300, bottom: 600 }}
              overscan={{ main: 1000, reverse: 500 }}
            />
          )}

          {posts.length > 30 && (
            <button
              className="sns-back-top"
              title="回到顶部"
              onClick={() => feedElRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            >
              <ChevronDown size={16} style={{ transform: 'rotate(180deg)' }} />
            </button>
          )}
        </div>
      </div>

      {/* 弹层 */}
      <SnsExportDialog
        open={exportOpen}
        usernames={activeUsernames.length > 0 ? activeUsernames : undefined}
        keyword={keyword || undefined}
        onClose={() => setExportOpen(false)}
        onDone={(summary) => setOverview((prev) => (prev ? { ...prev, totalPosts: prev.totalPosts } : prev))}
      />

      {authorDialog && (
        <ContactSnsTimelineDialog
          open
          username={authorDialog.username}
          displayName={authorDialog.displayName}
          avatarUrl={authorDialog.avatarUrl}
          onClose={() => setAuthorDialog(null)}
        />
      )}

      {debugPost && (
        <div className="wp-overlay" onClick={() => setDebugPost(null)}>
          <div className="wp-dialog debug-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="wp-dialog-head">
              <h3>原始数据</h3>
              <button className="icon-btn-ghost" onClick={() => setDebugPost(null)}>
                <X size={16} />
              </button>
            </div>
            <pre className="debug-pre">{debugPost.rawXml || JSON.stringify(debugPost, null, 2)}</pre>
          </div>
        </div>
      )}

      {previewIndex >= 0 && previewItems[previewIndex] && (
        <SnsPreviewLightbox
          items={previewItems}
          index={previewIndex}
          onClose={() => setPreviewIndex(-1)}
          onNavigate={setPreviewIndex}
        />
      )}
    </div>
  )
}

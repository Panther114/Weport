import { isLocalMediaUrl, normalizeLocalMediaUrl } from '../utils/mediaUrl'
import React, { useState, useEffect, useRef, useMemo } from 'react'
import { Loader2, User } from 'lucide-react'
import { avatarLoadQueue } from '../utils/AvatarLoadQueue'
import './Avatar.scss'

// 全局缓存已成功加载过的头像 URL，用于控制后续是否显示动画
const loadedAvatarCache = new Set<string>()
const MAX_LOADED_AVATAR_CACHE_SIZE = 3000

const rememberLoadedAvatar = (src: string): void => {
    if (!src) return
    if (loadedAvatarCache.has(src)) {
        loadedAvatarCache.delete(src)
    }
    loadedAvatarCache.add(src)

    while (loadedAvatarCache.size > MAX_LOADED_AVATAR_CACHE_SIZE) {
        const oldest = loadedAvatarCache.values().next().value as string | undefined
        if (!oldest) break
        loadedAvatarCache.delete(oldest)
    }
}

interface AvatarProps {
    src?: string
    name?: string
    size?: number | string
    shape?: 'circle' | 'square' | 'rounded'
    className?: string
    lazy?: boolean
    loading?: boolean
    onClick?: () => void
    username?: string
}

export const Avatar = React.memo(function Avatar(props: AvatarProps) {
    const src = normalizeLocalMediaUrl(props.src)
    // Virtualized rows can change identity while an earlier request is still pending.
    return <AvatarImage key={`${props.username || ''}:${src || ''}`} {...props} src={src} />
})

function AvatarImage({ src, name, size = 48, shape = 'rounded', className = '', lazy = true,
    loading = false, onClick, username }: AvatarProps) {
    const [resolvedSrc, setResolvedSrc] = useState(src)
    const isLocalSrc = isLocalMediaUrl(resolvedSrc)
    const isCached = useMemo(() => resolvedSrc ? loadedAvatarCache.has(resolvedSrc) : false, [resolvedSrc])
    const [imageLoaded, setImageLoaded] = useState(isCached)
    const [imageError, setImageError] = useState(false)
    const [shouldLoad, setShouldLoad] = useState(!lazy || isCached || isLocalSrc)
    const [attempt, setAttempt] = useState(0)
    const imgRef = useRef<HTMLImageElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)

    const getAvatarLetter = (): string => {
        if (!name) return '?'
        const chars = [...name]
        return chars[0] || '?'
    }

    useEffect(() => {
        let disposed = false
        if (!resolvedSrc && !username) return
        const start = () => {
            if (!resolvedSrc && username) {
                void window.electronAPI.chat.getContactAvatar(username).then(contact => {
                    if (disposed) return
                    const local = normalizeLocalMediaUrl(contact?.avatarUrl)
                    if (local) setResolvedSrc(local)
                    else setImageError(true)
                }).catch(() => { if (!disposed) setImageError(true) })
                return
            }
            if (!resolvedSrc) return
            if (isLocalSrc || isCached || !lazy) { setShouldLoad(true); return }
            avatarLoadQueue.enqueue(resolvedSrc, attempt > 0).then(() => {
                if (!disposed) { setImageError(false); setShouldLoad(true) }
            }).catch(() => { if (!disposed) setImageError(true) })
        }
        if (!lazy || isLocalSrc || isCached) start()
        else {
            const observer = new IntersectionObserver(entries => {
                if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); start() }
            }, { rootMargin: '100px' })
            if (containerRef.current) observer.observe(containerRef.current)
            return () => { disposed = true; observer.disconnect() }
        }
        return () => { disposed = true }
    }, [resolvedSrc, lazy, isLocalSrc, isCached, attempt, username])

    useEffect(() => {
        if (!imageError || attempt >= 2) return
        let disposed = false
        const timer = setTimeout(async () => {
            // The main process may already have localized a previously failing CDN URL.
            let next = resolvedSrc
            if (username) {
                try {
                    const contact = await window.electronAPI.chat.getContactAvatar(username)
                    next = normalizeLocalMediaUrl(contact?.avatarUrl) || next
                } catch { /* A bounded retry of the original URL remains available. */ }
            }
            if (disposed) return
            setResolvedSrc(next)
            setImageLoaded(false)
            setImageError(false)
            setShouldLoad(isLocalMediaUrl(next) || !lazy)
            setAttempt(value => value + 1)
        }, attempt === 0 ? 1000 : 4000)
        return () => { disposed = true; clearTimeout(timer) }
    }, [imageError, attempt, username, resolvedSrc, lazy])

    useEffect(() => {
        if (shouldLoad && imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
            if (resolvedSrc) rememberLoadedAvatar(resolvedSrc)
            setImageLoaded(true)
            setImageError(false)
        }
    }, [resolvedSrc, shouldLoad, attempt])

    const style = {
        width: typeof size === 'number' ? `${size}px` : size,
        height: typeof size === 'number' ? `${size}px` : size,
    }

    const hasValidUrl = !!resolvedSrc && !imageError && shouldLoad
    const shouldShowLoadingPlaceholder = loading && !hasValidUrl && !imageError

    return (
        <div
            ref={containerRef}
            className={`avatar-component ${shape} ${className}`}
            style={style}
            onClick={onClick}
        >
            {hasValidUrl ? (
                <>
                    {!imageLoaded && <div className="avatar-skeleton" />}
                    <img
                        ref={imgRef}
                        src={resolvedSrc}
                        alt={name || 'avatar'}
                        className={`avatar-image ${imageLoaded ? 'loaded' : ''} ${isCached ? 'instant' : ''}`}
                        onLoad={() => {
                            if (resolvedSrc) {
                                avatarLoadQueue.clearFailed(resolvedSrc)
                                rememberLoadedAvatar(resolvedSrc)
                            }
                            setImageLoaded(true)
                            setImageError(false)
                        }}
                        onError={() => {
                            if (resolvedSrc) {
                                avatarLoadQueue.markFailed(resolvedSrc)
                                loadedAvatarCache.delete(resolvedSrc)
                            }
                            setImageLoaded(false)
                            setImageError(true)
                            setShouldLoad(false)
                        }}
                        loading={lazy ? "lazy" : "eager"}
                        // decoding="async"：头像是一屏几十个的小图，同步解码会把
                        // 解码放进渲染的关键路径（滚动时表现为掉帧）。异步解码把
                        // 它挪出主线程，画面最多晚上一帧出现。
                        decoding="async"
                        referrerPolicy="no-referrer"
                    />
                </>
            ) : shouldShowLoadingPlaceholder ? (
                <div className="avatar-loading">
                    <Loader2 size="50%" className="avatar-loading-icon" />
                </div>
            ) : (
                <div className="avatar-placeholder">
                    {name ? <span className="avatar-letter">{getAvatarLetter()}</span> : <User size="50%" />}
                </div>
            )}
        </div>
    )
}

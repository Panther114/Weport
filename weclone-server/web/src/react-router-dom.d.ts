/**
 * react-router-dom 类型兜底声明。
 *
 * 仅当 `web/node_modules` 尚未安装依赖时参与编译（模块解析失败才回退到本
 * ambient 声明）；一旦真实安装 react-router-dom，解析命中真实类型，本文件
 * 自动失效，可安全保留。只覆盖本项目用到的最小 API 面。
 */
declare module 'react-router-dom' {
  import type { ComponentType, ReactElement, ReactNode } from 'react'

  export interface AnchorLikeProps {
    to: string
    end?: boolean
    replace?: boolean
    className?: string
    children?: ReactNode
  }

  export const BrowserRouter: ComponentType<{ children?: ReactNode }>
  export const Routes: ComponentType<{ children?: ReactNode }>
  export const Route: ComponentType<{ path: string; element: ReactElement }>
  export const Link: ComponentType<AnchorLikeProps>
  export const NavLink: ComponentType<AnchorLikeProps>

  export type SearchParamInit = string | Record<string, string> | URLSearchParams

  export function useNavigate(): (to: string, options?: { replace?: boolean }) => void
  export function useParams(): Readonly<Record<string, string | undefined>>
  export function useSearchParams(): readonly [
    URLSearchParams,
    (next: SearchParamInit, options?: { replace?: boolean }) => void,
  ]
}

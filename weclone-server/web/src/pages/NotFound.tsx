import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <section className="notfound">
      <h1>404</h1>
      <p className="muted">页面不存在，或该克隆已被删除。</p>
      <Link className="btn btn-primary" to="/">返回浏览</Link>
    </section>
  )
}

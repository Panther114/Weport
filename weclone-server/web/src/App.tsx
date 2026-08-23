import { Link, NavLink, Route, Routes } from 'react-router-dom'
import Browse from './pages/Browse'
import Chat from './pages/Chat'
import NotFound from './pages/NotFound'

/** 分享链接说明（静态内容页） */
function ShareHelp() {
  return (
    <article className="help-page">
      <h1>分享链接说明</h1>
      <p className="muted">每个克隆有三种可见性，由所有者在 Weport 客户端中设置：</p>
      <div className="help-grid">
        <div className="card help-card">
          <h3>私有 private</h3>
          <p>仅所有者可见、可聊；不出现在公开浏览页。</p>
        </div>
        <div className="card help-card">
          <h3>公开 public</h3>
          <p>任何人可在「浏览」页看到并发起对话，无需密钥。</p>
        </div>
        <div className="card help-card">
          <h3>链接 link</h3>
          <p>不出现在公开列表；持有链接与 16 位密钥的人可访问：<code>/share/:id?secret=…</code></p>
        </div>
      </div>
      <h2>隐私边界</h2>
      <ul>
        <li>匿名与链接访客只能读取<b>部分人格档案</b>，完整档案仅所有者可见。</li>
        <li>对话内容不做服务端持久化；语料入库前经过双重 PII 脱敏。</li>
        <li>切换可见性会重新生成链接密钥，旧分享链接随即失效。</li>
      </ul>
      <p>
        <Link className="btn btn-primary" to="/">返回浏览</Link>
      </p>
    </article>
  )
}

export default function App() {
  return (
    <div className="app">
      <header className="site-header">
        <Link to="/" className="brand">
          WeClone<span className="brand-sub"> · 人格克隆</span>
        </Link>
        <nav className="site-nav">
          <NavLink to="/" end>浏览</NavLink>
          <NavLink to="/share-help">分享链接说明</NavLink>
        </nav>
      </header>

      <main className="site-main">
        <Routes>
          <Route path="/" element={<Browse />} />
          <Route path="/c/:id" element={<Chat />} />
          <Route path="/chat/:id" element={<Chat />} />
          <Route path="/share/:id" element={<Chat />} />
          <Route path="/share-help" element={<ShareHelp />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      <footer className="site-footer">
        <span>WeClone · Weport 数字分身服务</span>
        <span className="muted">语料经双重 PII 脱敏入库 · 对话内容由 AI 生成，请注意甄别</span>
      </footer>
    </div>
  )
}

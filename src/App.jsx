import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import {
  Activity,
  Archive,
  ArrowRight,
  Bell,
  Bot,
  CalendarRange,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Download,
  FileCheck2,
  Filter,
  Flame,
  Github,
  GitBranch,
  GitCommit,
  GitPullRequest,
  LayoutDashboard,
  LockKeyhole,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  MessageSquare,
  Plus,
  Palette,
  Radar,
  RefreshCw,
  Search,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Tags,
  TestTube2,
  Users,
  Eye,
  ExternalLink,
  X,
  Trash2,
} from 'lucide-react'
import { addWatchedRepository, checkCachedSummary, deleteWatchedRepository, generateRepositorySummary, getAnalysisSettings, getAuthenticationStatus, getDigitalHumanAdapterStatus, getHotPullRequests, getSystemStatus, getWatchedRepositories, getWindow, getWindows, inspectRepositoryAddress, login, repositorySummaryDownloadUrl, retryWindow, saveAnalysisSettings, saveGitHubApiKey, saveProviderApiKey, snoopPullRequest, subscribeToWindowEvents, syncWatchedRepository, testProvider, windowDownloadUrl } from './api'

const navigation = [
  { id: 'overview', label: '态势总览', icon: LayoutDashboard },
  { id: 'signals', label: '技术信号', icon: Radar },
  { id: 'repositories', label: '观察项目', icon: Github },
  { id: 'topics', label: '技术主题', icon: Tags },
  { id: 'windows', label: 'Window 档案', icon: Clock3 },
]

const adminNavigation = [
  { id: 'admin', label: '访问与系统', icon: ShieldCheck },
]

const themeOptions = {
  mineral: { label: '矿物青绿' },
  slate: { label: '雾蓝石墨' },
}

function initialTheme() {
  if (typeof window === 'undefined') return 'mineral'
  try {
    return window.localStorage.getItem('vigil-theme') === 'slate' ? 'slate' : 'mineral'
  } catch {
    return 'mineral'
  }
}

const pageMeta = {
  overview: ['态势总览', '把事件变成值得跟踪的变化'],
  signals: ['技术信号', '等待真实持续采集管线接入'],
  repositories: ['观察项目', '监控范围、branch 与代码上下文'],
  'repository-detail': ['仓库情报档案', '时间段总结、Hot PR 与 Snoop'],
  topics: ['技术主题', '等待真实信号生成后聚合'],
  windows: ['Window 档案', '已归档 Window 与实时执行轨'],
  admin: ['访问与系统', '分析配置与真实运行状态'],
}

function App() {
  const [page, setPage] = useState('overview')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [addRepoOpen, setAddRepoOpen] = useState(false)
  const [repositories, setRepositories] = useState([])
  const [repositoriesState, setRepositoriesState] = useState({ loading: true, error: '' })
  const [selectedRepository, setSelectedRepository] = useState(null)
  const [notice, setNotice] = useState('')
  const [theme, setTheme] = useState(initialTheme)
  const [authentication, setAuthentication] = useState({ loading: true, authenticated: false, setupRequired: false, user: null, error: '' })

  useEffect(() => {
    let active = true
    getAuthenticationStatus()
      .then((status) => { if (active) setAuthentication({ loading: false, error: '', ...status }) })
      .catch((error) => { if (active) setAuthentication({ loading: false, authenticated: false, setupRequired: false, user: null, error: error.message }) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen(true)
      }
      if (event.key === 'Escape') {
        setSearchOpen(false)
        setAddRepoOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    let active = true
    getWatchedRepositories()
      .then(({ repositories: persisted }) => {
        if (!active) return
        setRepositories(persisted || [])
        setSelectedRepository((current) => current ? (persisted || []).find((repository) => repository.id === current.id) || null : null)
        setRepositoriesState({ loading: false, error: '' })
      })
      .catch((error) => {
        if (active) setRepositoriesState({ loading: false, error: error.message })
      })
    return () => { active = false }
  }, [authentication.authenticated])

  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(''), 3600)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      window.localStorage.setItem('vigil-theme', theme)
    } catch {
      // Theme selection still applies for this session when storage is unavailable.
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'slate' ? '#1C242B' : '#1B2221')
  }, [theme])

  const navigate = (target) => {
    setPage(target)
    setSidebarOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const addRepository = (repository) => {
    setRepositories((current) => [repository, ...current])
    setAddRepoOpen(false)
    const syncNote = repository.syncMode === 'full'
      ? repository.syncStatus === 'ready' ? `，全仓已同步到 ${repository.localPath}` : `，全仓同步失败：${repository.syncError}`
      : '，代码将在 Deep Dive 时按需拉取'
    setNotice(`${repository.project || `${repository.org}/${repository.name}`}@${repository.branch || 'main'} 已持久化${syncNote}。`)
    setPage('repositories')
  }

  const openRepository = (repository) => {
    setSelectedRepository(repository)
    setPage('repository-detail')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const updateRepository = (repository) => {
    setRepositories((current) => current.map((item) => item.id === repository.id ? repository : item))
    setSelectedRepository(repository)
  }

  const removeRepository = async (repository) => {
    try {
      await deleteWatchedRepository(repository.id)
      setRepositories((current) => current.filter((item) => item.id !== repository.id))
      setSelectedRepository((current) => current?.id === repository.id ? null : current)
      if (page === 'repository-detail') navigate('repositories')
      setNotice(`${repository.project || repository.name} 已从观察列表移除。`)
    } catch (error) {
      setNotice(`移除 ${repository.project || repository.name} 失败：${error.message}`)
    }
  }

  return (
    <div className="app-shell">
      <Sidebar page={page} navigate={navigate} open={sidebarOpen} repositoryCount={repositories.length} />
      <div className="main-shell">
        <Topbar
          page={page}
          onMenu={() => setSidebarOpen(true)}
          onSearch={() => setSearchOpen(true)}
          theme={theme}
          onThemeChange={setTheme}
        />
        <main className="workspace">
          {page === 'overview' && <Overview navigate={navigate} repositories={repositories} repositoriesState={repositoriesState} onOpenRepository={openRepository} />}
          {page === 'signals' && <SignalsView />}
          {page === 'repositories' && (
            <RepositoriesView repositories={repositories} canManage={authentication.authenticated} onAdd={() => setAddRepoOpen(true)} onSelect={openRepository} onDelete={removeRepository} />
          )}
          {page === 'repository-detail' && (selectedRepository ? <RepositoryDetail repository={selectedRepository} canManage={authentication.authenticated} onBack={() => navigate('repositories')} onRepositoryUpdated={updateRepository} onDelete={removeRepository} /> : <EmptyState icon={Github} title="未选择观察项目" description="请先从观察项目列表打开一个真实仓库。" action="返回观察项目" onAction={() => navigate('repositories')} />)}
          {page === 'topics' && <TopicsView />}
          {page === 'windows' && <WindowsView canManage={authentication.authenticated} />}
          {page === 'admin' && <AdminView authentication={authentication} onAuthenticated={(user) => setAuthentication({ loading: false, authenticated: true, setupRequired: false, user, error: '' })} />}
        </main>
      </div>

      {sidebarOpen && <button className="scrim mobile-scrim" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}
      {searchOpen && <CommandPalette onClose={() => setSearchOpen(false)} navigate={navigate} repositories={repositories} onOpenRepository={openRepository} />}
      {addRepoOpen && authentication.authenticated && <AddRepositoryModal onClose={() => setAddRepoOpen(false)} onAdd={addRepository} />}
      {notice && <div className="toast"><FileCheck2 size={17} />{notice}</div>}
    </div>
  )
}

function LoginScreen({ loading = false, embedded = false, setupRequired = false, error: initialError = '', onAuthenticated }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(initialError)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const result = await login(username, password)
      onAuthenticated?.(result.user)
    } catch (loginError) {
      setError(loginError.message)
    } finally {
      setSubmitting(false)
    }
  }

  const card = <section className="login-card"><span className="login-mark"><LockKeyhole size={22} /></span><span>VIGIL / ACCESS CONTROL</span><h1>{loading ? '正在验证访问权限' : setupRequired ? '尚未配置管理员' : '管理员登录'}</h1>{loading ? <p>正在连接本地服务。</p> : setupRequired ? <p>请在服务端设置 <code>VIGIL_ADMIN_USERNAME</code> 与 <code>VIGIL_ADMIN_PASSWORD</code> 后重启 Vigil。首次启动会创建唯一的管理员账户。</p> : <form onSubmit={submit}><label>用户名<input autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label><label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p className="field-error">{error}</p>}<button className="primary-button" disabled={submitting}>{submitting ? '正在验证' : '登录'} <ArrowRight size={15} /></button></form>}<small>公开页面无需登录；管理员登录后才能更新配置和采集数据。</small></section>
  return embedded ? <div className="admin-login-shell">{card}</div> : <main className="login-shell">{card}</main>
}

function Sidebar({ page, navigate, open, repositoryCount }) {
  return (
    <aside className={`sidebar ${open ? 'is-open' : ''}`}>
      <button className="brand" onClick={() => navigate('overview')} aria-label="返回态势总览">
        <span className="brand-mark"><Radar size={19} strokeWidth={2.4} /></span>
        <span className="brand-name">VIGIL</span>
        <span className="brand-version">/ 01</span>
      </button>

      <div className="nav-label">Monitor</div>
      <nav className="primary-nav" aria-label="主导航">
        {navigation.map((item) => (
          <NavButton key={item.id} item={item.id === 'repositories' ? { ...item, count: repositoryCount } : item} active={page === item.id || (page === 'repository-detail' && item.id === 'repositories')} onClick={() => navigate(item.id)} />
        ))}
      </nav>

      <div className="nav-label admin-label">Administration</div>
      <nav className="primary-nav" aria-label="管理导航">
        {adminNavigation.map((item) => (
          <NavButton key={item.id} item={item} active={page === item.id} onClick={() => navigate(item.id)} />
        ))}
      </nav>

      <div className="sidebar-spacer" />
      <div className="ingest-status">
        <div className="status-heading">
          <span><span className="idle-dot" /> On-demand collection</span>
          <span>LOCAL</span>
        </div>
        <div className="status-caption">未启用持续采集与定时 Window</div>
      </div>

      <button className="user-panel" onClick={() => navigate('admin')}>
        <span className="avatar">LO</span>
        <span className="user-copy">
          <strong>Local mode</strong>
          <small>Authentication disabled</small>
        </span>
        <MoreHorizontal size={17} />
      </button>
    </aside>
  )
}

function NavButton({ item, active, onClick }) {
  const Icon = item.icon
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      <Icon size={18} strokeWidth={active ? 2.3 : 1.8} />
      <span>{item.label}</span>
      {Number.isFinite(item.count) && <small>{item.count}</small>}
    </button>
  )
}

function Topbar({ page, onMenu, onSearch, theme, onThemeChange }) {
  const [title, subtitle] = pageMeta[page]
  return (
    <header className="topbar">
      <button className="icon-button menu-button" onClick={onMenu} aria-label="打开导航"><Menu size={20} /></button>
      <div className="page-title">
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="topbar-actions">
        <div className="window-picker-wrap">
          <button className="window-picker" disabled>
            <span className="archive-dot" />
            <span>
              <small>WINDOW STATUS</small>
              <strong>NOT PUBLISHED</strong>
            </span>
            <Clock3 size={15} />
          </button>
        </div>
        <button className="search-trigger" onClick={onSearch}>
          <Search size={16} />
          <span>搜索情报</span>
          <kbd>⌘ K</kbd>
        </button>
        <ThemePicker theme={theme} onThemeChange={onThemeChange} />
        <button className="icon-button notification-button" aria-label="通知" disabled>
          <Bell size={18} />
        </button>
      </div>
    </header>
  )
}

function ThemePicker({ theme, onThemeChange }) {
  const [open, setOpen] = useState(false)
  const current = themeOptions[theme]
  return (
    <div className="theme-picker">
      <button className="icon-button theme-trigger" onClick={() => setOpen((value) => !value)} aria-label="选择界面主题" aria-expanded={open}>
        <Palette size={17} />
      </button>
      {open && <div className="theme-menu" role="menu" aria-label="界面主题">
        <div><span>THEME</span><strong>{current.label}</strong></div>
        {Object.entries(themeOptions).map(([id, option]) => <button key={id} role="menuitemradio" aria-checked={theme === id} className={theme === id ? 'selected' : ''} onClick={() => { onThemeChange(id); setOpen(false) }}><i className={`theme-swatch ${id}`} /><span>{option.label}</span><small>{theme === id ? '当前' : ''}</small></button>)}
      </div>}
    </div>
  )
}

function Overview({ navigate, repositories, repositoriesState, onOpenRepository }) {
  return (
    <div className="page-enter">
      <section className="window-hero empty-dashboard-hero">
        <div className="hero-grid" />
        <div className="hero-topline">
          <div className="eyebrow"><CircleDot size={14} /> ON-DEMAND REPOSITORY INTELLIGENCE</div>
          <div className="hero-time">LOCAL WORKSPACE</div>
        </div>
        <div className="hero-main">
          <div>
            <p className="hero-kicker">当前运行模式</p>
            <h2>从真实仓库开始观察</h2>
            <p className="hero-brief">Vigil 不再内置演示事件。添加 GitHub 或 Gerrit 仓库后，可按 branch 持久化观察范围，并按需生成时间段报告、Hot Change 与 Snoop 证据。</p>
          </div>
        </div>
        <div className="hero-bottom">
          <div className="hero-stats">
            <Stat value={repositories.length} label="Repositories" />
            <Stat value="ON DEMAND" label="Collection" accent />
            <Stat value="0" label="Signals" />
            <Stat value="0" label="Windows" />
          </div>
          <button className="hero-action" onClick={() => navigate('repositories')}>{repositories.length ? '管理观察项目' : '添加第一个仓库'} <ArrowRight size={16} /></button>
        </div>
      </section>

      <section className="section-block repository-section">
        <SectionHeader index="01" title="真实观察项目" note="仅显示 workspace watchlist 中已经持久化的仓库" action="管理观察列表" onAction={() => navigate('repositories')} />
        {repositoriesState.loading ? (
          <EmptyState icon={LoaderCircle} title="正在读取观察列表" description="从配置的 workspace 加载 watchlist。" spinning />
        ) : repositoriesState.error ? (
          <EmptyState icon={Server} title="无法读取观察列表" description={repositoriesState.error} action="打开系统设置" onAction={() => navigate('admin')} tone="error" />
        ) : repositories.length ? (
          <RepositoryTable rows={repositories} condensed onSelect={onOpenRepository} />
        ) : (
          <EmptyState icon={Github} title="还没有观察项目" description="添加真实 GitHub 或 Gerrit 地址，选择 branch，并决定按需拉取或全仓同步。" action="添加观察项目" onAction={() => navigate('repositories')} />
        )}
      </section>

      <section className="section-block release-boundaries">
        <SectionHeader index="02" title="当前数据边界" note="未采集的数据不以占位数字或示例记录呈现" compact />
        <div className="boundary-cards">
          <div><Radar size={18} /><strong>技术信号</strong><p>尚未接入持续信号管线，当前为空。</p></div>
          <div><Tags size={18} /><strong>技术主题</strong><p>等待真实信号生成后再聚合。</p></div>
          <div><Clock3 size={18} /><strong>Window 档案</strong><p>尚未启用定时发布器，不创建模拟窗口。</p></div>
        </div>
      </section>
    </div>
  )
}

function Stat({ value, label, accent }) {
  return <div className={accent ? 'stat accent' : 'stat'}><strong>{value}</strong><span>{label}</span></div>
}

function SectionHeader({ index, title, note, action, onAction, compact = false }) {
  return (
    <div className={`section-header ${compact ? 'compact' : ''}`}>
      <div className="section-index">{index}</div>
      <div><h2>{title}</h2><p>{note}</p></div>
      {action && <button className="section-action" onClick={onAction}>{action} <ArrowRight size={15} /></button>}
    </div>
  )
}

function RepositoryTable({ rows, condensed = false, onSelect, onDelete }) {
  return (
    <div className={`data-table repository-table ${condensed ? 'condensed' : ''}`}>
      <div className="table-row table-head">
        <span>Repository</span><span>Source</span><span>Branch</span><span>Code context</span><span>Sync status</span><span>Created</span>{onDelete && <span className="table-actions-head" />}
      </div>
      {rows.map((repo) => (
        <div className="table-row" key={repo.id || `${repo.org}/${repo.name}`}>
          <button className="table-row-main" onClick={() => onSelect?.(repo)}>
            <span className="repo-identity">
              <span className="repo-glyph" style={{ '--repo-color': repo.color }}>{repo.initial}</span>
              <span><strong>{repo.name}</strong><small>{repo.host} · {repo.project}</small></span>
            </span>
            <span>{repo.sourceType === 'gerrit' ? 'GERRIT' : 'GITHUB'}</span>
            <span>{repo.branch}</span>
            <span>{repo.syncMode === 'full' ? 'Full local' : 'On demand'}</span>
            <span><StatusPill status={repo.syncStatus === 'ready' ? 'ready' : repo.syncStatus === 'failed' ? 'failed' : repo.syncStatus === 'syncing' ? 'running' : 'idle'} title={repo.syncError || null} />{repo.syncError && <small className="sync-error-hint">{repo.syncError}</small>}</span>
            <span>{repo.createdAt ? new Date(repo.createdAt).toLocaleDateString('zh-CN') : '—'}</span>
          </button>
          {onDelete && (
            <button className="table-row-action icon-button" title={`移除 ${repo.project}`} onClick={(e) => { e.stopPropagation(); if (window.confirm(`确定要移除观察项目 ${repo.project} 吗？`)) onDelete(repo) }}><Trash2 size={14} /></button>
          )}
        </div>
      ))}
      {!rows.length && <div className="table-empty">没有匹配的真实观察项目。</div>}
    </div>
  )
}

function RiskLabel({ risk }) {
  return <span className={`risk-label ${risk.toLowerCase()}`}><i />{risk}</span>
}

function EmptyState({ icon: Icon, title, description, action, onAction, tone = 'neutral', spinning = false }) {
  return <div className={`product-empty-state ${tone}`}><span><Icon className={spinning ? 'spin' : ''} size={24} /></span><div><strong>{title}</strong><p>{description}</p>{action && <button className="secondary-button" onClick={onAction}>{action} <ArrowRight size={14} /></button>}</div></div>
}

function SignalsView() {
  return (
    <div className="page-enter empty-page">
      <EmptyState icon={Radar} title="尚未生成技术信号" description="当前版本只在仓库档案中按需采集和分析。持续采集与跨仓库信号排序尚未启用，因此这里不会展示示例信号。" />
    </div>
  )
}

function RepositoriesView({ repositories, canManage, onAdd, onSelect, onDelete }) {
  const [query, setQuery] = useState('')
  const filtered = repositories.filter((repo) => `${repo.host || ''}/${repo.org}/${repo.name}/${repo.branch || ''}`.toLowerCase().includes(query.toLowerCase()))
  return (
    <div className="page-enter">
      <div className="repository-overview-strip">
        <div><span>MONITORED</span><strong>{repositories.length}</strong></div>
        <div><span>GITHUB</span><strong>{repositories.filter((repository) => repository.sourceType === 'github').length}</strong></div>
        <div><span>GERRIT</span><strong>{repositories.filter((repository) => repository.sourceType === 'gerrit').length}</strong></div>
        <div><span>FULL LOCAL</span><strong>{repositories.filter((repository) => repository.syncMode === 'full').length}</strong></div>
      </div>
      <div className="content-toolbar repo-toolbar">
        <label className="inline-search"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索 host / project / branch" /></label>
        <div className="toolbar-right">{canManage ? <button className="primary-button" onClick={onAdd}><Plus size={16} /> 添加观察项目</button> : <span className="public-readonly-note"><LockKeyhole size={14} /> 公开只读</span>}</div>
      </div>
      <RepositoryTable rows={filtered} onSelect={onSelect} onDelete={canManage ? onDelete : null} />
      <div className="table-footnote"><span><span className="idle-dot" /> Watchlist 已持久化到 workspace</span><span>采集仅在用户请求报告、Hot Change 或 Snoop 时执行</span></div>
    </div>
  )
}

const repositoryRangePresets = [
  { id: '8h', label: '8 小时', hours: 8 },
  { id: '24h', label: '24 小时', hours: 24 },
  { id: '7d', label: '7 天', hours: 168 },
  { id: '30d', label: '30 天', hours: 720 },
  { id: 'custom', label: '自定义', hours: null },
]

function rangeFromHours(hours) {
  const now = Date.now()
  const gridSizeMs = hours * 60 * 60 * 1000
  const boundaryMs = Math.floor(now / gridSizeMs) * gridSizeMs
  const to = new Date(boundaryMs + gridSizeMs)
  const from = new Date(boundaryMs)
  return { from: from.toISOString(), to: to.toISOString() }
}

function localInputValue(iso) {
  const date = new Date(iso)
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return shifted.toISOString().slice(0, 16)
}

function MermaidBlock({ source }) {
  const [state, setState] = useState({ svg: '', error: '' })
  const id = useRef(`vigil-mermaid-${Math.random().toString(36).slice(2)}`)

  useEffect(() => {
    let active = true
    setState({ svg: '', error: '' })
    void import('mermaid')
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: {
            primaryColor: '#dce9e3',
            primaryBorderColor: '#2f6f5c',
            primaryTextColor: '#17201e',
            lineColor: '#63766e',
            secondaryColor: '#edf3f0',
            tertiaryColor: '#f3f6f5',
            fontFamily: 'Manrope, sans-serif',
          },
        })
        return mermaid.render(id.current, source)
      })
      .then(({ svg }) => { if (active) setState({ svg, error: '' }) })
      .catch((error) => { if (active) setState({ svg: '', error: `Mermaid 图表无法渲染：${error.message || error}` }) })
    return () => { active = false }
  }, [source])

  if (state.error) return <div className="report-embed-error">{state.error}</div>
  if (!state.svg) return <div className="report-embed-loading">正在渲染 Mermaid 图…</div>
  return <div className="report-mermaid" dangerouslySetInnerHTML={{ __html: state.svg }} />
}

function EChartsBlock({ source }) {
  const element = useRef(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let chart
    let observer
    void import('echarts')
      .then((echarts) => {
        const parsed = JSON.parse(source)
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('ECharts 代码块必须是 option JSON 对象')
        chart = echarts.init(element.current, undefined, { renderer: 'svg' })
        chart.setOption({ ...parsed, tooltip: { ...(parsed.tooltip || {}), renderMode: 'richText' } }, true)
        observer = new ResizeObserver(() => chart?.resize())
        observer.observe(element.current)
        setError('')
      })
      .catch((renderError) => setError(`ECharts 图表无法渲染：${renderError.message || renderError}`))
    return () => {
      observer?.disconnect()
      chart?.dispose()
    }
  }, [source])

  if (error) return <div className="report-embed-error">{error}</div>
  return <div className="report-echarts" ref={element} aria-label="报告图表" />
}

function KaTeXBlock({ source }) {
  try {
    return <div className="report-katex" dangerouslySetInnerHTML={{ __html: katex.renderToString(source, { displayMode: true, throwOnError: false, trust: false }) }} />
  } catch (error) {
    return <div className="report-embed-error">KaTeX 公式无法渲染：{error.message || String(error)}</div>
  }
}

function MarkdownReport({ content }) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[rehypeKatex]}
    components={{
      a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      pre: ({ children }) => {
        const code = Array.isArray(children) ? children[0] : children
        const language = /language-([\w-]+)/.exec(code?.props?.className || '')?.[1]?.toLowerCase()
        const source = String(code?.props?.children || '').replace(/\n$/, '')
        if (language === 'mermaid') return <MermaidBlock source={source} />
        if (language === 'echarts') return <EChartsBlock source={source} />
        if (language === 'katex' || language === 'tex') return <KaTeXBlock source={source} />
        return <pre>{children}</pre>
      },
    }}
  >{content || ''}</ReactMarkdown>
}

function RepositoryDetail({ repository, canManage, onBack, onRepositoryUpdated, onDelete }) {
  const [preset, setPreset] = useState('24h')
  const [range, setRange] = useState(() => rangeFromHours(24))
  const [report, setReport] = useState(null)
  const [summaryState, setSummaryState] = useState({ status: 'idle', error: '' })
  const [hotPullRequests, setHotPullRequests] = useState([])
  const [hotState, setHotState] = useState({ status: 'idle', error: '' })
  const [snoop, setSnoop] = useState({ open: false, status: 'idle', pullRequest: null, data: null, error: '' })
  const [localSync, setLocalSync] = useState(repository)

  useEffect(() => {
    setReport(null)
    setSummaryState({ status: 'idle', error: '' })
    setHotPullRequests([])
    setHotState({ status: 'idle', error: '' })
    setLocalSync(repository)
  }, [repository])

  useEffect(() => {
    let aborted = false
    if (!repository.id) return
    setSummaryState({ status: 'loading', error: '' })
    checkCachedSummary(repository, range).then((cached) => {
      if (aborted) return
      if (cached) {
        setReport(cached)
        setHotPullRequests(cached.snapshot.hotPullRequests)
        setHotState({ status: 'live', error: '' })
        setSummaryState({ status: 'success', error: '' })
      } else {
        setSummaryState({ status: 'idle', error: '' })
      }
    }).catch((error) => {
      if (aborted) return
      setSummaryState({ status: 'idle', error: error.message })
    })
    return () => { aborted = true }
  }, [repository.id, range.from, range.to])

  const syncFull = async () => {
    if (!repository.id) return
    setLocalSync((current) => ({ ...current, syncMode: 'full', syncStatus: 'syncing', syncError: '' }))
    try {
      const result = await syncWatchedRepository(repository.id)
      setLocalSync(result.repository)
      onRepositoryUpdated?.(result.repository)
    } catch (error) {
      setLocalSync((current) => ({ ...current, syncStatus: 'failed', syncError: error.message }))
    }
  }

  const selectPreset = (item) => {
    setPreset(item.id)
    if (item.hours) setRange(rangeFromHours(item.hours))
    setReport(null)
  }

  const generate = async (force = false) => {
    setSummaryState({ status: 'loading', error: '' })
    try {
      const result = await generateRepositorySummary(repository, range, force)
      setReport(result)
      setHotPullRequests(result.snapshot.hotPullRequests)
      setHotState({ status: 'live', error: '' })
      setSummaryState({ status: 'success', error: '' })
    } catch (error) {
      setSummaryState({ status: 'error', error: error.message })
    }
  }

  const refreshHot = async () => {
    setHotState({ status: 'loading', error: '' })
    try {
      const result = await getHotPullRequests(repository, range)
      setHotPullRequests(result.pullRequests)
      setHotState({ status: 'live', error: '' })
    } catch (error) {
      setHotState({ status: 'error', error: error.message })
    }
  }

  const openSnoop = async (pullRequest) => {
    setSnoop({ open: true, status: 'loading', pullRequest, data: null, error: '' })
    try {
      const data = await snoopPullRequest(repository, pullRequest.number)
      setSnoop({ open: true, status: 'success', pullRequest, data, error: '' })
    } catch (error) {
      setSnoop({ open: true, status: 'error', pullRequest, data: null, error: error.message })
    }
  }

  const counts = report?.snapshot.counts || { commits: 0, pullRequests: 0, issues: 0, releases: 0 }
  return (
    <div className="page-enter repository-detail-page">
      <section className="repository-intel-header">
        <div className="repository-breadcrumb"><button onClick={onBack}>Repositories</button><ChevronRight size={13} /><span>{repository.host || 'github.com'} / {repository.project || `${repository.org}/${repository.name}`} / {repository.branch || 'main'}</span></div>
        <div className="repository-intel-title">
          <span className="repo-glyph large" style={{ '--repo-color': repository.color }}>{repository.initial}</span>
          <div><small>{repository.sourceType === 'gerrit' ? 'GERRIT' : 'GITHUB'} REPOSITORY INTELLIGENCE FILE</small><h2>{repository.name}</h2><p>{repository.org} · 观察分支 {repository.branch || 'main'} · {localSync.lastFullSync ? `全仓同步 ${new Date(localSync.lastFullSync).toLocaleString('zh-CN')}` : '尚未执行全仓同步'}</p></div>
          <div className="repository-intel-score"><span>COLLECTION</span><strong>{report ? 'READY' : '—'}</strong><small>{report ? '本时间段已采集' : '按需触发'}</small></div>
          {canManage && onDelete && <button className="icon-button danger-icon-button" title="移除观察项目" onClick={() => { if (window.confirm(`确定要移除 ${repository.project} 的观察吗？已生成的报告会保留在磁盘上。`)) onDelete(repository) }}><Trash2 size={16} /></button>}
        </div>
        <div className="range-control">
          <div className="range-presets">{repositoryRangePresets.map((item) => <button key={item.id} className={preset === item.id ? 'active' : ''} onClick={() => selectPreset(item)}>{item.label}</button>)}</div>
          {preset === 'custom' && <div className="custom-range"><label>From<input type="datetime-local" value={localInputValue(range.from)} onChange={(event) => setRange((current) => ({ ...current, from: new Date(event.target.value).toISOString() }))} /></label><ArrowRight size={15} /><label>To<input type="datetime-local" value={localInputValue(range.to)} onChange={(event) => setRange((current) => ({ ...current, to: new Date(event.target.value).toISOString() }))} /></label></div>}
          <div className="range-caption"><CalendarRange size={15} /><span>{new Date(range.from).toLocaleString('zh-CN')} — {new Date(range.to).toLocaleString('zh-CN')}</span></div>
        </div>
        {repository.id && <div className={`local-sync-strip ${localSync.syncStatus || 'on-demand'}`}><GitBranch size={16} /><div><strong>{localSync.syncMode === 'full' ? `FULL LOCAL · ${(localSync.syncStatus || 'pending').toUpperCase()}` : 'ON-DEMAND MIRROR'}</strong><small>{localSync.syncStatus === 'ready' ? localSync.localPath : localSync.syncError || '仅在 Deep Dive 时拉取代码；可切换为完整本地工作副本。'}</small></div>{canManage && <button disabled={localSync.syncStatus === 'syncing'} onClick={syncFull}>{localSync.syncStatus === 'syncing' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{localSync.syncMode === 'full' ? '立即同步' : '全仓同步到本地'}</button>}</div>}
      </section>

      <div className="repository-window-stats">
          <div><span>COMMITS</span><strong>{counts.commits}</strong></div><div><span>{repository.sourceType === 'gerrit' ? 'ACTIVE CHANGES' : 'ACTIVE PRS'}</span><strong>{counts.pullRequests}</strong></div><div><span>ISSUES</span><strong>{counts.issues}</strong></div><div><span>RELEASES</span><strong>{counts.releases}</strong></div><div><span>HOTTEST {repository.sourceType === 'gerrit' ? 'CHANGE' : 'PR'}</span><strong className="warm">{hotPullRequests[0]?.hotScore || '—'}</strong><small>heat score</small></div>
      </div>

      <section className="section-block repository-summary-section">
        <div className="repository-section-head">
          <div><span>01 / TIME-RANGE BRIEF</span><h2>这段时间发生了什么</h2><p>完全相同的仓库与时间边界会直接复用已落盘报告。</p></div>
          <div className="repository-section-actions">
            {report && <><a className="secondary-button" href={repositorySummaryDownloadUrl(repository, range, 'markdown')} download>下载 Markdown</a><a className="secondary-button" href={repositorySummaryDownloadUrl(repository, range, 'json')} download>下载 JSON</a></>}
            {canManage && report && <button className="secondary-button" onClick={() => generate(true)}><RefreshCw size={15} /> 重新生成</button>}
            {canManage && <button className="primary-button" disabled={summaryState.status === 'loading'} onClick={() => generate(false)}>{summaryState.status === 'loading' ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{summaryState.status === 'loading' ? '采集与分析中' : '生成时间段总结'}</button>}
          </div>
        </div>
        {summaryState.error && <div className="repository-error">{summaryState.error}</div>}
        {report ? (
          <div className="generated-report">
            <div className="report-provenance"><StatusPill status={report.cacheHit ? 'cached' : 'published'} /><span>artifact: {report.artifactId}</span><span>{report.analysis.mode === 'provider' ? report.analysis.model : 'structured fallback'}</span><time>{new Date(report.generatedAt).toLocaleString('zh-CN')}</time></div>
            <div className="generated-report-content"><MarkdownReport content={report.analysis.content} /></div>
          </div>
        ) : (
          <div className="empty-report-state"><span><CalendarRange size={22} /></span><div><strong>尚未生成这个时间段的报告</strong><p>Vigil 会先查找相同时间键的存盘结果；未命中时才采集 {repository.sourceType === 'gerrit' ? 'Gerrit' : 'GitHub'} 并运行分析。</p></div></div>
        )}
      </section>

      <section className="section-block hot-pr-section">
        <div className="repository-section-head">
          <div><span>02 / HOT {repository.sourceType === 'gerrit' ? 'CHANGES' : 'PULL REQUESTS'}</span><h2>最新热门 {repository.sourceType === 'gerrit' ? 'Change' : 'PR'}</h2><p>讨论强度 × votes/reactions × diff scope × freshness。</p></div>
          {canManage && <button className="secondary-button" disabled={hotState.status === 'loading'} onClick={refreshHot}><RefreshCw className={hotState.status === 'loading' ? 'spin' : ''} size={15} /> {hotState.status === 'loading' ? '收集中' : `收集最新 Hot ${repository.sourceType === 'gerrit' ? 'Change' : 'PR'}`}</button>}
        </div>
        <div className="hot-pr-source"><StatusPill status={hotState.status === 'live' ? 'live' : hotState.status === 'error' ? 'failed' : hotState.status === 'loading' ? 'running' : 'idle'} /><span>{hotState.error || (hotState.status === 'live' ? `${repository.sourceType === 'gerrit' ? 'Gerrit' : 'GitHub'} 实时采集结果` : hotState.status === 'loading' ? '正在读取远端数据' : '尚未采集这个时间段的热门变更')}</span></div>
        <div className="hot-pr-list">
          {hotPullRequests.map((pullRequest, index) => (
            <article className="hot-pr-row" key={pullRequest.number}>
              <span className="hot-pr-rank">{String(index + 1).padStart(2, '0')}</span>
              <span className="hot-pr-heat"><Flame size={15} /><strong>{pullRequest.hotScore}</strong><small>HEAT</small></span>
              <div className="hot-pr-copy"><small>#{pullRequest.number} · {pullRequest.author} · {new Date(pullRequest.updatedAt).toLocaleString('zh-CN')}</small><h3>{pullRequest.title}</h3><div><span><MessageSquare size={12} /> {pullRequest.comments}</span><span><Code2 size={12} /> {pullRequest.changedFiles} files</span><span><GitCommit size={12} /> +{pullRequest.additions} −{pullRequest.deletions}</span><RiskLabel risk={pullRequest.hotScore >= 85 ? 'High' : pullRequest.hotScore >= 70 ? 'Med' : 'Low'} /></div></div>
              <div className="hot-pr-actions"><a href={pullRequest.url} target="_blank" rel="noreferrer" aria-label={`打开 ${repository.sourceType === 'gerrit' ? 'Gerrit Change' : 'GitHub PR'} ${pullRequest.number}`}><ExternalLink size={15} /></a>{canManage && <button onClick={() => openSnoop(pullRequest)}><Eye size={15} /> Snoop</button>}</div>
            </article>
          ))}
          {!hotPullRequests.length && <div className="hot-pr-empty"><GitBranch size={20} /><strong>还没有真实采集结果</strong><span>点击右上角按钮，从 {repository.host} 实时采集所选分支。</span></div>}
        </div>
      </section>
      {snoop.open && <SnoopDrawer state={snoop} onClose={() => setSnoop({ open: false, status: 'idle', pullRequest: null, data: null, error: '' })} />}
    </div>
  )
}

function SnoopDrawer({ state, onClose }) {
  const data = state.data
  return (
    <div className="snoop-layer" role="dialog" aria-modal="true" aria-labelledby="snoop-title">
      <button className="scrim" onClick={onClose} aria-label="关闭 Snoop" />
      <aside className="snoop-drawer">
        <div className="snoop-head"><div><span>CHANGE SNOOP / #{state.pullRequest.number}</span><h2 id="snoop-title">{state.pullRequest.title}</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div>
        {state.status === 'loading' && <div className="snoop-loading"><LoaderCircle className="spin" size={24} /><strong>正在收集完整 PR 证据</strong><span>files · commits · reviews · comments · checks</span></div>}
        {state.status === 'error' && <div className="snoop-error"><strong>Snoop 失败</strong><p>{state.error}</p></div>}
        {data && <div className="snoop-body">
          <div className="snoop-facts"><div><span>FILES</span><strong>{data.files.length}</strong></div><div><span>COMMITS</span><strong>{data.commits.length}</strong></div><div><span>REVIEWS</span><strong>{data.reviews.length}</strong></div><div><span>COMMENTS</span><strong>{data.comments.length}</strong></div><div><span>CHECKS</span><strong>{data.checks.length}</strong></div></div>
          <section><h3>PR 状态</h3><div className="snoop-status-grid"><span>Base<strong>{data.pullRequest.baseBranch}</strong></span><span>Head<strong>{data.pullRequest.headBranch}</strong></span><span>Mergeable<strong>{data.pullRequest.mergeableState || 'unknown'}</strong></span><span>Reviewers<strong>{data.pullRequest.requestedReviewers.join(', ') || '—'}</strong></span></div></section>
          <section><h3>Changed files</h3><div className="snoop-file-list">{data.files.slice(0, 30).map((file) => <div key={file.filename}><code>{file.filename}</code><span>+{file.additions} −{file.deletions}</span></div>)}</div></section>
          <section><h3>Review evidence</h3><div className="snoop-review-list">{data.reviews.slice(0, 12).map((review, index) => <div key={`${review.author}-${index}`}><span>{review.state}</span><strong>{review.author}</strong><p>{review.body || 'No written review body'}</p></div>)}{!data.reviews.length && <p className="empty-inline">还没有 review。</p>}</div></section>
          <section><h3>CI / Checks</h3><div className="snoop-check-list">{data.checks.map((check) => <div key={check.name}><i className={check.conclusion === 'success' ? 'success' : 'other'} /><strong>{check.name}</strong><span>{check.conclusion || check.status}</span></div>)}</div></section>
          <div className="snoop-foot"><span>Collected {new Date(data.collectedAt).toLocaleString('zh-CN')}</span><a className="primary-button" href={state.pullRequest.url} target="_blank" rel="noreferrer">{data.sourceType === 'gerrit' ? 'Gerrit' : 'GitHub'} <ExternalLink size={14} /></a></div>
        </div>}
      </aside>
    </div>
  )
}

function TopicsView() {
  return (
    <div className="page-enter empty-page">
      <EmptyState icon={Tags} title="尚未生成技术主题" description="主题热力图依赖真实的跨仓库信号。目前持续信号管线未启用，因此不会展示演示 taxonomy 或热度。" />
    </div>
  )
}

function mergeWindowEvents(events, incoming) {
  return [...(events || []).filter((event) => event.sequence !== incoming.sequence), incoming]
    .sort((left, right) => left.sequence - right.sequence)
}

function windowStatusFromEvent(event) {
  const statuses = {
    'window.published': 'published',
    'window.degraded': 'degraded',
    'window.failed': 'failed',
    'window.started': 'running',
    'window.queued': 'queued',
  }
  return statuses[event.type] || null
}

function formatWindowTimestamp(value, timezone, options = {}) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone || 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: options.withSeconds ? '2-digit' : undefined,
    hour12: false,
  }).format(new Date(value))
}

function windowIntervalLabel(record) {
  return `${formatWindowTimestamp(record.rangeStart, record.timezone)} — ${formatWindowTimestamp(record.rangeEnd, record.timezone)}`
}

function eventPosition(record, event, instant = Date.now()) {
  const start = new Date(record.rangeStart).getTime()
  const end = new Date(record.rangeEnd).getTime()
  const duration = Math.max(1, end - start)
  const position = ((new Date(event?.at || instant).getTime() - start) / duration) * 100
  return Math.min(100, Math.max(0, position))
}

function eventDescription(event) {
  const labels = {
    'window.queued': 'Window 已进入队列',
    'window.started': 'Window 开始执行',
    'window.recovered': '检测到中断执行，已恢复到队列',
    'window.retry.queued': '失败 Window 已重新排队',
    'window.aggregate.started': '开始汇总跨仓库报告',
    'window.published': 'Window 已发布',
    'window.degraded': 'Window 已降级发布',
    'window.failed': 'Window 执行失败',
    'repository.sync.started': '开始同步仓库',
    'repository.sync.succeeded': '仓库同步完成',
    'repository.sync.failed': '仓库同步失败',
    'repository.collect.started': '开始采集情报',
    'repository.collect.succeeded': '仓库采集完成',
    'repository.collect.failed': '仓库采集失败',
    'repository.summary.started': '开始生成仓库报告',
    'repository.summary.succeeded': '仓库报告已持久化',
    'repository.summary.failed': 'Provider 回退为结构化报告',
  }
  return labels[event.type] || event.type
}

function windowOutcomeCounts(record) {
  const runs = record.repositoryRuns || []
  return {
    total: runs.length || (record.repositories || []).length,
    succeeded: runs.filter((run) => run.status === 'succeeded').length,
    failed: runs.filter((run) => run.status === 'failed').length,
  }
}

function WindowsView({ canManage }) {
  const [state, setState] = useState({ loading: true, windows: [], scheduler: null, error: '' })
  const [selectedId, setSelectedId] = useState(null)
  const [selectedEvent, setSelectedEvent] = useState(null)
  const [retrying, setRetrying] = useState(false)

  const refreshArchive = () => {
    setState((current) => ({ ...current, loading: true, error: '' }))
    return getWindows()
      .then((payload) => {
        const windows = payload.windows || []
        setState({ loading: false, windows, scheduler: payload.scheduler || null, error: '' })
        setSelectedId((current) => {
          if (current && windows.some((window) => window.id === current)) return current
          return windows.find((window) => ['running', 'queued'].includes(window.status))?.id || windows[0]?.id || null
        })
      })
      .catch((error) => setState((current) => ({ ...current, loading: false, error: error.message })))
  }

  useEffect(() => {
    let active = true
    getWindows()
      .then((payload) => {
        if (!active) return
        const windows = payload.windows || []
        setState({ loading: false, windows, scheduler: payload.scheduler || null, error: '' })
        setSelectedId((current) => current && windows.some((window) => window.id === current)
          ? current
          : windows.find((window) => ['running', 'queued'].includes(window.status))?.id || windows[0]?.id || null)
      })
      .catch((error) => { if (active) setState({ loading: false, windows: [], scheduler: null, error: error.message }) })
    return () => { active = false }
  }, [])

  const selected = state.windows.find((window) => window.id === selectedId) || null
  const selectedIsLive = Boolean(selected && ['queued', 'running'].includes(selected.status))

  useEffect(() => {
    if (!selectedId) return undefined
    let active = true
    getWindow(selectedId)
      .then(({ window: record }) => {
        if (!active) return
        setState((current) => ({ ...current, windows: current.windows.map((window) => window.id === record.id ? record : window) }))
      })
      .catch(() => {})
    return () => { active = false }
  }, [selectedId])

  useEffect(() => {
    if (!selectedId || !selectedIsLive) return undefined
    return subscribeToWindowEvents(selectedId, (event) => {
      setState((current) => ({
        ...current,
        windows: current.windows.map((window) => {
          if (window.id !== selectedId) return window
          return {
            ...window,
            status: windowStatusFromEvent(event) || window.status,
            events: mergeWindowEvents(window.events, event),
          }
        }),
      }))
      if (['window.published', 'window.degraded', 'window.failed'].includes(event.type)) {
        getWindow(selectedId)
          .then(({ window: record }) => setState((current) => ({ ...current, windows: current.windows.map((window) => window.id === record.id ? record : window) })))
          .catch(() => {})
      }
    })
  }, [selectedId, selectedIsLive])

  const retry = async () => {
    if (!selected || retrying) return
    setRetrying(true)
    try {
      const payload = await retryWindow(selected.id)
      setState((current) => ({ ...current, windows: current.windows.map((window) => window.id === selected.id ? payload.window : window) }))
      setSelectedEvent(null)
      await refreshArchive()
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }))
    } finally {
      setRetrying(false)
    }
  }

  if (state.loading && !state.windows.length) return <div className="page-enter empty-page"><EmptyState icon={LoaderCircle} title="正在读取 Window 档案" description="读取已持久化的时间段报告与实时调度状态。" spinning /></div>
  if (state.error && !state.windows.length) return <div className="page-enter empty-page"><EmptyState icon={Clock3} title="无法读取 Window 档案" description={state.error} action="重试" onAction={refreshArchive} tone="error" /></div>
  if (!state.windows.length) {
    const scheduler = state.scheduler || {}
    return <div className="page-enter empty-page"><EmptyState icon={Clock3} title="还没有已发布的 Window" description={scheduler.enabled ? `调度已启用，下一次边界为 ${formatWindowTimestamp(scheduler.nextPublishAt, scheduler.timezone)}。完成后会在这里保留真实事件与报告。` : '请在管理员的分析引擎中启用 Window 调度；默认上海时区在 00:00、08:00、16:00 完成并发布。'} /></div>
  }

  return (
    <div className="page-enter window-page">
      <header className="window-page-head">
        <div><span>WINDOW RAIL / DURABLE ARCHIVE</span><h2>从采集到发布，一条可回放的真实轨迹。</h2><p>每个事件均来自 Window ledger；运行中的 Window 通过 SSE 实时落入这条轨道。</p></div>
        <div className="window-page-actions"><div className={`schedule-chip ${state.scheduler?.enabled ? 'enabled' : ''}`}><Activity size={14} /><span>{state.scheduler?.enabled ? `${state.scheduler.timezone} · ${state.scheduler.publishTimes?.join(' / ')}` : 'SCHEDULE DISABLED'}</span></div><button className="secondary-button" onClick={refreshArchive}><RefreshCw size={15} /> 刷新档案</button></div>
      </header>
      {state.error && <div className="window-inline-error">{state.error}</div>}
      <div className="window-workbench">
        <WindowArchive windows={state.windows} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setSelectedEvent(null) }} />
        {selected && <WindowRail record={selected} canManage={canManage} retrying={retrying} onRetry={retry} onSelectEvent={setSelectedEvent} />}
      </div>
      {selectedEvent && selected && <WindowEventDrawer event={selectedEvent} timezone={selected.timezone} onClose={() => setSelectedEvent(null)} />}
    </div>
  )
}

function WindowArchive({ windows, selectedId, onSelect }) {
  return <aside className="window-archive" aria-label="Window 档案列表"><div className="window-archive-head"><Archive size={17} /><span>ARCHIVE · {windows.length}</span></div>{windows.map((record) => { const counts = windowOutcomeCounts(record); return <button type="button" key={record.id} className={`window-archive-row ${record.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(record.id)}><span className="archive-range"><strong>{windowIntervalLabel(record)}</strong><small>{record.timezone} · published slot {record.publishTime}</small></span><span className="archive-outcome"><i>{counts.succeeded}</i> ok <b>{counts.failed}</b> failed</span><StatusPill status={record.status} /><ChevronRight size={16} /></button> })}</aside>
}

function WindowRail({ record, canManage, retrying, onRetry, onSelectEvent }) {
  const events = record.events || []
  const counts = windowOutcomeCounts(record)
  const nowPosition = eventPosition(record, null)
  const live = ['queued', 'running'].includes(record.status)
  return <section className="window-rail-panel">
    <div className="window-rail-topline"><div><span>WINDOW / {record.id}</span><h2>{windowIntervalLabel(record)}</h2><small>{record.timezone} · half-open interval · {events.length} persisted events</small></div><StatusPill status={record.status} /></div>
    <div className="window-stat-band"><div><span>REPOSITORIES</span><strong>{counts.total}</strong></div><div><span>SUCCEEDED</span><strong>{counts.succeeded}</strong></div><div className={counts.failed ? 'warning' : ''}><span>FAILED</span><strong>{counts.failed}</strong></div><div><span>ANALYSIS</span><strong>{record.report?.analysis?.mode || 'PENDING'}</strong></div></div>
    <div className="window-rail-wrap">
      <div className="rail-time-label rail-start">{formatWindowTimestamp(record.rangeStart, record.timezone)}</div><div className="rail-time-label rail-mid">{formatWindowTimestamp(new Date((new Date(record.rangeStart).getTime() + new Date(record.rangeEnd).getTime()) / 2).toISOString(), record.timezone)}</div><div className="rail-time-label rail-end">{formatWindowTimestamp(record.rangeEnd, record.timezone)}</div>
      <div className="window-rail-axis" aria-label="Window event timeline">
        {live && <span className="rail-now" style={{ '--position': `${nowPosition}%` }}><i /><em>NOW</em></span>}
        {events.map((event) => <button type="button" key={`${event.sequence}-${event.type}`} className={`rail-event ${event.type.includes('failed') ? 'failed' : ''} ${event.type.startsWith('window.') ? 'window-event' : ''}`} style={{ '--position': `${eventPosition(record, event)}%` }} onClick={() => onSelectEvent(event)} aria-label={`${eventDescription(event)}，${formatWindowTimestamp(event.at, record.timezone, { withSeconds: true })}`}><i /><span>{event.sequence}</span></button>)}
      </div>
      <p className="rail-caption">{live ? '实时执行中：新事件会在持久化后进入轨道。' : '已归档：轨道按持久化事件的实际发生时间回放。'}</p>
    </div>
    <div className="window-event-list">{events.map((event) => <button type="button" key={`${event.sequence}-list`} onClick={() => onSelectEvent(event)} className={event.type.includes('failed') ? 'failed' : ''}><time>{formatWindowTimestamp(event.at, record.timezone, { withSeconds: true })}</time><span>{event.repository || 'WINDOW'}</span><strong>{eventDescription(event)}</strong><ChevronRight size={14} /></button>)}</div>
    <div className="window-report-zone"><div className="window-report-actions"><div><span>WINDOW REPORT</span><small>{record.report?.generatedAt ? `generated ${formatWindowTimestamp(record.report.generatedAt, record.timezone, { withSeconds: true })}` : '正在等待报告持久化'}</small></div>{record.artifact && <div><a className="secondary-button" href={windowDownloadUrl(record.id, 'markdown')}><Download size={14} /> Markdown</a><a className="secondary-button" href={windowDownloadUrl(record.id, 'json')}><Download size={14} /> JSON</a></div>}</div>{record.report?.analysis?.content ? <div className="window-report-content"><MarkdownReport content={record.report.analysis.content} /></div> : <p className="window-report-pending">汇总报告会在仓库任务全部结束并完成持久化后出现。</p>}{record.status === 'failed' && canManage && <button className="primary-button retry-window-button" onClick={onRetry} disabled={retrying}><RefreshCw size={15} className={retrying ? 'spin' : ''} /> {retrying ? '重新排队中…' : '重试这个 Window'}</button>}</div>
  </section>
}

function WindowEventDrawer({ event, timezone, onClose }) {
  return <div className="window-drawer-layer" role="dialog" aria-modal="true" aria-label="Window 事件详情"><button className="scrim" onClick={onClose} aria-label="关闭事件详情" /><aside className="window-event-drawer"><div className="window-event-drawer-head"><div><span>EVENT #{event.sequence}</span><h2>{eventDescription(event)}</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div><div className="event-detail-grid"><div><span>TIME</span><strong>{formatWindowTimestamp(event.at, timezone, { withSeconds: true })}</strong></div><div><span>STAGE</span><strong>{event.stage || 'window'}</strong></div><div><span>REPOSITORY</span><strong>{event.repository || '—'}</strong></div><div><span>ELAPSED</span><strong>{event.elapsedMs === undefined ? '—' : `${event.elapsedMs} ms`}</strong></div></div>{event.message && <div className="event-detail-message"><span>DETAIL</span><p>{event.message}</p></div>}<div className="event-detail-type"><CircleDot size={15} /><code>{event.type}</code></div></aside></div>
}

function AdminView({ authentication, onAuthenticated }) {
  const [tab, setTab] = useState('analysis')
  if (authentication.loading) return <div className="admin-section"><EmptyState icon={LoaderCircle} title="正在验证管理员会话" description="公开页面不需要登录；仅管理区需要管理员身份。" spinning /></div>
  if (!authentication.authenticated) return <LoginScreen embedded setupRequired={authentication.setupRequired} error={authentication.error} onAuthenticated={onAuthenticated} />
  return (
    <div className="page-enter admin-page">
      <div className="security-boundary">
        <div className="boundary-copy"><span className="security-icon"><LockKeyhole size={20} /></span><div><small>ADMIN SESSION ENABLED</small><h2>管理员认证已启用。</h2><p>未登录用户无法读取或修改 Vigil API。当前第一阶段只支持服务端初始化的管理员；PAM、多角色、配额与审计仍是后续边界。</p></div></div>
        <div className="boundary-flow"><span>BOOTSTRAP ADMIN</span><ChevronRight size={14} /><span>SESSION</span><ChevronRight size={14} /><span>RBAC · NEXT</span><ChevronRight size={14} /><span>AUDIT · NEXT</span></div>
      </div>
      <div className="admin-tabs">
        {[['users','用户与角色'],['analysis','分析引擎'],['system','系统状态'],['audit','审计日志']].map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {tab === 'users' && (
        <section className="admin-section">
          <div className="admin-section-head"><div><h2>管理员账户</h2><p>首次启动由服务端环境变量初始化，密码只存为 scrypt 哈希。</p></div><StatusPill status="ready" /></div>
          <div className="empty-state"><Users size={26} /><h3>{authentication.user?.username || 'admin'} · administrator</h3><p>当前会话拥有系统配置权限。多管理员、角色分级与 PAM 需要在后续接入真实身份目录后启用。</p></div>
        </section>
      )}
      {tab === 'analysis' && <AnalysisSettings />}
      {tab === 'system' && <SystemStatus />}
      {tab === 'audit' && <AuditLog />}
    </div>
  )
}

const fallbackAnalysisSettings = {
  workspace: { directory: '.vigil/workspace' },
  github: { apiBaseUrl: 'https://api.github.com', requestTimeoutSeconds: 30 },
  gerrit: { usernameEnv: 'GERRIT_USERNAME', passwordEnv: 'GERRIT_HTTP_PASSWORD', requestTimeoutSeconds: 30 },
  provider: { name: 'OpenAI compatible', baseUrl: 'https://api.openai.com/v1', requiresApiKey: true, model: 'gpt-4.1-mini', timeoutSeconds: 120, maxOutputTokens: 6000 },
  deepDive: { enabled: true, pullRequests: true, releases: true, criticalPaths: true, attentionThreshold: 80, changedLinesThreshold: 500, maxContextFiles: 24, maxDiffBytes: 2097152 },
  repositoryContext: { strategy: 'git-mirror', fetchOnDeepDive: true },
  digitalHuman: { enabled: false, bindingRef: '', adapter: 'unconfigured' },
  windowSchedule: { enabled: false, timezone: 'Asia/Shanghai', publishTimes: ['00:00', '08:00', '16:00'], repositoryConcurrency: 3, maxCatchUpWindows: 12, maxAttempts: 3 },
}

function AnalysisSettings() {
  const [settings, setSettings] = useState(fallbackAnalysisSettings)
  const [credential, setCredential] = useState({ apiKeyConfigured: false, requiresApiKey: true, providerReady: false })
  const [apiKey, setApiKey] = useState('')
  const [githubCredential, setGithubCredential] = useState({ apiKeyConfigured: false })
  const [githubApiKey, setGithubApiKey] = useState('')
  const [adapterStatus, setAdapterStatus] = useState({ status: 'loading', contract: 'pending', digitalHumans: [] })
  const [state, setState] = useState({ loading: true, action: '', message: '', error: '' })

  useEffect(() => {
    getAnalysisSettings()
      .then((payload) => {
        setSettings(payload.settings)
        setCredential(payload.credential)
        setGithubCredential(payload.githubCredential)
        setState({ loading: false, action: '', message: '', error: '' })
        return getDigitalHumanAdapterStatus().then(setAdapterStatus)
      })
      .catch((error) => setState({ loading: false, action: '', message: '', error: error.message }))
  }, [])

  const update = (section, key, value) => {
    setSettings((current) => ({ ...current, [section]: { ...current[section], [key]: value } }))
    setState((current) => ({ ...current, message: '', error: '' }))
  }

  const save = async () => {
    setState({ loading: false, action: 'save', message: '', error: '' })
    try {
      const payload = await saveAnalysisSettings(settings)
      const [keyPayload, githubKeyPayload] = await Promise.all([
        apiKey.trim() ? saveProviderApiKey(apiKey) : null,
        githubApiKey.trim() ? saveGitHubApiKey(githubApiKey) : null,
      ])
      setSettings(payload.settings)
      setCredential(keyPayload?.credential || payload.credential)
      setGithubCredential(githubKeyPayload?.credential || payload.githubCredential)
      setApiKey('')
      setGithubApiKey('')
      setState({ loading: false, action: '', message: apiKey.trim() || githubApiKey.trim() ? '分析配置与加密密钥已保存' : '分析配置、Window 调度与数字人绑定已保存', error: '' })
    } catch (error) {
      setState({ loading: false, action: '', message: '', error: error.message })
    }
  }

  const test = async () => {
    setState({ loading: false, action: 'test', message: '', error: '' })
    try {
      const result = await testProvider(settings)
      setState({ loading: false, action: '', message: `连接成功 · ${result.latencyMs} ms · 发现 ${result.models.length} 个模型`, error: '' })
    } catch (error) {
      setState({ loading: false, action: '', message: '', error: error.message })
    }
  }

  const provider = settings.provider
  const github = settings.github
  const gerrit = settings.gerrit
  const deepDive = settings.deepDive
  const digitalHuman = settings.digitalHuman
  const windowSchedule = settings.windowSchedule || fallbackAnalysisSettings.windowSchedule
  return (
    <section className="admin-section analysis-settings">
      <div className="admin-section-head">
        <div><h2>Workspace、Provider 与数字人</h2><p>仓库代码进入受控工作目录；模型密钥只保留在服务端；绑定数字人后调用其 Flyclaw runtime 能力。</p></div>
        <div className="settings-actions"><button className="secondary-button" onClick={test} disabled={Boolean(state.action)}><TestTube2 size={16} /> {state.action === 'test' ? '测试中…' : '测试 Provider'}</button><button className="primary-button" onClick={save} disabled={Boolean(state.action)}><Save size={16} /> {state.action === 'save' ? '保存中…' : '保存配置'}</button></div>
      </div>

      <div className="analysis-flow">
        <span><Github size={16} /><i>DISCOVERY</i><strong>GitHub / Gerrit</strong></span><ChevronRight size={15} /><span><GitPullRequest size={16} /><i>TRIGGER</i><strong>PR / Change</strong></span><ChevronRight size={15} /><span><Server size={16} /><i>CONTEXT</i><strong>git clone / fetch</strong></span><ChevronRight size={15} /><span><Bot size={16} /><i>EXECUTION</i><strong>{digitalHuman.enabled ? 'Digital human' : 'OpenAI compatible'}</strong></span>
      </div>

      {(state.message || state.error) && <div className={`settings-message ${state.error ? 'error' : 'success'}`}>{state.error || state.message}</div>}

      <div className="workspace-config-strip">
        <span className="settings-panel-icon"><Server size={18} /></span>
        <div><small>WORKSPACE DIRECTORY</small><strong>Repository mirrors、diff context 与分析 artifacts 的根目录</strong></div>
        <input value={settings.workspace.directory} onChange={(event) => update('workspace', 'directory', event.target.value)} placeholder="/absolute/path/to/vigil-workspace" />
        <span className="workspace-path-note">保存时创建 repositories/ 与 artifacts/，目录权限为 0700</span>
      </div>
      <div className="workspace-config-strip github-config-strip">
        <span className="settings-panel-icon"><Github size={18} /></span>
        <div><small>GITHUB COLLECTION</small><strong>Hot PR、Snoop 与时间段事件采集</strong></div>
        <div className="github-config-fields"><input value={github.apiBaseUrl} onChange={(event) => update('github', 'apiBaseUrl', event.target.value)} placeholder="https://api.github.com" /><input type="password" autoComplete="new-password" value={githubApiKey} onChange={(event) => setGithubApiKey(event.target.value)} placeholder={githubCredential.apiKeyConfigured ? 'GitHub Token 已配置；留空则不替换' : '粘贴 Fine-grained GitHub Token'} /><input type="number" min="5" max="120" value={github.requestTimeoutSeconds} onChange={(event) => update('github', 'requestTimeoutSeconds', Number(event.target.value))} aria-label="GitHub request timeout" /></div>
        <span className="workspace-path-note"><LockKeyhole size={13} /> Token 仅加密保存在本机 Vigil 服务端，不回传浏览器；公开仓库可留空。{githubCredential.apiKeyConfigured ? '当前已配置。' : '当前尚未配置。'}</span>
      </div>
      <div className="workspace-config-strip github-config-strip">
        <span className="settings-panel-icon"><GitBranch size={18} /></span>
        <div><small>GERRIT COLLECTION</small><strong>Change、Review、Comments 与 Label/CI 采集</strong></div>
        <div className="github-config-fields"><input value={gerrit.usernameEnv} onChange={(event) => update('gerrit', 'usernameEnv', event.target.value)} placeholder="GERRIT_USERNAME" /><input value={gerrit.passwordEnv} onChange={(event) => update('gerrit', 'passwordEnv', event.target.value)} placeholder="GERRIT_HTTP_PASSWORD" /><input type="number" min="5" max="120" value={gerrit.requestTimeoutSeconds} onChange={(event) => update('gerrit', 'requestTimeoutSeconds', Number(event.target.value))} aria-label="Gerrit request timeout" /></div>
        <span className="workspace-path-note">公开 Gerrit 无需凭据；私有 Gerrit 使用服务端环境变量，并通过 /a/ REST 认证路径访问</span>
      </div>

      <section className="schedule-settings">
        <div className="schedule-settings-head"><div><span className="settings-panel-icon acid"><Clock3 size={18} /></span><div><small>WINDOW SCHEDULE</small><h3>跨仓库 Window 发布器</h3><p>仅在已完整结束的时间段运行；服务重启后会补跑未发布的历史 Window。</p></div></div><Toggle checked={windowSchedule.enabled} onChange={(value) => update('windowSchedule', 'enabled', value)} label={windowSchedule.enabled ? '已启用' : '未启用'} /></div>
        <div className="schedule-settings-grid"><label className="settings-field"><span>IANA timezone</span><input value={windowSchedule.timezone} onChange={(event) => update('windowSchedule', 'timezone', event.target.value)} placeholder="Asia/Shanghai" /></label><label className="settings-field"><span>Publish times · HH:mm</span><input value={windowSchedule.publishTimes.join(', ')} onChange={(event) => update('windowSchedule', 'publishTimes', event.target.value.split(',').map((value) => value.trim()).filter(Boolean))} placeholder="00:00, 08:00, 16:00" /></label><label className="settings-field"><span>Repository concurrency</span><input type="number" min="1" max="8" value={windowSchedule.repositoryConcurrency} onChange={(event) => update('windowSchedule', 'repositoryConcurrency', Number(event.target.value))} /></label><label className="settings-field"><span>Catch-up Windows</span><input type="number" min="1" max="96" value={windowSchedule.maxCatchUpWindows} onChange={(event) => update('windowSchedule', 'maxCatchUpWindows', Number(event.target.value))} /></label><label className="settings-field"><span>Max attempts</span><input type="number" min="1" max="5" value={windowSchedule.maxAttempts} onChange={(event) => update('windowSchedule', 'maxAttempts', Number(event.target.value))} /></label></div>
        <div className="schedule-settings-note"><Activity size={14} /><span>保存后服务会立即扫描已结束但未发布的 Window。部分仓库失败仍会发布 degraded 报告；全部失败按持久化退避重试。不会提前创建当前未结束的时间段。</span></div>
      </section>

      <div className="settings-columns">
        <div className="settings-panel">
          <div className="settings-panel-head"><span className="settings-panel-icon"><Bot size={18} /></span><div><small>PROVIDER</small><h3>OpenAI-compatible endpoint</h3></div><StatusPill status={credential.apiKeyConfigured ? 'ready' : 'missing'} /></div>
          <label className="settings-field"><span>Display name</span><input value={provider.name} onChange={(event) => update('provider', 'name', event.target.value)} /></label>
          <label className="settings-field"><span>Base URL</span><input value={provider.baseUrl} onChange={(event) => update('provider', 'baseUrl', event.target.value)} placeholder="https://api.openai.com/v1" /></label>
          <div className="settings-field-grid">
            <label className="settings-field"><span>Model</span><input value={provider.model} onChange={(event) => update('provider', 'model', event.target.value)} /></label>
            <label className="settings-field"><span>API Key · 加密本地保存</span><input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={credential.apiKeyConfigured ? '已配置；留空则不替换' : '输入 Provider API Key'} /></label>
          </div>
          <div className="settings-field-grid">
            <label className="settings-field"><span>Timeout · sec</span><input type="number" min="5" max="600" value={provider.timeoutSeconds} onChange={(event) => update('provider', 'timeoutSeconds', Number(event.target.value))} /></label>
            <label className="settings-field"><span>Max output</span><input type="number" min="256" value={provider.maxOutputTokens} onChange={(event) => update('provider', 'maxOutputTokens', Number(event.target.value))} /></label>
          </div>
          <div className="credential-note"><LockKeyhole size={14} /><span>密钥使用 AES-256-GCM 加密后存于本机服务端，设置 API 不会返回明文。{credential.apiKeyConfigured ? '当前已配置。' : provider.requiresApiKey ? '当前尚未配置。' : '当前 Provider 不要求 API Key。'}</span></div>
        </div>

        <div className="settings-panel">
          <div className="settings-panel-head"><span className="settings-panel-icon acid"><Sparkles size={18} /></span><div><small>TRIGGER POLICY</small><h3>何时进行 Deep Dive</h3></div><Toggle checked={deepDive.enabled} onChange={(value) => update('deepDive', 'enabled', value)} label="启用" /></div>
          <div className="trigger-toggles"><Toggle checked={deepDive.pullRequests} onChange={(value) => update('deepDive', 'pullRequests', value)} label="Pull Request" /><Toggle checked={deepDive.releases} onChange={(value) => update('deepDive', 'releases', value)} label="Release / breaking" /><Toggle checked={deepDive.criticalPaths} onChange={(value) => update('deepDive', 'criticalPaths', value)} label="Critical paths" /></div>
          <div className="settings-field-grid">
            <label className="settings-field"><span>Attention Score ≥</span><input type="number" min="0" max="100" value={deepDive.attentionThreshold} onChange={(event) => update('deepDive', 'attentionThreshold', Number(event.target.value))} /></label>
            <label className="settings-field"><span>Changed lines ≥</span><input type="number" min="1" value={deepDive.changedLinesThreshold} onChange={(event) => update('deepDive', 'changedLinesThreshold', Number(event.target.value))} /></label>
          </div>
          <div className="settings-field-grid">
            <label className="settings-field"><span>Max context files</span><input type="number" min="1" value={deepDive.maxContextFiles} onChange={(event) => update('deepDive', 'maxContextFiles', Number(event.target.value))} /></label>
            <label className="settings-field"><span>Max diff · MB</span><input type="number" min="1" value={Math.round(deepDive.maxDiffBytes / 1048576)} onChange={(event) => update('deepDive', 'maxDiffBytes', Number(event.target.value) * 1048576)} /></label>
          </div>
          <div className="context-strategy"><div><Server size={16} /><span><strong>Git mirror on demand</strong><small>普通事件不拉代码；触发 Deep Dive 后 clone，后续只 fetch。</small></span></div><StatusPill status="configured" /></div>
          <div className="context-warning">公共仓库可直接使用；私有 GitHub/Gerrit 需要对应的服务端 Git 与 API 凭据。</div>
        </div>
      </div>

      <div className="digital-human-panel">
        <div className="digital-human-head">
          <div><span className="settings-panel-icon acid"><Bot size={18} /></span><div><small>DIGITAL HUMAN ADAPTER</small><h3>数字人绑定接口预留</h3><p>当前不依赖 Flyclaw 正在重构的 employee/profile/assignment contract。</p></div></div>
          <div className="digital-human-actions"><StatusPill status="reserved" /><Toggle checked={digitalHuman.enabled} disabled={adapterStatus.status === 'unconfigured'} onChange={(value) => update('digitalHuman', 'enabled', value)} label="使用数字人" /></div>
        </div>
        <div className="adapter-contract">
          <div><span>01</span><code>listAvailable()</code><small>列出系统当前可绑定的数字人</small></div>
          <ChevronRight size={15} />
          <div><span>02</span><code>resolveBinding(ref)</code><small>把 Vigil 保存的引用解析成运行时绑定</small></div>
          <ChevronRight size={15} />
          <div><span>03</span><code>invokeDeepDive()</code><small>使用数字人的能力执行仓库深潜</small></div>
        </div>
        <div className="adapter-binding-row">
          <label className="settings-field"><span>Binding reference <i>由未来 adapter 定义</i></span><input value={digitalHuman.bindingRef} onChange={(event) => update('digitalHuman', 'bindingRef', event.target.value)} placeholder="尚未绑定" /></label>
          <div className="adapter-state"><span>ADAPTER</span><strong>{digitalHuman.adapter}</strong><small>contract: {adapterStatus.contract} · {adapterStatus.digitalHumans?.length || 0} available</small></div>
        </div>
        <div className="adapter-note"><LockKeyhole size={14} /> 当前默认 adapter 明确返回 unconfigured；启用前仍由 OpenAI-compatible Provider 执行 Deep Dive。之后只替换 adapter 实现，不改 Vigil 的配置和分析流程。</div>
      </div>
    </section>
  )
}

function Toggle({ checked, onChange, label, disabled = false }) {
  return <label className={`toggle-control ${disabled ? 'disabled' : ''}`}><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span className="toggle-track"><i /></span><em>{label}</em></label>
}

function SystemStatus() {
  const [state, setState] = useState({ loading: true, status: null, error: '' })
  const refresh = () => {
    setState((current) => ({ ...current, loading: true, error: '' }))
    getSystemStatus()
      .then((status) => setState({ loading: false, status, error: '' }))
      .catch((error) => setState({ loading: false, status: null, error: error.message }))
  }
  useEffect(refresh, [])

  if (state.loading && !state.status) return <section className="admin-section"><EmptyState icon={LoaderCircle} title="正在读取系统状态" description="检查 API、workspace 与服务端配置。" spinning /></section>
  if (state.error) return <section className="admin-section"><EmptyState icon={Server} title="无法读取系统状态" description={state.error} action="重试" onAction={refresh} tone="error" /></section>

  const status = state.status
  const collectionStatus = status.collection.scheduled ? (status.collection.currentWindow ? 'running' : 'ready') : 'idle'
  const collectionDetail = status.collection.scheduled
    ? `${status.collection.timezone} · ${status.collection.publishTimes.join(' / ')} · next ${status.collection.nextPublishAt ? new Date(status.collection.nextPublishAt).toLocaleString('zh-CN', { timeZone: status.collection.timezone }) : '—'}`
    : 'on demand · scheduled ingestion disabled'
  const services = [
    ['Local API', 'healthy', `checked ${new Date(status.checkedAt).toLocaleString('zh-CN')}`],
    ['Workspace', status.workspace.available ? 'ready' : 'missing', status.workspace.directory],
    ['OpenAI-compatible provider', status.provider.credentialConfigured ? 'ready' : 'missing', `${status.provider.name} · ${status.provider.model}`],
    ['Repository collection', collectionStatus, collectionDetail],
  ]
  return <section className="admin-section"><div className="admin-section-head"><div><h2>系统状态</h2><p>只显示当前 API 实际读取到的本地配置与持久化状态。</p></div><button className="secondary-button" disabled={state.loading} onClick={refresh}><Activity size={16} /> {state.loading ? '刷新中' : '刷新状态'}</button></div><div className="service-grid">{services.map(([name, serviceStatus, detail]) => <div className="service-row" key={name}><span className={`service-light ${serviceStatus}`} /><div><strong>{name}</strong><small>{detail}</small></div><StatusPill status={serviceStatus} /></div>)}</div><div className="system-facts"><div><span>WATCH REPOSITORIES</span><strong>{status.repositories.total}</strong><small>{status.repositories.github} GitHub · {status.repositories.gerrit} Gerrit</small></div><div><span>FULL LOCAL READY</span><strong>{status.repositories.fullSyncReady}</strong><small>{status.repositories.fullSyncFailed} failed</small></div><div><span>GITHUB TOKEN</span><strong>{status.collection.githubTokenConfigured ? 'READY' : 'NOT SET'}</strong><small>公开仓库可不配置</small></div><div><span>GERRIT CREDENTIALS</span><strong>{status.collection.gerritCredentialsConfigured ? 'READY' : 'NOT SET'}</strong><small>公开 Gerrit 可不配置</small></div></div></section>
}

function AuditLog() {
  return <section className="admin-section"><div className="admin-section-head"><div><h2>审计日志</h2><p>审计存储尚未接入，因此没有可展示的真实记录。</p></div><button className="secondary-button" disabled><Filter size={16} /> 筛选</button></div><EmptyState icon={FileCheck2} title="没有审计数据" description="当前版本不会用示例操作填充审计列表。" /></section>
}

function StatusPill({ status, title }) {
  const labelMap = { live: 'LIVE', published: 'PUBLISHED', degraded: 'DEGRADED', queued: 'QUEUED', revised: 'REVISED', active: 'ACTIVE', pending: 'PENDING', healthy: 'HEALTHY', running: 'RUNNING', ready: 'READY', missing: 'NOT READY', configured: 'CONFIGURED', reserved: 'ADAPTER RESERVED', cached: 'CACHE HIT', failed: 'FAILED', idle: 'ON DEMAND' }
  return <span className={`status-pill ${status}`} title={title}><i />{labelMap[status] || status.toUpperCase()}</span>
}

function CommandPalette({ onClose, navigate, repositories, onOpenRepository }) {
  const [query, setQuery] = useState('')
  const items = useMemo(() => [
    ...navigation.map((item) => ({ label: item.label, meta: '前往页面', icon: item.icon, action: () => navigate(item.id) })),
    ...repositories.map((repository) => ({ label: repository.project, meta: `${repository.sourceType} · ${repository.branch}`, icon: GitBranch, action: () => onOpenRepository(repository) })),
  ].filter((item) => `${item.label} ${item.meta}`.toLowerCase().includes(query.toLowerCase())), [query, repositories, navigate, onOpenRepository])
  return (
    <div className="modal-layer" role="dialog" aria-modal="true" aria-label="搜索">
      <button className="scrim" onClick={onClose} aria-label="关闭搜索" />
      <div className="command-dialog">
        <div className="command-input"><Search size={19} /><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索页面或真实观察项目…" /><kbd>ESC</kbd></div>
        <div className="command-results">
          <span className="command-label">{query ? '搜索结果' : '快速前往'}</span>
          {items.slice(0, 7).map((item, index) => { const Icon = item.icon; return <button key={`${item.label}-${index}`} onClick={() => { item.action(); onClose() }}><span className="command-icon"><Icon size={16} /></span><span><strong>{item.label}</strong><small>{item.meta}</small></span><ArrowRight size={15} /></button> })}
          {!items.length && <div className="empty-result">没有匹配的情报。</div>}
        </div>
        <div className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 移动</span><span><kbd>↵</kbd> 打开</span><span>当前为本地单用户模式</span></div>
      </div>
    </div>
  )
}

function AddRepositoryModal({ onClose, onAdd }) {
  const [url, setUrl] = useState('')
  const [weight, setWeight] = useState('1.0')
  const [criticalPaths, setCriticalPaths] = useState('')
  const [error, setError] = useState('')
  const [inspection, setInspection] = useState(null)
  const [branch, setBranch] = useState('')
  const [state, setState] = useState('idle')
  const [fullSync, setFullSync] = useState(false)

  const inspect = async () => {
    setState('inspecting')
    setError('')
    setInspection(null)
    try {
      const result = await inspectRepositoryAddress(url)
      setInspection(result)
      setBranch(result.defaultBranch)
      setState('ready')
    } catch (inspectError) {
      setError(inspectError.message)
      setState('idle')
    }
  }

  const submit = async (event) => {
    event.preventDefault()
    if (!inspection) { setError('请先探测地址并选择 branch。'); return }
    if (!branch) { setError('请选择需要持续观察的 branch。'); return }
    setState('saving')
    setError('')
    try {
      const { repository } = await addWatchedRepository({ ...inspection, branch }, { weight, criticalPaths, syncMode: fullSync ? 'full' : 'on-demand' })
      onAdd(repository)
    } catch (saveError) {
      setError(saveError.message)
      setState('ready')
    }
  }
  return (
    <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby="add-repo-title">
      <button className="scrim" onClick={onClose} aria-label="关闭" />
      <form className="repo-modal" onSubmit={submit}>
        <div className="modal-header"><div><span>LOCAL / NEW WATCH</span><h2 id="add-repo-title">添加观察项目</h2><p>探测真实远端、选择 branch，并持久化到当前 workspace。</p></div><button type="button" className="icon-button" onClick={onClose}><X size={19} /></button></div>
        <div className="permission-banner"><LockKeyhole size={18} /><span><strong>当前为本地单用户模式</strong><small>尚未启用身份认证；支持 GitHub HTTPS 与 Gerrit HTTPS / SSH / Change 页面地址。</small></span></div>
        <label className="form-field"><span>Repository address <i>GitHub / Gerrit</i></span><div className="repository-address-row"><div className="field-with-icon"><Github size={17} /><input autoFocus value={url} onChange={(e) => { setUrl(e.target.value); setError(''); setInspection(null); setBranch(''); setState('idle') }} placeholder="owner/repository 或 ssh://user@gerrit:29418/project" /></div><button type="button" className="secondary-button" disabled={!url.trim() || state === 'inspecting' || state === 'saving'} onClick={inspect}>{state === 'inspecting' ? <LoaderCircle className="spin" size={15} /> : <Radar size={15} />}{state === 'inspecting' ? '探测中' : '探测分支'}</button></div>{error && <small className="field-error">{error}</small>}</label>
        {inspection && <div className="repository-inspection">
          <span className={`source-badge ${inspection.sourceType}`}>{inspection.sourceType}</span>
          <div><small>REMOTE SOURCE</small><strong>{inspection.host} / {inspection.project}</strong><span>{inspection.branches.length} branches · default {inspection.defaultBranch}</span></div>
          <FileCheck2 size={18} />
        </div>}
        <div className="form-grid">
          <label className="form-field"><span>Observed branch <i>持久化身份的一部分</i></span><select disabled={!inspection} value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">先探测远端地址</option>{inspection?.branches.map((item) => <option value={item} key={item}>{item}{item === inspection.defaultBranch ? ' · default' : ''}</option>)}</select></label>
          <label className="form-field"><span>Repository weight</span><select value={weight} onChange={(e) => setWeight(e.target.value)}><option value="0.5">0.5 · Low priority</option><option value="1.0">1.0 · Standard</option><option value="1.5">1.5 · High priority</option><option value="2.0">2.0 · Critical</option></select></label>
        </div>
        <label className="form-field"><span>Critical paths <i>每行一个</i></span><textarea value={criticalPaths} onChange={(e) => setCriticalPaths(e.target.value)} rows="4" /></label>
        <label className={`full-sync-option ${fullSync ? 'selected' : ''}`}><input type="checkbox" checked={fullSync} onChange={(event) => setFullSync(event.target.checked)} /><span className="full-sync-icon"><GitBranch size={17} /></span><span><strong>全仓同步到本地 Workspace</strong><small>完整 clone 所有历史与远端分支，并将所选 branch checkout 到 repositories/full/。</small></span><span className="sync-choice">{fullSync ? 'FULL LOCAL' : 'ON DEMAND'}</span></label>
        <div className="quota-preview"><div><span>代码上下文模式</span><strong>{fullSync ? '完整 Git 工作副本' : '按需 Mirror'}</strong></div><p>当前未启用仓库数量配额或后台定时采集；网络访问只在地址探测、手动同步或情报请求时发生。</p></div>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={!inspection || !branch || state === 'saving'}>{state === 'saving' ? '正在持久化' : '添加并持久化'} {state === 'saving' ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}</button></div>
      </form>
    </div>
  )
}

export default App

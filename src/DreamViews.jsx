import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  GitBranch,
  History,
  LoaderCircle,
  LockKeyhole,
  Radar,
  RefreshCw,
  Search,
  Sparkles,
  Tags,
  XCircle,
} from 'lucide-react'

import { getSignal, getSignals, getTopic, getTopics, triggerDream } from './api'
import { dreamCollectionState, forecastTone, formatDreamTime, percentScore, runOutcomeLabel } from './dream-view-model'

const entityConfig = {
  signals: {
    eyebrow: 'SIGNAL LEDGER',
    label: '技术信号',
    noun: '信号',
    icon: Radar,
    getList: getSignals,
    getDetail: getSignal,
  },
  topics: {
    eyebrow: 'TECHNICAL TOPICS',
    label: '技术主题',
    noun: '主题',
    icon: Tags,
    getList: getTopics,
    getDetail: getTopic,
  },
}

const stateCopy = {
  disabled: ['Dream 未启用', '在管理区启用每日 Dream，它会从已封闭的 midnight Window 中继续挖掘。'],
  unavailable: ['Dream 尚未就绪', 'Window 时区、子夜发布点或 Provider 还未满足运行条件。'],
  never_run: ['账本尚未建立', '配置已就绪；等待首个完整日界或由管理员手动触发。'],
  running: ['Dream 正在挖掘', '候选批次正在扫描、扩展证据并与已知账本去重。'],
  refreshing: ['Dream 正在刷新', '已有结果仍可阅读；新批次完成后会原子更新。'],
  no_finding: ['本轮无新发现', '候选不足以推广，或已被已知指纹覆盖；这是有效结果，不是空页故障。'],
  blocked: ['本轮被证据边界阻塞', '必需仓库或 Window 材料不完整；游标未前移，可安全重试。'],
  failed: ['Dream 运行失败', '该批次未发布到账本，原有信号和主题仍保持一致。'],
  empty: ['暂无可展示的结果', '运行已完成，但当前筛选条件下没有记录。'],
  error: ['无法读取 Dream 账本', '请保留当前页面并重试；已加载数据不会被清空。'],
}

function MarkdownText({ children }) {
  return <div className="dream-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{children || '—'}</ReactMarkdown></div>
}

function compactId(value) {
  if (!value) return '—'
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

function StatusToken({ value = 'unknown' }) {
  return <span className={`dream-token ${String(value).replaceAll('_', '-')}`}><i />{String(value).replaceAll('_', ' ')}</span>
}

function Score({ label, value }) {
  const score = percentScore(value)
  return <span className="dream-score" title={`${label} ${score}%`}><small>{label}</small><strong>{score}</strong><i><b style={{ width: `${score}%` }} /></i></span>
}

function Metric({ label, value, hint }) {
  return <div><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div>
}

function DreamBanner({ state, dream, error, canManage, onTrigger, action }) {
  if (state === 'ready') return null
  const [title, description] = stateCopy[state] || stateCopy.empty
  const Icon = state === 'failed' || state === 'error' ? XCircle : state === 'blocked' || state === 'unavailable' ? AlertTriangle : state === 'running' || state === 'refreshing' ? LoaderCircle : CircleDot
  const detail = state === 'unavailable' && dream?.reasons?.length ? dream.reasons.join(' · ') : state === 'error' ? error : ''
  return (
    <div className={`dream-state-banner ${state}`} role={state === 'error' ? 'alert' : 'status'}>
      <Icon className={state === 'running' || state === 'refreshing' ? 'spin' : ''} size={17} />
      <div><strong>{title}</strong><span>{description}</span>{detail && <small>{detail}</small>}</div>
      {canManage && ['never_run', 'no_finding', 'blocked', 'failed'].includes(state) && <button className="secondary-button compact" onClick={onTrigger} disabled={Boolean(action)}><Sparkles size={13} />{action ? '已提交…' : '运行最近日界'}</button>}
    </div>
  )
}

function useDreamLedger(kind, initialSelection = '') {
  const config = entityConfig[kind]
  const listRequest = useRef(0)
  const pendingInitialSelection = useRef(initialSelection)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [collection, setCollection] = useState({ items: [], total: 0, dream: null, loading: true, refreshing: false, error: '' })
  const [selectedId, setSelectedId] = useState(initialSelection)
  const [detail, setDetail] = useState(null)
  const [detailState, setDetailState] = useState({ loading: false, error: '' })
  const [action, setAction] = useState('')

  const load = async ({ background = false } = {}) => {
    const requestId = ++listRequest.current
    setCollection((current) => ({ ...current, loading: !background && !current.items.length, refreshing: background || Boolean(current.items.length), error: '' }))
    try {
      const payload = await config.getList({ query, status, limit: 100 })
      if (requestId !== listRequest.current) return
      setCollection({ items: payload.items || [], total: payload.total || 0, dream: payload.dream || null, loading: false, refreshing: false, error: '' })
      setSelectedId((current) => {
        if (current && current === pendingInitialSelection.current) {
          pendingInitialSelection.current = ''
          return current
        }
        return (payload.items || []).some((item) => item.id === current) ? current : payload.items?.[0]?.id || ''
      })
    } catch (error) {
      if (requestId !== listRequest.current) return
      setCollection((current) => ({ ...current, loading: false, refreshing: false, error: error.message }))
    }
  }

  useEffect(() => {
    if (!initialSelection) return
    pendingInitialSelection.current = initialSelection
    setSelectedId(initialSelection)
  }, [initialSelection])

  useEffect(() => {
    const timer = setTimeout(() => { void load() }, query ? 180 : 0)
    return () => {
      clearTimeout(timer)
      listRequest.current += 1
    }
    // load is intentionally scoped to current filters.
  }, [query, status, kind])

  useEffect(() => {
    let active = true
    if (!selectedId) { setDetail(null); setDetailState({ loading: false, error: '' }); return () => { active = false } }
    setDetailState({ loading: true, error: '' })
    config.getDetail(selectedId)
      .then((payload) => { if (active) { setDetail(payload[kind === 'signals' ? 'signal' : 'topic']); setDetailState({ loading: false, error: '' }) } })
      .catch((error) => { if (active) setDetailState({ loading: false, error: error.message }) })
    return () => { active = false }
  }, [selectedId, kind])

  const trigger = async () => {
    setAction('trigger')
    try {
      await triggerDream()
      await load({ background: true })
    } catch (error) {
      setCollection((current) => ({ ...current, error: error.message }))
    } finally {
      setAction('')
    }
  }

  return { config, query, setQuery, status, setStatus, collection, selectedId, setSelectedId, detail, detailState, action, load, trigger }
}

function LedgerShell({ kind, canManage, initialSelection, onOpenLinked, renderRow, renderDetail }) {
  const model = useDreamLedger(kind, initialSelection)
  const { config, collection, selectedId, detail, detailState } = model
  const state = dreamCollectionState(collection)
  const Icon = config.icon
  const stats = useMemo(() => {
    if (kind === 'signals') return [
      ['TOTAL', collection.total],
      ['ACTIVE', collection.items.filter((item) => item.status === 'active').length],
      ['OPEN FORECASTS', collection.items.reduce((sum, item) => sum + Number(item.openForecastCount || 0), 0)],
      ['LAST DREAM', runOutcomeLabel(collection.dream?.lastRun)],
    ]
    return [
      ['TOTAL', collection.total],
      ['ACTIVE', collection.items.filter((item) => item.status === 'active').length],
      ['LINKED SIGNALS', collection.items.reduce((sum, item) => sum + Number(item.signalCount || 0), 0)],
      ['LAST DREAM', runOutcomeLabel(collection.dream?.lastRun)],
    ]
  }, [kind, collection])

  return (
    <div className="page-enter dream-page">
      <div className="dream-metric-strip">
        {stats.map(([label, value]) => <Metric key={label} label={label} value={value} />)}
        <div className="dream-runtime"><span>CURSOR</span><code title={collection.dream?.cursor || ''}>{compactId(collection.dream?.cursor)}</code><small>{collection.dream?.nextRunAt ? `next ${formatDreamTime(collection.dream.nextRunAt)}` : 'scheduler idle'}</small></div>
      </div>

      <div className="dream-toolbar">
        <label className="inline-search"><Search size={14} /><input value={model.query} onChange={(event) => model.setQuery(event.target.value)} placeholder={`搜索${config.noun} / 仓库 / 机制`} /></label>
        <label className="dream-select"><span>STATUS</span><select value={model.status} onChange={(event) => model.setStatus(event.target.value)}><option value="">全部</option><option value="active">active</option><option value="inactive">inactive</option>{kind === 'signals' && <option value="refuted">refuted</option>}<option value="superseded">superseded</option></select></label>
        <span className="dream-toolbar-context"><Icon size={13} />{config.eyebrow} · {collection.total}</span>
        <button className="icon-button" aria-label={`刷新${config.label}`} title={`刷新${config.label}`} onClick={() => model.load({ background: true })} disabled={collection.refreshing}><RefreshCw className={collection.refreshing ? 'spin' : ''} size={15} /></button>
        {canManage ? <button className="primary-button compact" onClick={model.trigger} disabled={Boolean(model.action) || Boolean(collection.dream?.currentRun)}><Sparkles size={13} /> Dream now</button> : <span className="public-readonly-note"><LockKeyhole size={13} /> 公开账本</span>}
      </div>

      <DreamBanner state={state} dream={collection.dream} error={collection.error} canManage={canManage} onTrigger={model.trigger} action={model.action} />

      {collection.loading ? <div className="dream-loading"><LoaderCircle className="spin" size={20} />正在打开 Dream 账本…</div> : (
        <div className={`dream-master-detail ${!collection.items.length ? 'empty' : ''}`}>
          <section className="dream-ledger-list" aria-label={`${config.label}列表`}>
            <header><span>{config.eyebrow}</span><small>{collection.total} records</small></header>
            {collection.items.map((item, index) => (
              <button key={item.id} className={selectedId === item.id ? 'selected' : ''} onClick={() => model.setSelectedId(item.id)} aria-pressed={selectedId === item.id}>
                <span className="dream-row-index">{String(index + 1).padStart(2, '0')}</span>
                {renderRow(item)}
                <ChevronRight size={14} />
              </button>
            ))}
            {!collection.items.length && <div className="dream-list-empty"><Icon size={22} /><strong>没有匹配的{config.noun}</strong><span>放宽筛选，或等待下一个 Dream 日界。</span></div>}
          </section>
          <section className="dream-detail" aria-live="polite">
            {detailState.loading && !detail ? <div className="dream-loading"><LoaderCircle className="spin" size={20} />读取版本和证据链…</div> : detailState.error ? <div className="dream-inline-error"><AlertTriangle size={17} /><span><strong>详情读取失败</strong>{detailState.error}</span></div> : detail ? renderDetail(detail, onOpenLinked) : <div className="dream-detail-empty"><ArrowRight size={21} /><span>选择一条记录查看技术判断、预测与修正轨迹。</span></div>}
          </section>
        </div>
      )}
    </div>
  )
}

function SignalRow(item) {
  return <><span className="dream-row-copy"><span><StatusToken value={item.status} /><small>{item.direction}</small></span><strong>{item.title}</strong><p>{item.summary}</p><em>{(item.repositories || []).join(' · ') || 'repository unavailable'}</em></span><span className="dream-row-scores"><Score label="IMP" value={item.importance} /><Score label="CONF" value={item.confidence} /><small>{item.openForecastCount} open · {item.topicCount} topics</small></span></>
}

function LabeledText({ label, children }) {
  return <section className="dream-text-section"><h3>{label}</h3><MarkdownText>{children}</MarkdownText></section>
}

function StringList({ title, items, tone = '' }) {
  return <section className={`dream-list-section ${tone}`}><h3>{title}<span>{items?.length || 0}</span></h3>{items?.length ? <ul>{items.map((item, index) => <li key={`${index}-${item}`}><span>{String(index + 1).padStart(2, '0')}</span><p>{item}</p></li>)}</ul> : <p className="dream-none">—</p>}</section>
}

function EvidenceTable({ evidence = [] }) {
  return <section className="dream-evidence"><h3>EVIDENCE INDEX <span>{evidence.length}</span></h3><div>{evidence.map((item) => <article key={item.id}><span><StatusToken value={item.tier} /><code>{compactId(item.id)}</code></span><strong>{item.claim}</strong><p>{item.repository} · {item.type} · {item.directness}</p><small>{item.locator} · {formatDreamTime(item.observedAt)}</small></article>)}{!evidence.length && <p className="dream-none">无公开证据元数据。</p>}</div></section>
}

function SignalDetail(signal, onOpenTopic) {
  const current = signal.current || {}
  return <div className="dream-detail-body">
    <header className="dream-detail-head"><div><span>TECHNICAL SIGNAL / {compactId(signal.id)}</span><h2>{signal.title}</h2><p>{current.summary || signal.summary}</p></div><div><StatusToken value={signal.status} /><Score label="IMPORTANCE" value={signal.importance} /><Score label="CONFIDENCE" value={signal.confidence} /></div></header>
    <div className="dream-factline"><span><GitBranch size={13} />{(signal.repositories || []).join(' · ') || '未绑定仓库'}</span><span>{signal.direction}</span><span>{signal.evidenceCount} evidence</span><span>{signal.revisions?.length || 0} revisions</span><time>{formatDreamTime(signal.updatedAt)}</time></div>
    <div className="dream-narrative-grid"><LabeledText label="BASELINE">{current.baseline}</LabeledText><LabeledText label="OBSERVED DELTA">{current.delta}</LabeledText><LabeledText label="MECHANISM">{current.mechanism}</LabeledText><LabeledText label="ENGINEERING CONSEQUENCE">{current.consequence}</LabeledText></div>
    <div className="dream-boundary"><AlertTriangle size={15} /><span><strong>EVIDENCE BOUNDARY</strong>{current.evidence_boundary || '未记录'}</span></div>
    <div className="dream-three-columns"><StringList title="FACTS" items={(current.facts || []).map((fact) => typeof fact === 'string' ? fact : fact.statement || fact.claim)} /><StringList title="INFERENCES" items={current.inferences} /><StringList title="UNKNOWNS" items={current.unknowns} tone="warning" /></div>
    <Forecasts forecasts={signal.forecasts || []} />
    <div className="dream-two-columns"><StringList title="NEXT CHECKS" items={current.next_checks} /><LinkedEntities title="LINKED TOPICS" items={signal.topics || []} onOpen={onOpenTopic} /></div>
    <EvidenceTable evidence={signal.evidence} />
    <RevisionRail revisions={signal.revisions || []} kind="signal" />
  </div>
}

function Forecasts({ forecasts }) {
  return <section className="dream-forecasts"><h3>FORECAST REGISTER <span>{forecasts.length}</span></h3><div>{forecasts.map((forecast) => { const tone = forecastTone(forecast); return <article key={forecast.id} className={tone}><header><StatusToken value={tone} /><code>{compactId(forecast.id)}</code><time>due {formatDreamTime(forecast.dueAt)}</time></header><strong>{forecast.claim}</strong><p>{(forecast.expectedObservations || []).join(' · ')}</p>{forecast.evaluation && <div><CheckCircle2 size={14} /><span><b>{forecast.evaluation.outcome}</b>{forecast.evaluation.observed}</span></div>}</article> })}{!forecasts.length && <p className="dream-none">尚无可校验预测。</p>}</div></section>
}

function LinkedEntities({ title, items = [], onOpen }) {
  return <section className="dream-linked"><h3>{title}<span>{items.length}</span></h3>{items.map((item) => onOpen ? <button type="button" key={item.id} onClick={() => onOpen(item.id)} aria-label={`打开 ${item.title}`}><StatusToken value={item.status} /><strong>{item.title}</strong><p>{item.summary || item.thesis}</p><ChevronRight size={13} /></button> : <article key={item.id}><StatusToken value={item.status} /><strong>{item.title}</strong><p>{item.summary || item.thesis}</p></article>)}{!items.length && <p className="dream-none">—</p>}</section>
}

function RevisionRail({ revisions = [], kind }) {
  return <section className="dream-revisions"><h3><History size={14} /> REVISION LEDGER <span>{revisions.length}</span></h3><div>{revisions.map((revision) => <article key={revision.id}><span>{String(revision.sequence).padStart(2, '0')}</span><i /><div><header><StatusToken value={revision.status} /><time>{formatDreamTime(revision.createdAt)}</time><code>{compactId(revision.runId)}</code></header><strong>{revision.title}</strong><p>{kind === 'signal' ? revision.delta : revision.thesis}</p></div></article>)}</div></section>
}

function TopicRow(item) {
  return <><span className="dream-row-copy"><span><StatusToken value={item.status} /><small>{item.signalCount} signals</small></span><strong>{item.title}</strong><p>{item.thesis || item.summary}</p><em>{(item.scope || []).join(' · ') || 'scope unavailable'}</em></span><span className="dream-row-scores topic"><strong>{item.evidenceCount}</strong><small>evidence</small></span></>
}

function TopicDetail(topic, onOpenSignal) {
  const current = topic.current || {}
  return <div className="dream-detail-body">
    <header className="dream-detail-head"><div><span>TECHNICAL TOPIC / {compactId(topic.id)}</span><h2>{topic.title}</h2><p>{current.summary || topic.summary}</p></div><div><StatusToken value={topic.status} /><span className="dream-topic-count"><strong>{topic.signalCount}</strong><small>signals</small></span></div></header>
    <div className="dream-factline"><span><Tags size={13} />{(topic.scope || []).join(' · ') || '未定义范围'}</span><span>{topic.evidenceCount} evidence</span><span>{topic.revisions?.length || 0} revisions</span><time>{formatDreamTime(topic.updatedAt)}</time></div>
    <LabeledText label="TECHNICAL THESIS">{current.thesis}</LabeledText>
    <div className="dream-narrative-grid"><LabeledText label="MECHANISM">{current.mechanism}</LabeledText><LabeledText label="APPLICABILITY">{current.applicability}</LabeledText></div>
    <StringList title="BOUNDARIES" items={current.boundaries} tone="warning" />
    <TopicFindings findings={current.findings || []} />
    <div className="dream-three-columns"><StringList title="ENGINEERING IMPLICATIONS" items={current.engineering_implications} /><StringList title="UNKNOWNS" items={current.unknowns} tone="warning" /><StringList title="NEXT CHECKS" items={current.next_checks} /></div>
    <LinkedEntities title="LINKED SIGNALS" items={topic.signals || []} onOpen={onOpenSignal} />
    <EvidenceTable evidence={topic.evidence} />
    <RevisionRail revisions={topic.revisions || []} kind="topic" />
  </div>
}

function TopicFindings({ findings }) {
  return <section className="dream-findings"><h3>TECHNICAL FINDINGS <span>{findings.length}</span></h3><div>{findings.map((finding, index) => <article key={finding.id || index}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{finding.title || finding.finding || finding.claim}</strong><p>{finding.detail || finding.summary || finding.mechanism || `basis: ${finding.basis || 'unknown'}`}</p>{finding.evidence_ids?.length ? <small>{finding.evidence_ids.length} evidence refs · {finding.basis}</small> : null}</div></article>)}{!findings.length && <p className="dream-none">未形成可发布的细分发现。</p>}</div></section>
}

export function SignalsView({ canManage = false, initialSelection = '', onOpenTopic }) {
  return <LedgerShell kind="signals" canManage={canManage} initialSelection={initialSelection} onOpenLinked={onOpenTopic} renderRow={SignalRow} renderDetail={SignalDetail} />
}

export function TopicsView({ canManage = false, initialSelection = '', onOpenSignal }) {
  return <LedgerShell kind="topics" canManage={canManage} initialSelection={initialSelection} onOpenLinked={onOpenSignal} renderRow={TopicRow} renderDetail={TopicDetail} />
}

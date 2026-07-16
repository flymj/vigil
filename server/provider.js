import { loadProviderApiKey } from './provider-secret.js'

const systemPrompt = `You are Vigil's repository deep-dive analyst. Analyze repository changes using only the supplied evidence and code context. Clearly separate facts, inferences, and unknowns. Focus on behavior changes, architecture impact, compatibility risk, performance implications, and concrete follow-up checks. Do not invent benchmark results or unseen code. Return concise Markdown in Simplified Chinese. When a visual makes an evidence relationship materially clearer, you may use a fenced mermaid block, a fenced echarts block containing a JSON option object only, or standard LaTex math / a fenced katex block. Do not emit executable JavaScript or HTML.`

async function authorizationHeaders(settings) {
  const apiKey = await loadProviderApiKey()
  if (settings.provider.requiresApiKey && !apiKey) throw new Error('Provider API Key 尚未在本地加密存储中配置')
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

export async function ensureProviderCredential(settings) {
  await authorizationHeaders(settings)
}

async function providerFetch(settings, endpoint, init = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), settings.provider.timeoutSeconds * 1000)
  try {
    return await fetch(`${settings.provider.baseUrl}${endpoint}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(await authorizationHeaders(settings)),
        ...init.headers,
      },
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function responsePayload(response) {
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || response.statusText
    throw new Error(`Provider ${response.status}: ${message}`)
  }
  return payload
}

export async function testProviderConnection(settings) {
  const startedAt = performance.now()
  const response = await providerFetch(settings, '/models', { method: 'GET' })
  const payload = await responsePayload(response)
  const models = Array.isArray(payload.data) ? payload.data.map((model) => model.id).filter(Boolean) : []
  return {
    ok: true,
    latencyMs: Math.round(performance.now() - startedAt),
    models: models.slice(0, 50),
    configuredModelAvailable: models.length ? models.includes(settings.provider.model) : null,
  }
}

export async function executeDeepDive(settings, input, repositoryContext = {}) {
  const change = input.change || {}
  const codeContext = input.codeContext || repositoryContext
  const prompt = [
    '# Change',
    JSON.stringify(change, null, 2),
    '# Changed files',
    JSON.stringify(codeContext.changedFiles || [], null, 2),
    '# Diff excerpts',
    String(codeContext.diff || 'No diff context was supplied. State this limitation explicitly.'),
  ].join('\n\n')
  const startedAt = performance.now()
  const response = await providerFetch(settings, '/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: settings.provider.model,
      max_tokens: settings.provider.maxOutputTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    }),
  })
  const payload = await responsePayload(response)
  const content = payload?.choices?.[0]?.message?.content
  if (!content) throw new Error('Provider 返回成功，但没有 choices[0].message.content')
  return {
    content,
    model: payload.model || settings.provider.model,
    usage: payload.usage || null,
    latencyMs: Math.round(performance.now() - startedAt),
    repositoryContext: codeContext.meta || null,
  }
}

export async function executeRepositorySummary(settings, snapshot) {
  const prompt = [
    `请总结仓库 ${snapshot.repository} 在 ${snapshot.range.from} 到 ${snapshot.range.to} 的变化。`,
    '输出：Executive Summary、重要技术变化、Hot PR、兼容/性能风险、仍需跟踪的问题。',
    '严格基于输入数据；没有 diff 证据时不要推断具体代码行为。可在确实有助于理解时输出 Mermaid、ECharts JSON option 或 LaTex/KaTeX，绝不输出 HTML 或可执行 JavaScript。',
    JSON.stringify(snapshot, null, 2),
  ].join('\n\n')
  const startedAt = performance.now()
  const response = await providerFetch(settings, '/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: settings.provider.model,
      max_tokens: settings.provider.maxOutputTokens,
      messages: [
        { role: 'system', content: 'You are Vigil repository intelligence analyst. Return concise Markdown in Simplified Chinese and separate facts from unknowns.' },
        { role: 'user', content: prompt },
      ],
    }),
  })
  const payload = await responsePayload(response)
  const content = payload?.choices?.[0]?.message?.content
  if (!content) throw new Error('Provider 返回成功，但没有 repository summary 内容')
  return {
    mode: 'provider',
    content,
    model: payload.model || settings.provider.model,
    usage: payload.usage || null,
    latencyMs: Math.round(performance.now() - startedAt),
  }
}

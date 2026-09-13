const $ = id => document.getElementById(id)
const STORE = 'frontier.workspace.v1'
const defaults = { provider: 'claude', system: '', maxTokens: 4096, effort: '', model: '' }
let conversations = [], activeId, connection = { connected: false, models: [] }, busy = false, requestController, pendingDelete
let providerStates = {}, loginProvider, authPoll
const providerName = p => p === 'openai' ? 'OpenAI' : 'Claude'
let renderQueued = false, toastTimer, storageWarned = false
const uid = () => crypto.randomUUID()
function newConversation() { return { id: uid(), title: 'New conversation', updatedAt: Date.now(), messages: [], settings: { ...defaults } } }
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || '{}')
  if (Array.isArray(saved.conversations)) conversations = saved.conversations.filter(c => typeof c.id === 'string' && typeof c.title === 'string' && Array.isArray(c.messages)).slice(0, 100).map(c => ({ ...c, settings: { ...defaults, ...c.settings }, messages: c.messages.filter(m => ['user', 'assistant'].includes(m.role) && typeof m.text === 'string').map(m => ({ ...m, status: m.status === 'streaming' ? 'stopped' : m.status })) }))
  activeId = saved.activeId
} catch { /* An unavailable or invalid browser store does not prevent chatting. */ }
for (const c of conversations) if (!['claude', 'openai'].includes(c.settings.provider)) c.settings.provider = 'claude'
if (!conversations.some(c => c.id === activeId)) { const c = newConversation(); conversations.unshift(c); activeId = c.id }
const current = () => conversations.find(c => c.id === activeId)
function persist() {
  try { localStorage.setItem(STORE, JSON.stringify({ conversations: conversations.filter(c => c.messages.length || c.id === activeId).slice(0, 100), activeId })) }
  catch { if (!storageWarned) { storageWarned = true; toast('Browser storage is full or unavailable. This chat will last until you close the page.') } }
}
function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', `#i-${name}`); svg.append(use); svg.setAttribute('aria-hidden', 'true')
  return svg
}
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true }, 3500) }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied to clipboard') } catch { toast('Clipboard unavailable. Select the text to copy it.') } }
function inline(parent, text) {
  // Build nodes rather than inserting HTML: model output is always untrusted.
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(last, match.index)))
    const token = match[0]
    if (token[0] === '`') parent.append(element('code', '', token.slice(1, -1)))
    else if (token.startsWith('**')) parent.append(element('strong', '', token.slice(2, -2)))
    else if (token[0] === '*') parent.append(element('em', '', token.slice(1, -1)))
    else {
      const split = token.indexOf(']('), a = element('a', '', token.slice(1, split))
      a.href = token.slice(split + 2, -1); a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a)
    }
    last = match.index + token.length
  }
  parent.append(document.createTextNode(text.slice(last)))
}
function markdown(text) {
  const fragment = document.createDocumentFragment(), lines = text.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim() || 'Code', code = []; i++
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++])
      if (i < lines.length) i++
      const header = element('div', 'code-header'), button = element('button', '', 'Copy')
      button.type = 'button'; button.addEventListener('click', () => copy(code.join('\n')))
      header.append(element('span', '', language), button)
      const pre = element('pre'); pre.append(element('code', '', code.join('\n'))); fragment.append(header, pre); continue
    }
    if (/^#{1,4} /.test(line)) { const level = Math.min(4, line.match(/^#+/)[0].length + 1), h = element(`h${level}`); inline(h, line.replace(/^#+ /, '')); fragment.append(h); i++; continue }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim())
      const wrap = element('div', 'table-wrap'), table = element('table'), head = element('thead'), tr = element('tr')
      for (const cell of cells(line)) { const th = element('th'); inline(th, cell); tr.append(th) }
      head.append(tr); table.append(head); const body = element('tbody'); i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { const row = element('tr'); for (const cell of cells(lines[i++])) { const td = element('td'); inline(td, cell); row.append(td) } body.append(row) }
      table.append(body); wrap.append(table); fragment.append(wrap); continue
    }
    if (/^\s*([-*] |\d+\. )/.test(line)) {
      const list = element(/^\s*\d+\./.test(line) ? 'ol' : 'ul')
      while (i < lines.length && /^\s*([-*] |\d+\. )/.test(lines[i])) { const li = element('li'); inline(li, lines[i++].replace(/^\s*([-*] |\d+\. )/, '')); list.append(li) }
      fragment.append(list); continue
    }
    if (line.startsWith('> ')) { const quote = element('blockquote'); inline(quote, line.slice(2)); fragment.append(quote); i++; continue }
    const paragraph = [line]; i++
    while (i < lines.length && lines[i].trim() && !/^(#{1,4} |```|> |\s*([-*] |\d+\. ))/.test(lines[i]) && !(lines[i].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || ''))) paragraph.push(lines[i++])
    const p = element('p'); inline(p, paragraph.join('\n')); fragment.append(p)
  }
  return fragment
}
const mobile = matchMedia('(max-width: 760px)')
function sidebar(open) { $('sidebar').classList.toggle('open', open); $('sidebar-backdrop').hidden = !open; $('sidebar').inert = mobile.matches && !open; $('menu-button').setAttribute('aria-expanded', String(open)); if (!open && mobile.matches) $('menu-button').focus() }
mobile.addEventListener('change', () => { $('sidebar').inert = mobile.matches && !$('sidebar').classList.contains('open'); if (!mobile.matches) $('sidebar-backdrop').hidden = true })
function renderHistory() {
  const items = conversations.filter(c => c.messages.length).sort((a, b) => b.updatedAt - a.updatedAt)
  $('history').replaceChildren()
  if (!items.length) $('history').append(element('p', 'history-empty', 'A little room for your next big idea.'))
  for (const c of items) {
    const row = element('div', `history-item ${c.id === activeId ? 'active' : ''}`), button = element('button', 'history-open')
    button.title = c.title; button.disabled = busy; button.append(icon('chat'), element('span', '', c.title)); button.setAttribute('aria-current', c.id === activeId ? 'page' : 'false')
    button.onclick = () => { activeId = c.id; persist(); renderConversation(); sidebar(false); $('prompt').focus() }
    const remove = element('button', 'history-delete'); remove.append(icon('trash')); remove.title = 'Delete conversation'; remove.setAttribute('aria-label', `Delete ${c.title}`); remove.disabled = busy
    remove.onclick = () => { pendingDelete = c.id; $('delete-dialog').showModal() }
    row.append(button, remove); $('history').append(row)
  }
  $('new-chat').disabled = busy
}
function updateModels() {
  const desired = current().settings.model
  $('provider').value = current().settings.provider
  $('model').replaceChildren(...connection.models.map(m => new Option(m.name, m.id)))
  if (desired && !connection.models.some(m => m.id === desired)) $('model').append(new Option(desired, desired))
  if (!$('model').options.length) $('model').append(new Option(`Connect ${providerName(current().settings.provider)} to begin`, ''))
  if (desired) $('model').value = desired
  current().settings.model = $('model').value
  $('model').disabled = busy || !connection.connected
}
function updateEfforts() {
  const model = connection.models.find(m => m.id === $('model').value)
  $('effort').replaceChildren(new Option('Model default', ''), ...(model?.efforts || []).map(e => new Option(e.name, e.id)))
  if ([...$('effort').options].some(o => o.value === current().settings.effort)) $('effort').value = current().settings.effort
}
function messageNode(m, index) {
  const article = element('article', `message ${m.role}`); article.dataset.messageId = m.id
  if (m.role === 'user') { article.append(element('div', 'message-body', m.text)); return article }
  const heading = element('div', 'message-heading'), mark = element('img'); mark.src = '/favicon.svg'; mark.alt = ''
  heading.append(mark, element('strong', '', providerName(m.provider || 'claude')))
  if (m.model) heading.append(element('span', '', (providerStates[m.provider || 'claude']?.models || connection.models).find(model => model.id === m.model)?.name?.replace('Claude ', '') || m.model.replace('claude-', '')))
  article.append(heading)
  if (m.reasoning) { const details = element('details', 'reasoning'); details.append(element('summary', '', m.status === 'streaming' ? 'Thinking…' : 'Reasoning summary'), element('p', '', m.reasoning)); article.append(details) }
  const body = element('div', 'message-body')
  if (m.text) body.append(markdown(m.text))
  else if (m.status === 'streaming') { const typing = element('div', 'typing'); typing.setAttribute('aria-label', 'Claude is responding'); typing.append(element('span'), element('span'), element('span')); body.append(typing) }
  article.append(body)
  if (m.error) article.append(element('div', 'message-error', m.error))
  if (m.status !== 'streaming') {
    const actions = element('div', 'message-actions')
    if (m.text) { const button = element('button', 'icon-button'); button.append(icon('copy')); button.title = 'Copy response'; button.setAttribute('aria-label', 'Copy response'); button.onclick = () => copy(m.text); actions.append(button) }
    if (m.status === 'stopped') actions.append(element('span', '', 'Response stopped'))
    if (m.usage) actions.append(element('span', '', `${(m.usage.outputTokens || 0).toLocaleString()} output tokens`))
    article.append(actions)
    if (index === current().messages.length - 1) { const retry = element('button', 'retry-button', m.status === 'error' ? 'Try again' : 'Regenerate response'); retry.disabled = busy; retry.onclick = regenerate; article.append(retry) }
  }
  return article
}
function renderMessages(forceBottom = false) {
  const area = $('scroll-area'), nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 150
  const expanded = new Set([...$('messages').querySelectorAll('details[open]')].map(n => n.closest('article').dataset.messageId))
  const chat = current(); $('welcome').hidden = chat.messages.length > 0; $('messages').hidden = !chat.messages.length
  $('messages').replaceChildren(...chat.messages.map(messageNode))
  for (const article of $('messages').children) if (expanded.has(article.dataset.messageId)) article.querySelector('details')?.setAttribute('open', '')
  if (forceBottom || nearBottom) area.scrollTop = area.scrollHeight
}
function renderConversation() { selectConnection(); $('chat-title').textContent = current().title; document.title = `${current().title} — Frontier`; renderHistory(); updateModels(); renderMessages(true); updateControls() }
function updateControls() {
  $('send-button').disabled = busy || !connection.connected || !$('prompt').value.trim() || !$('model').value
  $('send-button').hidden = busy; $('stop-button').hidden = !busy; $('model').disabled = busy || !connection.connected
  $('new-chat').disabled = busy; $('provider').disabled = busy
  $('response-status').textContent = busy ? `${providerName(current().settings.provider)} is responding…` : 'Conversations stay in this browser.'
}
function selectConnection() {
  const provider = current().settings.provider || 'claude'
  connection = { connected: false, models: [], ...providerStates[provider], csrf: connection.csrf }
  const name = providerName(provider)
  $('connection-status').className = `connection-status ${connection.connected ? 'connected' : 'disconnected'}`
  $('connection-status').lastElementChild.textContent = connection.connected ? `${name} connected` : `${name} not connected`
  $('sidebar-status').textContent = `${Object.values(providerStates).filter(p => p.connected).length} of 2 connected`
  $('settings-connection').textContent = connection.connected ? `${name} connected` : `Connect ${name} to chat`
  $('connection-detail').textContent = connection.error || connection.modelError || (connection.connected
    ? connection.source === 'keychain' ? 'Claude Code manages this session’s refreshes.' : 'Your credentials stay on this computer.'
    : 'Choose Connect above to sign in with your account.')
  $('notice').hidden = connection.connected
  if (!connection.connected) $('notice').textContent = `Connect ${name} in settings to start chatting, or choose another connected provider.`
  $('usage-button').disabled = !connection.connected || connection.mode === 'api-key'
  $('max-tokens').disabled = provider === 'openai'
  $('max-tokens').title = provider === 'openai' ? 'OpenAI subscription responses use the provider’s default length.' : ''
  $('prompt').placeholder = `Message ${name}…`
}
async function connect() {
  $('refresh-connection').disabled = true
  try {
    const response = await fetch('/api/status'), value = await response.json()
    if (!response.ok) throw new Error(value.error || 'Connection unavailable')
    connection.csrf = value.csrf; providerStates = value.providers || { claude: value }
    for (const provider of ['claude', 'openai']) {
      const state = providerStates[provider] || {}, waiting = ['starting', 'waiting'].includes(state.login?.state)
      $(`${provider}-auth-status`).textContent = state.error || state.login?.error || (waiting ? 'Waiting for sign-in…' : state.connected ? (provider === 'openai' ? 'ChatGPT subscription connected' : 'Connected') : 'Not connected')
      $(`connect-${provider}`).hidden = !!state.connected; $(`logout-${provider}`).hidden = !state.connected
      $(`connect-${provider}`).disabled = waiting || !!loginProvider
      $(`logout-${provider}`).disabled = false
      if (provider === loginProvider && !waiting) {
        if (state.login?.state === 'connected') toast(`${providerName(provider)} connected`)
        if (state.login?.state === 'error') toast(state.login.error || 'Sign-in failed')
        clearInterval(authPoll); authPoll = undefined; loginProvider = undefined; $('login-panel').hidden = true
      }
    }
    for (const provider of ['claude', 'openai']) $(`connect-${provider}`).disabled = !!loginProvider || ['starting', 'waiting'].includes(providerStates[provider]?.login?.state)
    selectConnection(); updateModels(); updateEfforts(); updateControls(); renderMessages()
  } catch (error) {
    connection.connected = false; $('connection-status').className = 'connection-status disconnected'; $('connection-status').lastElementChild.textContent = 'Unavailable'
    $('notice').hidden = false; $('notice').textContent = error.message; updateControls()
  } finally { $('refresh-connection').disabled = false }
}
async function authAction(action, provider, extra = {}) {
  const response = await fetch(`/api/auth/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-frontier-token': connection.csrf }, body: JSON.stringify({ provider, ...extra }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Connection action failed')
  return result
}
async function startLogin(provider) {
  $(`connect-${provider}`).disabled = true
  try {
    const result = await authAction('login', provider)
    if (result.url) {
      loginProvider = provider; $('login-title').textContent = `Connect ${providerName(provider)}`
      $('login-link').href = result.url; $('login-callback').value = ''; $('login-panel').hidden = false
      clearInterval(authPoll); authPoll = setInterval(() => { if (!$('refresh-connection').disabled) void connect() }, 1500)
    }
    await connect()
  } catch (error) { toast(error.message); $(`connect-${provider}`).disabled = false }
}
async function logout(provider) {
  $(`logout-${provider}`).disabled = true
  try {
    if (busy && current().settings.provider === provider) requestController?.abort()
    await authAction('logout', provider)
    if (loginProvider === provider) { clearInterval(authPoll); loginProvider = undefined; $('login-panel').hidden = true }
    await connect(); toast(`${providerName(provider)} logged out of Frontier`)
  } catch (error) { toast(error.message); $(`logout-${provider}`).disabled = false }
}
function queueRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; renderMessages() }) } }
async function sendMessage(event) {
  event?.preventDefault()
  const text = $('prompt').value.trim()
  if (!text || busy) return
  if (!connection.connected) { toast(`Connect ${providerName(current().settings.provider)} in settings to begin.`); return }
  const chat = current(); chat.settings.model = $('model').value
  chat.messages.push({ id: uid(), role: 'user', text, status: 'complete' })
  if (chat.messages.length === 1) chat.title = text.replace(/\s+/g, ' ').slice(0, 52)
  chat.updatedAt = Date.now(); $('prompt').value = ''; $('prompt').rows = 2
  await generate(chat)
}
async function regenerate() {
  if (busy) return
  const chat = current(), index = chat.messages.findLastIndex(m => m.role === 'user')
  if (index < 0) return
  chat.messages = chat.messages.slice(0, index + 1); await generate(chat)
}
async function generate(chat) {
  const outgoing = chat.messages.filter(m => m.text.trim()).map(m => ({ role: m.role, text: m.text }))
  const answer = { id: uid(), role: 'assistant', text: '', reasoning: '', status: 'streaming', model: chat.settings.model, provider: chat.settings.provider }
  chat.messages.push(answer); busy = true; requestController = new AbortController(); persist(); renderConversation()
  let finished = false
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-frontier-token': connection.csrf }, signal: requestController.signal,
      body: JSON.stringify({ provider: chat.settings.provider, model: chat.settings.model, messages: outgoing, system: chat.settings.system, maxTokens: chat.settings.maxTokens, effort: chat.settings.effort || undefined }),
    })
    if (!response.ok) { const problem = await response.json(); throw new Error(problem.error || `Request failed (${response.status})`) }
    if (!response.body) throw new Error('No response stream was returned.')
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = ''
    const consume = line => {
      if (!line.trim()) return
      const chunk = JSON.parse(line)
      if (chunk.type === 'text-delta') answer.text += chunk.text
      if (chunk.type === 'reasoning-delta') answer.reasoning += chunk.text
      if (chunk.type === 'usage') answer.usage = chunk.usage
      if (chunk.type === 'error') throw new Error(chunk.message)
      if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error') throw new Error(chunk.reason.failure.message)
        if (chunk.reason.kind === 'aborted') throw new DOMException('Stopped', 'AbortError')
        finished = true
        if (chunk.reason.kind === 'max-tokens') answer.error = 'Response length reached. Ask the assistant to continue, or increase the response length in settings.'
      }
      queueRender()
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) { pending += decoder.decode(); if (pending.trim()) consume(pending); break }
        pending += decoder.decode(value, { stream: true })
        let at
        while ((at = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, at)); pending = pending.slice(at + 1) }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    if (!finished) throw new Error('The connection ended before the response finished. You can try again.')
    answer.status = 'complete'
  } catch (error) {
    if (error.name === 'AbortError' || requestController.signal.aborted) answer.status = 'stopped'
    else { answer.status = 'error'; answer.error = error.message || 'Something went wrong. Try again.' }
  } finally {
    busy = false; requestController = undefined; chat.updatedAt = Date.now(); persist(); renderConversation()
  }
}
function openSettings() {
  const settings = current().settings
  $('instructions').value = settings.system; $('max-tokens').value = String(settings.maxTokens)
  $('custom-model').value = connection.models.some(m => m.id === settings.model) ? '' : settings.model
  updateEfforts(); $('settings-dialog').showModal()
}
function saveSettings() {
  const custom = $('custom-model').value.trim()
  if (custom && !/^[a-zA-Z0-9._:-]{1,128}$/.test(custom)) { toast('Use a valid model ID without spaces.'); $('custom-model').focus(); return }
  const settings = current().settings
  settings.system = $('instructions').value; settings.maxTokens = Number($('max-tokens').value)
  settings.effort = custom && custom !== settings.model ? '' : $('effort').value
  if (custom) settings.model = custom
  persist(); updateModels(); $('settings-dialog').close(); toast('Settings saved')
}
async function loadUsage() {
  $('usage-button').disabled = true; $('usage-content').textContent = 'Checking usage…'
  try {
    const response = await fetch(`/api/usage?provider=${current().settings.provider}`, { method: 'POST', headers: { 'x-frontier-token': connection.csrf } }), data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Usage unavailable')
    const windows = []
    if (Array.isArray(data.limits)) for (const l of data.limits) if (typeof l.percent === 'number') windows.push({ name: l.name || l.type || l.kind || 'Usage window', percent: l.percent, reset: l.resets_at })
    if (data.rate_limit) for (const key of ['primary_window', 'secondary_window']) { const w = data.rate_limit[key]; if (typeof w?.used_percent === 'number') windows.push({ name: key === 'primary_window' ? 'Current session' : 'Weekly limit', percent: w.used_percent, reset: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null }) }
    if (!windows.length) for (const [key, name] of Object.entries({ five_hour: 'Current session', seven_day: 'Weekly · all models', seven_day_opus: 'Weekly · Opus', seven_day_sonnet: 'Weekly · Sonnet' })) {
      const bucket = data[key]; if (bucket && typeof bucket.utilization === 'number') windows.push({ name, percent: bucket.utilization, reset: bucket.resets_at })
    }
    $('usage-content').replaceChildren()
    if (!windows.length) $('usage-content').textContent = 'No usage windows were reported for this account.'
    for (const w of windows) {
      const row = element('div', 'usage-row'), label = element('div', 'usage-label')
      label.append(element('span', '', w.name.replaceAll('_', ' ')), element('span', '', `${Math.round(w.percent)}% used`))
      const bar = element('progress'); bar.max = 100; bar.value = Math.max(0, Math.min(100, w.percent)); bar.setAttribute('aria-label', w.name)
      row.append(label, bar)
      if (w.reset && Number.isFinite(Date.parse(w.reset))) row.append(element('div', 'usage-reset', `Resets ${new Date(w.reset).toLocaleString()}`))
      $('usage-content').append(row)
    }
  } catch (error) { $('usage-content').textContent = error.message }
  finally { $('usage-button').disabled = false }
}
$('chat-form').addEventListener('submit', sendMessage)
$('prompt').addEventListener('input', () => { $('prompt').rows = Math.min(7, Math.max(2, $('prompt').value.split('\n').length)); updateControls() })
$('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!busy) void sendMessage() } })
$('stop-button').onclick = () => requestController?.abort()
$('provider').onchange = () => {
  current().settings.provider = $('provider').value; current().settings.model = ''; current().settings.effort = ''
  selectConnection(); updateModels(); updateEfforts(); updateControls(); persist(); $('usage-content').textContent = 'Refresh to check your current limits.'
}
for (const button of document.querySelectorAll('.connect-provider')) button.onclick = () => startLogin(button.dataset.provider)
for (const button of document.querySelectorAll('.logout-provider')) button.onclick = () => logout(button.dataset.provider)
$('cancel-login').onclick = async () => { try { await authAction('cancel', loginProvider); clearInterval(authPoll); loginProvider = undefined; $('login-panel').hidden = true; await connect() } catch (error) { toast(error.message) } }
$('submit-callback').onclick = async () => { try { await authAction('callback', loginProvider, { callback: $('login-callback').value.trim() }); $('login-callback').value = ''; toast('Callback received. Completing sign-in…') } catch (error) { toast(error.message) } }
$('model').onchange = () => { current().settings.model = $('model').value; current().settings.effort = ''; updateEfforts(); persist() }
$('new-chat').onclick = () => { if (busy) return; if (!current().messages.length) { $('prompt').focus(); return } const c = newConversation(); c.settings.provider = current().settings.provider; c.settings.model = $('model').value; conversations.unshift(c); activeId = c.id; $('prompt').value = ''; persist(); renderConversation(); sidebar(false); $('prompt').focus() }
for (const button of document.querySelectorAll('[data-prompt]')) button.onclick = () => { $('prompt').value = button.dataset.prompt; $('prompt').focus(); updateControls() }
$('settings-button').onclick = openSettings; $('connection-button').onclick = openSettings; $('close-settings').onclick = () => $('settings-dialog').close()
$('save-settings').onclick = saveSettings; $('refresh-connection').onclick = connect; $('usage-button').onclick = loadUsage
$('menu-button').onclick = () => sidebar(!$('sidebar').classList.contains('open')); $('sidebar-backdrop').onclick = () => sidebar(false)
$('cancel-delete').onclick = () => $('delete-dialog').close()
$('confirm-delete').onclick = () => {
  conversations = conversations.filter(c => c.id !== pendingDelete)
  if (!conversations.some(c => c.id === activeId)) { const c = newConversation(); conversations.unshift(c); activeId = c.id }
  persist(); renderConversation(); $('delete-dialog').close(); toast('Conversation deleted')
}
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!busy) $('new-chat').click() } if (event.key === 'Escape') sidebar(false) })
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = '' } })
$('sidebar').inert = mobile.matches
renderConversation(); void connect()

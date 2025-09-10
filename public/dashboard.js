const $ = (s)=>document.querySelector(s)
const fmt = ts => new Date(ts).toLocaleString()

let volumeChart, statusChart
let __items = []

// estado UI
const chartsWrap = $('#charts-wrap')
const chartsBackdrop = $('#charts-backdrop')
const toggleChartsBtn = $('#toggle-charts')

// paginación + orden
let state = {
  sortBy: 'ts',
  sortDir: 'desc', // default: más nuevo -> más viejo
  page: 1,
  pageSize: Number($('#page-size').value || 50),
}

const LS_KEY = 'chartsVisible'
function setChartsVisible(v) {
  chartsWrap.classList.toggle('hidden', !v)
  toggleChartsBtn.textContent = v ? 'Ocultar gráficas' : 'Mostrar gráficas'
  localStorage.setItem(LS_KEY, v ? '1' : '0')
  if (v) resizeChartsSoon()
}
setChartsVisible(localStorage.getItem(LS_KEY) === '1')

toggleChartsBtn.onclick = () => {
  const nowVisible = chartsWrap.classList.contains('hidden')
  setChartsVisible(nowVisible)
}

async function fetchStats(limit) {
  const r = await fetch('/api/stats'); const j = await r.json().catch(()=>({}))
  if (!j.ok) return
  $('#k-sent').textContent = j.stats.sent
  $('#k-in').textContent = j.stats.received
  $('#k-failed').textContent = j.stats.failed
  $('#k-uniq').textContent = j.stats.uniqueNumbers
}

async function fetchEvents(limit) {
  const r = await fetch(`/api/events?limit=${encodeURIComponent(limit||500)}`)
  const j = await r.json().catch(()=>({}))
  if (!j.ok) return []
  return j.items || []
}

function applyFiltersAndSort(items) {
  const q = ($('#f-text').value||'').toLowerCase().trim()
  const t = $('#f-type').value
  // filtrar
  let res = items.filter(x =>
    (!t || x.type===t) &&
    (!q || (x.text||'').toLowerCase().includes(q) || (x.number||x.to||'').includes(q))
  )
  // ordenar
  res.sort((a,b)=>{
    const dir = state.sortDir === 'asc' ? 1 : -1
    const av = a[state.sortBy] ?? 0
    const bv = b[state.sortBy] ?? 0
    if (av < bv) return -1*dir
    if (av > bv) return  1*dir
    return 0
  })
  return res
}

function renderTablePage(items) {
  // paginar
  const total = items.length
  const pageSize = state.pageSize
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (state.page > pages) state.page = pages
  if (state.page < 1) state.page = 1

  const start = (state.page - 1) * pageSize
  const end = start + pageSize
  const slice = items.slice(start, end)

  const rows = slice.map(x=>{
    const numero = x.number || x.to || ''
    const estado = x.type==='out'
      ? (x.ok ? `<span class="pill out">OK</span>` : `<span class="pill fail">ERROR</span>`)
      : `<span class="pill in">IN</span>`
    return `<tr>
      <td>${fmt(x.ts)}</td>
      <td>${x.type}</td>
      <td>${numero}</td>
      <td>${(x.text||'').replace(/</g,'&lt;')}</td>
      <td>${x.template||''}</td>
      <td>${estado}</td>
    </tr>`
  }).join('')

  $('#tbody').innerHTML = rows || `<tr><td colspan="6" class="muted">Sin datos</td></tr>`

  // info paginación
  $('#page-pos').textContent = `Página ${state.page} / ${pages}`
  $('#page-prev').disabled = state.page <= 1
  $('#page-next').disabled = state.page >= pages

  // info total filtrado
  $('#pager-info').textContent = `${total} resultado(s) filtrado(s)`
}

function bucketByHour(items) {
  const toHourKey = ts => {
    const d = new Date(ts)
    const hh = String(d.getHours()).padStart(2,'0')
    const yyyy = d.getFullYear()
    const MM = String(d.getMonth()+1).padStart(2,'0')
    const dd = String(d.getDate()).padStart(2,'0')
    return `${yyyy}-${MM}-${dd} ${hh}:00`
  }
  const labelsSet = new Set()
  const inMap = new Map(), outMap = new Map()
  items.forEach(x=>{
    const k = toHourKey(x.ts)
    labelsSet.add(k)
    if (x.type === 'in') inMap.set(k, (inMap.get(k)||0)+1)
    else if (x.type === 'out') outMap.set(k, (outMap.get(k)||0)+1)
  })
  const labels = Array.from(labelsSet).sort()
  const inData  = labels.map(k => inMap.get(k)||0)
  const outData = labels.map(k => outMap.get(k)||0)
  return { labels, inData, outData }
}

function buildOrUpdateCharts(items) {
  if (!chartsWrap || chartsWrap.classList.contains('hidden')) return

  const { labels, inData, outData } = bucketByHour(items)
  const volCfg = {
    type: 'bar',
    data: { labels, datasets: [ { label:'Entrantes', data: inData }, { label:'Salientes', data: outData } ] },
    options: { responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } }, plugins:{ legend:{ position:'bottom' } } }
  }
  if (volumeChart) { volumeChart.data = volCfg.data; volumeChart.update() }
  else { volumeChart = new Chart($('#volumeChart').getContext('2d'), volCfg) }

  const outs = items.filter(x => x.type === 'out')
  const ok = outs.filter(x => x.ok).length
  const ko = outs.filter(x => x.ok === false).length
  const stCfg = {
    type: 'doughnut',
    data: { labels:['OK','ERROR'], datasets:[{ data:[ok, ko] }] },
    options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'bottom' } } }
  }
  if (statusChart) { statusChart.data = stCfg.data; statusChart.update() }
  else { statusChart = new Chart($('#statusChart').getContext('2d'), stCfg) }
}

function resizeCharts() {
  try { volumeChart?.resize() } catch {}
  try { statusChart?.resize() } catch {}
}
function resizeChartsSoon() { setTimeout(resizeCharts, 60) }

// acciones tarjetas de gráficas
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]')
  if (!btn) return
  const action = btn.dataset.action
  const target = btn.dataset.target
  const card = document.querySelector(`#card-${target}`)
  const body = document.querySelector(`#card-body-${target}`)
  if (!card || !body) return

  if (action === 'toggle-collapse') {
    const hidden = body.classList.toggle('hidden')
    btn.textContent = hidden ? '▸ Mostrar' : '▾ Ocultar'
    resizeChartsSoon()
  }
  if (action === 'toggle-expand') {
    const toExpand = !card.classList.contains('expanded')
    card.classList.toggle('expanded', toExpand)
    chartsBackdrop.classList.toggle('hidden', !toExpand)
    btn.textContent = toExpand ? '🡼 Comprimir' : '⤢ Expandir'
    resizeChartsSoon()
  }
})

// cerrar expandido con backdrop
chartsBackdrop.addEventListener('click', () => {
  document.querySelectorAll('.chart-card.expanded').forEach(c => c.classList.remove('expanded'))
  chartsBackdrop.classList.add('hidden')
  resizeChartsSoon()
})

// ordenar por fecha al clicar el th
$('#th-fecha').onclick = () => {
  if (state.sortBy !== 'ts') state.sortBy = 'ts'
  state.sortDir = (state.sortDir === 'desc') ? 'asc' : 'desc'
  $('#sort-ind').textContent = state.sortDir === 'desc' ? '▼' : '▲'
  // mantén la página actual pero recalcula
  render()
}

// eventos UI filtros/paginación
$('#b-refresh').onclick = refresh
$('#b-clear').onclick = async ()=>{
  if (!confirm('¿Borrar el log?')) return
  await fetch('/api/events', { method: 'DELETE' })
  state.page = 1
  refresh()
}
$('#f-text').oninput = () => { window.clearTimeout(window.__t); window.__t=setTimeout(()=>{ state.page=1; render() },250) }
$('#f-type').onchange = () => { state.page=1; render() }
$('#f-limit').onchange = refresh
$('#page-size').onchange = () => { state.pageSize = Number($('#page-size').value||50); state.page = 1; render() }
$('#page-prev').onclick = () => { state.page = Math.max(1, state.page-1); render() }
$('#page-next').onclick = () => { state.page = state.page+1; render() } // límite se corrige en render

function render() {
  // usa el mismo límite para CSV
  const limit = Number($('#f-limit').value || 500)
  $('#b-csv').href = `/api/events.csv?limit=${encodeURIComponent(limit)}`
  const items = applyFiltersAndSort(__items)
  buildOrUpdateCharts(items)
  renderTablePage(items)
}

async function refresh() {
  const limit = Number($('#f-limit').value || 500)
  await fetchStats(limit)
  __items = await fetchEvents(limit)
  // por defecto ya mostramos desc; indicador:
  $('#sort-ind').textContent = state.sortDir === 'desc' ? '▼' : '▲'
  render()
}

// === SSE: refresca solo con datos nuevos ===
function connectEventsStream() {
  const es = new EventSource('/events-stream')

  es.addEventListener('init', (e) => {
    try {
      const d = JSON.parse(e.data || '{}')
      window.__lastTs = d.lastTs || 0
      refresh()
    } catch {}
  })

  es.addEventListener('new', (e) => {
    try {
      const d = JSON.parse(e.data || '{}')
      if (d.ts && (!window.__lastTs || d.ts > window.__lastTs)) {
        window.__lastTs = d.ts
        refresh()
      }
    } catch {}
  })

  es.onerror = () => {
    try { es.close() } catch {}
    setTimeout(connectEventsStream, 3000)
  }
}

connectEventsStream()

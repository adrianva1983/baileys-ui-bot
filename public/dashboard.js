// Puedes seguir usando vanilla; jQuery ya está disponible por si lo prefieres.
const $q = (s)=>document.querySelector(s)
const fmt = ts => new Date(ts).toLocaleString()

let volumeChart, statusChart
let __items = []

// estado UI
const chartsWrap = $q('#charts-wrap')
const chartsBackdrop = $q('#charts-backdrop')
const toggleChartsBtn = $q('#toggle-charts')

// paginación + orden
let state = {
  sortBy: 'ts',
  sortDir: 'desc', // más nuevo -> más viejo (por defecto)
  page: 1,
  pageSize: Number($q('#page-size').value || 50),
}

const LS_KEY = 'chartsVisible'
function setChartsVisible(v) {
  chartsWrap.classList.toggle('hidden', !v)
  toggleChartsBtn.textContent = v ? 'Ocultar gráficas' : 'Mostrar gráficas'
  localStorage.setItem(LS_KEY, v ? '1' : '0')
  if (v) resizeChartsSoon()
}
setChartsVisible(localStorage.getItem(LS_KEY) === '1')

// Toggle global de gráficas (Bootstrap no es necesario aquí)
toggleChartsBtn.addEventListener('click', () => {
  const nowVisible = chartsWrap.classList.contains('hidden')
  setChartsVisible(nowVisible)
})

async function fetchStats(limit) {
  const r = await fetch('/api/stats'); const j = await r.json().catch(()=>({}))
  if (!j.ok) return
  $q('#k-sent').textContent = j.stats.sent
  $q('#k-in').textContent = j.stats.received
  $q('#k-failed').textContent = j.stats.failed
  $q('#k-uniq').textContent = j.stats.uniqueNumbers
}

async function fetchEvents(limit) {
  const r = await fetch(`/api/events?limit=${encodeURIComponent(limit||500)}`)
  const j = await r.json().catch(()=>({}))
  if (!j.ok) return []
  return j.items || []
}

function applyFiltersAndSort(items) {
  const q = ($q('#f-text').value||'').toLowerCase().trim()
  const t = $q('#f-type').value
  let res = items.filter(x =>
    (!t || x.type===t) &&
    (!q || (x.text||'').toLowerCase().includes(q) || (x.number||x.to||'').includes(q))
  )
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
      ? (x.ok ? `<span class="badge text-bg-success">OK</span>` : `<span class="badge text-bg-danger">ERROR</span>`)
      : `<span class="badge text-bg-info">IN</span>`
    return `<tr>
      <td>${fmt(x.ts)}</td>
      <td>${x.type}</td>
      <td>${numero}</td>
      <td>${(x.text||'').replace(/</g,'&lt;')}</td>
      <td>${x.template||''}</td>
      <td>${estado}</td>
    </tr>`
  }).join('')

  $q('#tbody').innerHTML = rows || `<tr><td colspan="6" class="text-secondary">Sin datos</td></tr>`

  $q('#page-pos').textContent = `Página ${state.page} / ${pages}`
  $q('#page-prev').disabled = state.page <= 1
  $q('#page-next').disabled = state.page >= pages

  $q('#pager-info').textContent = `${total} resultado(s) filtrado(s)`
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
  else { volumeChart = new Chart($q('#volumeChart').getContext('2d'), volCfg) }

  const outs = items.filter(x => x.type === 'out')
  const ok = outs.filter(x => x.ok).length
  const ko = outs.filter(x => x.ok === false).length
  const stCfg = {
    type: 'doughnut',
    data: { labels:['OK','ERROR'], datasets:[{ data:[ok, ko] }] },
    options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'bottom' } } }
  }
  if (statusChart) { statusChart.data = stCfg.data; statusChart.update() }
  else { statusChart = new Chart($q('#statusChart').getContext('2d'), stCfg) }
}

function resizeCharts() {
  try { volumeChart?.resize() } catch {}
  try { statusChart?.resize() } catch {}
}
function resizeChartsSoon() { setTimeout(resizeCharts, 60) }

// Acciones de tarjetas (ocultar / expandir)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]')
  if (!btn) return
  const action = btn.dataset.action
  const target = btn.dataset.target
  const card = document.querySelector(`#card-${target}`) || btn.closest('.chart-card')
  const body = document.querySelector(`#card-body-${target}`) || card?.querySelector('.chart-body')
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

// Ordenar por fecha (asc/desc)
$q('#th-fecha').addEventListener('click', () => {
  if (state.sortBy !== 'ts') state.sortBy = 'ts'
  state.sortDir = (state.sortDir === 'desc') ? 'asc' : 'desc'
  $q('#sort-ind').textContent = state.sortDir === 'desc' ? '▼' : '▲'
  render()
})

// Filtros y paginación
$q('#b-refresh').addEventListener('click', refresh)
$q('#b-clear').addEventListener('click', async ()=>{
  if (!confirm('¿Borrar el log?')) return
  await fetch('/api/events', { method: 'DELETE' })
  state.page = 1
  refresh()
})
$q('#f-text').addEventListener('input', () => { clearTimeout(window.__t); window.__t=setTimeout(()=>{ state.page=1; render() },250) })
$q('#f-type').addEventListener('change', () => { state.page=1; render() })
$q('#f-limit').addEventListener('change', refresh)
$q('#page-size').addEventListener('change', () => { state.pageSize = Number($q('#page-size').value||50); state.page = 1; render() })
$q('#page-prev').addEventListener('click', () => { state.page = Math.max(1, state.page-1); render() })
$q('#page-next').addEventListener('click', () => { state.page = state.page+1; render() })

function render() {
  const limit = Number($q('#f-limit').value || 500)
  $q('#b-csv').href = `/api/events.csv?limit=${encodeURIComponent(limit)}`
  const items = applyFiltersAndSort(__items)
  buildOrUpdateCharts(items)
  renderTablePage(items)
}

async function refresh() {
  const limit = Number($q('#f-limit').value || 500)
  await fetchStats(limit)
  __items = await fetchEvents(limit)
  $q('#sort-ind').textContent = state.sortDir === 'desc' ? '▼' : '▲'
  render()
}

// === SSE: refresca SOLO cuando hay nuevos datos ===
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

// === Logout WhatsApp ===
const logoutBtn = document.querySelector('#b-logout')
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    if (!confirm('¿Cerrar la sesión de WhatsApp y borrar credenciales (baileys_auth)?')) return
    try {
      const res = await fetch('/logout', { method: 'POST' })
      const j = await res.json().catch(()=>({}))
      if (res.ok && j.ok) {
        // El servidor ya borra AUTH_DIR (baileys_auth) y reinicia el flujo de QR:contentReference[oaicite:4]{index=4}
        alert(j.msg || 'Sesión cerrada. Redirigiendo al QR…')
        window.location.href = '/qr.html'
      } else {
        alert(j.msg || 'No se pudo cerrar la sesión')
      }
    } catch {
      alert('Error de red al cerrar sesión')
    }
  })
}


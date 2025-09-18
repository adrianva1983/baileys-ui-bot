// app.js
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys"
import qrcode from "qrcode"
import express from "express"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SEND_RATE_MS = Number(process.env.SEND_RATE_MS || 800)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 🔐 Carpeta de credenciales (una sola verdad)
const AUTH_DIR = path.resolve(process.env.AUTH_DIR || path.join(__dirname, "baileys_auth"))
console.log("[Auth]", AUTH_DIR)

// ==== LOG (eventos enviados/recibidos) ====
const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(__dirname, "data"))
const LOG_FILE = path.join(LOG_DIR, "events.ndjson")

function ensureLogDir() { try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch {} }
ensureLogDir()

function logEvent(ev = {}) {
  const ts = Date.now()
  const row = JSON.stringify({ ts, iso: new Date(ts).toISOString(), ...ev }) + "\n"
  try { fs.appendFileSync(LOG_FILE, row, "utf8") } catch (e) { console.warn("[logEvent] no se pudo escribir:", e.message) }

  // 👇 marca último TS y notifica por SSE a los dashboards conectados
  LAST_EVENT_TS = ts
  dashBroadcast('new', { ts })
}

function readEvents({ limit = 500, since = 0 } = {}) {
  try {
    const txt = fs.readFileSync(LOG_FILE, "utf8")
    const lines = txt.split("\n").filter(Boolean)
    const out = []
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const obj = JSON.parse(lines[i])
        if (!since || obj.ts >= since) out.push(obj)
      } catch {}
    }
    return out.reverse()
  } catch { return [] }
}

let sock = null
let connectPromise = null

let latestQR = null
let connectionStatus = "init" // init | waiting-qr | open-but-not-linked | connected | reconnecting | logged-out | closed | logging-out
let lastError = null
let meId = null
let meName = null

// ---- Notificaciones SSE (dashboard) ----
let LAST_EVENT_TS = 0
const dashClients = new Set()

function dashBroadcast(type, payload) {
  const str = JSON.stringify(payload || {})
  for (const res of dashClients) {
    try { res.write(`event: ${type}\ndata: ${str}\n\n`) } catch {}
  }
}

// ---------- Utiles ----------
function jidToNumber(jid = "") { return jid.split("@")[0] || "" }
function numberToJid(num) {
  const clean = String(num || "").replace(/[^\d]/g, "")
  if (!clean) return null
  return `${clean}@s.whatsapp.net`
}
function getTextFromMessage(msg) {
  const m = msg?.message || {}
  if (m.conversation) return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text
  if (m.ephemeralMessage?.message) return getTextFromMessage({ message: m.ephemeralMessage.message })
  if (m.imageMessage?.caption) return m.imageMessage.caption
  if (m.videoMessage?.caption) return m.videoMessage.caption
  if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) return m.listResponseMessage.singleSelectReply.selectedRowId
  if (m.documentWithCaptionMessage?.message?.documentMessage?.caption) return m.documentWithCaptionMessage.message.documentMessage.caption
  return ""
}
function getMessageType(msg) {
  let m = msg?.message || {}
  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message
  if (!m || typeof m !== "object") return "unknown"
  const keys = Object.keys(m)
  return keys[0] || "unknown"
}
function getMentions(msg) {
  const ci = msg?.message?.extendedTextMessage?.contextInfo
    || msg?.message?.conversationContextInfo
    || msg?.message?.imageMessage?.contextInfo
    || msg?.message?.videoMessage?.contextInfo
    || msg?.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo
  const arr = ci?.mentionedJid || []
  return arr.map(jidToNumber)
}
function getQuoted(msg) {
  const ci = msg?.message?.extendedTextMessage?.contextInfo
    || msg?.message?.imageMessage?.contextInfo
    || msg?.message?.videoMessage?.contextInfo
    || msg?.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo
  const qm = ci?.quotedMessage
  if (!qm) return undefined
  const type = Object.keys(qm)[0]
  const text =
    qm.conversation ||
    qm.extendedTextMessage?.text ||
    qm.imageMessage?.caption ||
    qm.videoMessage?.caption ||
    ""
  return clean({ type, text: text || undefined })
}
function getMediaFlags(msg) {
  const m = msg?.message || {}
  const e = m.ephemeralMessage?.message || {}
  const src = Object.keys(e).length ? e : m
  return clean({
    image: !!src.imageMessage,
    video: !!src.videoMessage,
    audio: !!src.audioMessage,
    document: !!src.documentMessage,
    sticker: !!src.stickerMessage,
    location: !!src.locationMessage || !!src.liveLocationMessage,
    contact: !!src.contactMessage || !!src.contactsArrayMessage,
  })
}
function tsToISO(ts) {
  const n = Number(ts || 0)
  return n ? new Date((n < 10_000_000_000 ? n * 1000 : n)).toISOString() : undefined
}
function clean(obj) {
  if (!obj || typeof obj !== "object") return obj
  const out = Array.isArray(obj) ? [] : {}
  Object.entries(obj).forEach(([k, v]) => {
    if (v === undefined || v === null) return
    if (Array.isArray(v) && v.length === 0) return
    if (typeof v === "object" && !Array.isArray(v)) {
      const c = clean(v)
      if (c && Object.keys(c).length) out[k] = c
    } else {
      out[k] = v
    }
  })
  return out
}
function summarizeMessage(msg) {
  const remote = msg.key.remoteJid || ""
  const isGroup = remote.endsWith("@g.us")
  const text = getTextFromMessage(msg).trim()
  const msgType = getMessageType(msg)
  return clean({
    chatType: isGroup ? "group" : "private",
    id: msg.key.id,
    timestamp: tsToISO(msg.messageTimestamp || msg.timestamp),
    from: clean({
      number: isGroup ? jidToNumber(msg.key.participant || "") : jidToNumber(remote),
      name: msg.pushName || undefined,
    }),
    group: isGroup ? clean({ id: jidToNumber(remote) }) : undefined,
    msgType,
    text: text || undefined,
    mentions: getMentions(msg),
    quoted: getQuoted(msg),
    media: getMediaFlags(msg),
  })
}

// --- Helpers robustos para borrar AUTH_DIR --- //
async function sleepMs(ms){ return new Promise(r=>setTimeout(r, ms)) }
async function pathExists(p){ try { await fs.promises.access(p); return true } catch { return false } }
async function rmRecursive(dir, tries=5){
  let lastErr = null
  for (let i=0;i<tries;i++){
    try {
      await fs.promises.rm(dir, { recursive:true, force:true })
      if (!(await pathExists(dir))) return { ok:true }
    } catch(e){ lastErr = e }
    await sleepMs(200*(i+1))
  }
  return { ok:false, err:lastErr }
}
async function deleteContentsIndividually(dir){
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes:true })
    for (const e of entries){
      const p = path.join(dir, e.name)
      try {
        if (e.isDirectory()) await fs.promises.rm(p, { recursive:true, force:true })
        else await fs.promises.unlink(p)
      } catch {}
    }
    await fs.promises.rmdir(dir).catch(()=>{})
  } catch {}
}
async function nukeAuthDir(){
  const dir = AUTH_DIR
  const exists = await pathExists(dir)
  if (!exists) return { ok:true, step:"skip", msg:"AUTH_DIR no existe" }
  const tomb = `${dir}.old-${Date.now()}`
  try { await fs.promises.rename(dir, tomb) }
  catch (e) {
    const r1 = await rmRecursive(dir, 6)
    if (r1.ok) return { ok:true, step:"rm-direct" }
    await deleteContentsIndividually(dir)
    const left = await pathExists(dir)
    return left ? { ok:false, step:"rm-direct-fallback", err:"No se pudo borrar AUTH_DIR" }
                : { ok:true, step:"rm-direct-fallback" }
  }
  const r2 = await rmRecursive(tomb, 6)
  if (r2.ok) return { ok:true, step:"rm-renamed" }
  await deleteContentsIndividually(tomb)
  const left = await pathExists(tomb)
  return left ? { ok:false, step:"rm-renamed-fallback", err:"No se pudo borrar AUTH_DIR renombrado" }
              : { ok:true, step:"rm-renamed-fallback" }
}

// Llama a tu endpoint PHP y devuelve un texto para responder (POST normal)
async function getReplyFromPHP({ fromNumber, text, jid }) {
  const PHP_ENDPOINT = process.env.PHP_ENDPOINT || "http://php/whatsapp.php"
  const SECRET = process.env.PHP_SECRET || "cambia-este-secreto"
  const form = new URLSearchParams({ secret: SECRET, fromNumber, text, jid })

  async function once(url = PHP_ENDPOINT) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept": "application/json",
        "Connection": "close",
      },
      body: form.toString(),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`PHP ${res.status} ${res.statusText} :: ${body}`)
    }
    const data = await res.json().catch(() => ({}))
    const replyText = data?.text || ""
    if (!replyText) throw new Error("PHP no devolvió 'text'")
    return replyText
  }

  try { return await once() }
  catch (e) {
    if (e?.name === "AbortError" || /aborted|ECONNRESET|socket hang up/i.test(String(e))) {
      return await once(`${PHP_ENDPOINT}?_=${Date.now()}`)
    }
    throw e
  }
}

// ---------- Conexión ----------
async function connectToWhatsApp() {
  if (connectPromise) return connectPromise
  connectPromise = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion().catch(()=>({ version: undefined }))
    sock = makeWASocket({
      auth: state,
      version,
      browser: ["Chrome","Windows","10"],
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 45_000,
      keepAliveIntervalMs: 25_000,
      emitOwnEvents: false
    })

    // Mensajes entrantes → consola y SSE (NO leídos)
    sock.ev.on("messages.upsert", async (event) => {
      try {
        if (event.type !== "notify") return
        const msg = event.messages?.[0]
        if (!msg || msg.key.fromMe) return

        const summary = summarizeMessage(msg)

        // 👉 Si es grupo: solo aviso por consola y salgo
        if (summary.chatType === "group") {
          const gid = summary.group?.id || jidToNumber(msg.key.remoteJid || "")
          console.log(`📣 Mensaje de GRUPO ignorado (ID: ${gid})`)
          return
        }

        if (summary.chatType === "private") {
          console.dir(summary, { depth: null, colors: true })

          // Log ENTRANTE
          logEvent({
            type: "in",
            number: summary.from?.number,
            name: summary.from?.name || null,
            text: summary.text || "",
            msgType: summary.msgType,
          })

          if (summary.from?.number === "34644619636") {
            const replyText = await getReplyFromPHP({
              fromNumber: summary.from.number,
              text: summary.text || "",
              jid: numberToJid(summary.from.number),
              raw: summary,
            })
            await sock.sendMessage(numberToJid(summary.from.number), { text: replyText })
            console.log("↩️ Respuesta enviada:", replyText)

            // Log SALIENTE auto
            logEvent({ type: "out", to: summary.from.number, text: replyText, source: "auto", ok: true })
          }
        }

        // envía a la UI (último mensaje)
        const payload = {
          isGroup: summary.chatType === "group",
          number: summary.from?.number,
          groupId: summary.group?.id || null,
          text: summary.text || "",
        }
        broadcastMsgSSE(payload)

      } catch (e) {
        console.error("Error en messages.upsert:", e)
      }
    })

    // Persistencia de credenciales / datos de usuario
    sock.ev.on("creds.update", async () => {
      await saveCreds()
      meId = state?.creds?.me?.id || sock?.user?.id || null
      meName = state?.creds?.me?.name || sock?.user?.name || null
      broadcastSSE()
    })

    // Estado de conexión
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr && connectionStatus !== "connected") {
        connectionStatus = "waiting-qr"
        qrcode.toDataURL(qr, (err, url) => {
          if (!err) { latestQR = url; broadcastSSE() }
        })
      }

      if (connection === "open") {
        meId = meId || state?.creds?.me?.id || sock?.user?.id || null
        meName = meName || state?.creds?.me?.name || sock?.user?.name || null
        if (meId) {
          connectionStatus = "connected"
          lastError = null
          console.log("✅ Vinculado como:", meId)
          latestQR = null
          broadcastSSE()
        } else {
          connectionStatus = "open-but-not-linked"
          broadcastSSE()
        }
      }

      if (connection === "close") {
        const errMsg = String(lastDisconnect?.error?.message || "")
        const status = lastDisconnect?.error?.output?.statusCode

        const isQRExhausted = /QR refs attempts ended/i.test(errMsg)
        const isLoggedOut = status === DisconnectReason.loggedOut

        if (isQRExhausted || isLoggedOut) {
          console.warn("⚠️ Sesión inválida / intentos de QR agotados. Reiniciando credenciales…")
          // No esperes al recolector; fuerza un logout limpio
          safeDisconnect().then(()=>{}).catch(()=>{})
          return
        }

        const shouldReconnect = !isLoggedOut && !isQRExhausted
        lastError = lastDisconnect?.error?.message || null
        connectionStatus = shouldReconnect ? "reconnecting" : "logged-out"
        broadcastSSE()
        if (shouldReconnect) {
          connectToWhatsApp().catch((e) => {
            lastError = e?.message || String(e)
            connectionStatus = "closed"
            broadcastSSE()
          })
        }
      }
    })
  })().finally(() => { connectPromise = null })
  return connectPromise
}

// ---------- Express + SSE ----------
const app = express()
app.use(express.static(path.join(__dirname, "public")))
app.use(express.json())

const sseClients = new Set()

app.get("/qr-events", async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  })
  res.write("retry: 5000\n\n")

  sseClients.add(res)
  req.on("close", () => { clearInterval(ka); sseClients.delete(res) })

  // estado inicial
  sendSSE(res)

  // ping/keep-alive
  const ka = setInterval(() => {
    try { res.write(`event: ping\ndata: ${Date.now()}\n\n`) }
    catch { clearInterval(ka); sseClients.delete(res) }
  }, 15000)
})
// ---- SSE para dashboard: empuja "new" cuando hay eventos nuevos ----
app.get("/events-stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  })
  res.write("retry: 5000\n\n")

  dashClients.add(res)
  req.on("close", () => { clearInterval(ka); dashClients.delete(res) })

  // Estado inicial: manda el último TS conocido
  res.write(`event: init\ndata: ${JSON.stringify({ lastTs: LAST_EVENT_TS })}\n\n`)

  // keep-alive
  const ka = setInterval(() => {
    try { res.write(`event: ping\ndata: ${Date.now()}\n\n`) }
    catch { clearInterval(ka); dashClients.delete(res) }
  }, 15000)
})

function sendSSE(res) {
  res.write(`event: update\ndata: ${JSON.stringify({ latestQR, connectionStatus, lastError, meId, meName })}\n\n`)
}
function broadcastSSE() { for (const res of sseClients) sendSSE(res) }
function broadcastMsgSSE(payload) {
  const str = JSON.stringify(payload)
  for (const res of sseClients) res.write(`event: msg\ndata: ${str}\n\n`)
}

// ---------- API: enviar mensaje de prueba ----------
app.post("/send-test", async (req, res) => {
  try {
    const { to, text } = req.body || {}
    if (!sock) return res.status(503).json({ ok: false, msg: "Socket no iniciado" })
    if (!to || !text) return res.status(400).json({ ok: false, msg: "Faltan campos {to, text}" })
    const jid = numberToJid(to)
    if (!jid) return res.status(400).json({ ok: false, msg: "Número inválido" })

    await sock.sendMessage(jid, { text })
    logEvent({ type: "out", to: jidToNumber(jid), text, source: "send-test", ok: true })
    return res.json({ ok: true })
  } catch (e) {
    try { logEvent({ type: "out", to: (req.body?.to||""), text: (req.body?.text||""), source: "send-test", ok: false, error: e?.message || String(e) }) } catch {}
    return res.status(500).json({ ok: false, msg: e?.message || String(e) })
  }
})

// items: [{ to, text }]  o  [{ to, template:"hipotea", nombre, tuNombre, origen, url }]
async function sendBatchFromArray(items = []) {
  if (!sock || !sock.user) throw new Error("No conectado a WhatsApp")
  if (!Array.isArray(items) || items.length === 0) return { ok: true, total: 0, results: [] }

  const results = []
  for (const item of items) {
    try {
      if (!item?.to) throw new Error("Falta 'to'")
      const jid = numberToJid(item.to)
      if (!jid) throw new Error("Número inválido")

      const payload = item.template === "hipotea"
        ? { text: `Hola ${item.nombre || "Cliente"} — ${item.url || ""}` }
        : { text: String(item.text || "Mensaje de prueba1 ✅") }

      await sock.sendMessage(jid, payload)
      logEvent({ type: "out", to: jidToNumber(jid), text: payload.text || null, template: item.template || null, source: "batch", ok: true })
      console.log(`[BATCH] OK -> ${jid}`)
      results.push({ to: item.to, ok: true })
    } catch (e) {
      logEvent({ type: "out", to: item?.to || null, text: item?.text || null, template: item?.template || null, source: "batch", ok: false, error: e?.message || String(e) })
      console.error(`[BATCH] ERROR con ${item?.to}:`, e?.message || e)
      results.push({ to: item?.to || null, ok: false, error: e?.message || String(e) })
    }
    if (SEND_RATE_MS > 0) await sleep(SEND_RATE_MS)
  }
  return { ok: true, total: items.length, results }
}

// POST /send-batch  con body: { items: [ ... ] }
app.post("/send-batch", async (req, res) => {
  try {
    const { items } = req.body || {}
    if (!Array.isArray(items)) return res.status(400).json({ ok: false, error: "Body debe incluir 'items' (array)" })
    const r = await sendBatchFromArray(items)
    res.json(r)
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "send-batch failed" })
  }
})

// GET /send-batch-demo -> ejemplo
app.get("/send-batch-demo", async (_req, res) => {
  try {
    const demo = [
      { to: "34644619636", text: "Mensaje de prueba2 ✅" }
    ]
    const r = await sendBatchFromArray(demo)
    res.json(r)
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "demo failed" })
  }
})

// ---------- Logout en caliente (sin tumbar Node) ----------
// Cierra sesión, corta sockets, borra AUTH_DIR y vuelve a iniciar para generar QR
async function safeDisconnect() {
  try {
    connectionStatus = "logging-out"
    broadcastSSE()

    // 1) Quitar listeners y cerrar sesión/socket
    try { sock?.ev?.removeAllListeners?.() } catch {}
    try { await sock?.logout?.() } catch {}
    try { sock?.end?.(true) } catch {}
    sock = null
    connectPromise = null

    // 2) Pequeña espera para liberar descriptores de fichero
    await sleepMs(600)

    // 3) Borrar AUTH_DIR con rutina robusta
    const nuke = await nukeAuthDir()
    if (!nuke.ok) {
      console.warn("[Auth] nukeAuthDir falló:", nuke.err || nuke)
      throw new Error(`No se pudo borrar AUTH_DIR (paso: ${nuke.step || 'unknown'})`)
    }
    console.log("[Auth] limpiada:", AUTH_DIR, `(modo: ${nuke.step})`)

    // 4) Recrea carpeta para el siguiente login limpio
    try { await fs.promises.mkdir(AUTH_DIR, { recursive:true }) } catch (e) {
      console.warn("[Auth] no se pudo recrear AUTH_DIR:", e?.message || e)
    }

    // 5) Reset de estado y notificación
    latestQR = null
    meId = null
    meName = null
    lastError = null
    connectionStatus = "logged-out"
    broadcastSSE()

    // 6) Reconectar para generar QR nuevo
    await connectToWhatsApp()

    return { ok: true, removed:true }
  } catch (e) {
    lastError = e?.message || String(e)
    connectionStatus = "closed"
    broadcastSSE()
    return { ok: false, msg: lastError }
  }
}

app.post("/logout", async (_req, res) => {
  const r = await safeDisconnect()
  if (r.ok) res.status(200).json({ ok: true, msg: "Sesión cerrada. Generando nuevo QR...", removed: !!r.removed, authPath: AUTH_DIR })
  else res.status(500).json(r)
})

// === API Dashboard ===
app.get("/api/events", (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 300)))
  const since = Number(req.query.since || 0)
  res.json({ ok: true, items: readEvents({ limit, since }) })
})
app.get("/api/stats", (_req, res) => {
  const items = readEvents({ limit: 1000 })
  const stats = {
    total: items.length,
    sent: items.filter(x => x.type === "out").length,
    received: items.filter(x => x.type === "in").length,
    failed: items.filter(x => x.type === "out" && !x.ok).length,
    uniqueNumbers: new Set(items.map(x => x.number || x.to).filter(Boolean)).size,
    lastTs: items.at(-1)?.ts || null,
  }
  res.json({ ok: true, stats })
})
// GET /api/events.csv?limit=1000&since=1690000000000
app.get("/api/events.csv", (req, res) => {
  const limit = Math.min(5000, Math.max(1, Number(req.query.limit || 1000)))
  const since = Number(req.query.since || 0)
  const items = readEvents({ limit, since })

  // CSV helpers
  const esc = (v) => {
    if (v === null || v === undefined) return '""'
    const s = String(v).replace(/"/g, '""')
    return `"${s}"`
  }

  const header = [
    "ts","iso","type","number","name","text","template","source","ok","error"
  ].join(",")

  const rows = items.map(x => ([
    x.ts,
    x.iso,
    x.type || "",
    x.number || x.to || "",
    x.name || "",
    x.text || "",
    x.template || "",
    x.source || "",
    (typeof x.ok === "boolean" ? x.ok : ""),
    x.error || ""
  ].map(esc).join(",")))

  res.setHeader("Content-Type", "text/csv; charset=utf-8")
  const filename = `events-${new Date().toISOString().replace(/[:.]/g,"").slice(0,15)}.csv`
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
  res.send([header, ...rows].join("\n"))
})

app.delete("/api/events", async (_req, res) => {
  try { await fs.promises.rm(LOG_FILE, { force: true }); ensureLogDir(); res.json({ ok: true }) }
  catch (e) { res.status(500).json({ ok: false, msg: e?.message || String(e) }) }
})

// (Diagnóstico) ruta real de credenciales
app.get("/auth-path", async (_req, res) => {
  let exists = false, files = []
  try { exists = fs.existsSync(AUTH_DIR); files = exists ? fs.readdirSync(AUTH_DIR) : [] } catch {}
  res.json({ AUTH_DIR, exists, files })
})

// Raíz: si conectado → dashboard; si no → QR
app.get("/", (_req, res) => {
  if (connectionStatus === "connected") {
    return res.redirect("/dashboard.html")
  } else {
    return res.redirect("/qr.html")
  }
})

app.listen(3000, () => console.log("🌐 UI en http://localhost:3000/qr.html"))

// Lanzar conexión
connectToWhatsApp().catch((e) => console.error("Error iniciando WhatsApp:", e))

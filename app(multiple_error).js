// app.js (multi-sesión en un solo proceso)
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys"
import qrcode from "qrcode"
import express from "express"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

// ================== Setup básico ==================
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PORT = Number(process.env.PORT || 3000)
const SEND_RATE_MS = Number(process.env.SEND_RATE_MS || 800)
const PHP_ENDPOINT = process.env.PHP_ENDPOINT || "http://php/chat-bot/index.php" // cámbialo si quieres
const PHP_SECRET = process.env.PHP_SECRET || "cambia-este-secreto"

// ================== Utiles ==================
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
function jidToNumber(jid = "") { return String(jid).split("@")[0] || "" }
function numberToJid(num) {
  const clean = String(num || "").replace(/[^\d]/g, "")
  if (!clean) return null
  if (/@s\.whatsapp\.net$|@g\.us$/.test(num)) return String(num) // ya es JID
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
  })
}

// ============ Llamada a PHP (JSON {"text": "..."} esperado) ============
async function getReplyFromPHP({ fromNumber, text, jid }) {
  const form = new URLSearchParams({ secret: PHP_SECRET, fromNumber, text, jid })
  const once = async (url = PHP_ENDPOINT) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept": "application/json",
        "Connection": "close",
      },
      body: form.toString(),
    })
    const raw = await res.text().catch(() => "")
    if (!res.ok) throw new Error(`PHP ${res.status} ${res.statusText} :: ${raw}`)
    const j = JSON.parse(raw)
    if (!j || typeof j.text !== "string") throw new Error("PHP no devolvió 'text'")
    return j.text
  }
  try { return await once() }
  catch (e) {
    if (/aborted|ECONNRESET|hang up/i.test(String(e))) return await once(`${PHP_ENDPOINT}?_=${Date.now()}`)
    throw e
  }
}

// ================== Multi-sesión ==================
// sessions: Map<agent, {agent, sock, status, latestQR, meId, meName, lastError, sse:Set<Response>, whitelist:Set<string>}>
const sessions = new Map()
function getWhitelistFor(agent) {
  const env = process.env[`WHITELIST_${agent.toUpperCase()}`] || ""
  return new Set(env.split(",").map(s => s.trim()).filter(Boolean))
}

async function startSession(agent = "default") {
  // ya existe
  const existing = sessions.get(agent)
  if (existing?.sock) return existing

  const AUTH_DIR = path.join(__dirname, "baileys_auth", agent)
  fs.mkdirSync(AUTH_DIR, { recursive: true })

  const S = {
    agent, sock: null,
    status: "init",
    latestQR: null,
    meId: null, meName: null,
    lastError: null,
    sse: new Set(),
    whitelist: getWhitelistFor(agent),
  }
  sessions.set(agent, S)

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ["HipoteaBot", "Chrome", "1.0"],
    keepAliveIntervalMs: 20_000,
  })
  S.sock = sock

  // --- helpers SSE por sesión
  const sendUpdate = (res) => res.write(`event: update\ndata: ${JSON.stringify({
    agent: S.agent,
    latestQR: S.latestQR,
    connectionStatus: S.status,
    lastError: S.lastError,
    meId: S.meId, meName: S.meName
  })}\n\n`)
  const bcastUpdate = () => { for (const r of S.sse) sendUpdate(r) }
  const bcastMsg = (payload) => {
    const str = JSON.stringify(payload)
    for (const r of S.sse) r.write(`event: msg\ndata: ${str}\n\n`)
  }

  sock.ev.on("creds.update", async () => {
    await saveCreds()
    S.meId = state?.creds?.me?.id || sock?.user?.id || null
    S.meName = state?.creds?.me?.name || sock?.user?.name || null
    bcastUpdate()
  })

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr && S.status !== "connected") {
      qrcode.toDataURL(qr, (err, url) => {
        if (!err) {
          S.latestQR = url
          S.status = "waiting-qr"
          bcastUpdate()
        }
      })
    }
    if (connection === "open") {
      S.meId = state?.creds?.me?.id || sock?.user?.id || null
      S.meName = state?.creds?.me?.name || sock?.user?.name || null
      S.status = "connected"
      S.latestQR = null
      S.lastError = null
      console.log(`? [${agent}] Vinculado como ${S.meId}`)
      bcastUpdate()
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode
      S.lastError = lastDisconnect?.error?.message || null
      const shouldReconnect = code !== DisconnectReason.loggedOut
      S.status = shouldReconnect ? "reconnecting" : "logged-out"
      bcastUpdate()
      if (shouldReconnect) {
        setTimeout(() => startSession(agent).catch(e => {
          S.status = "closed"; S.lastError = String(e); bcastUpdate()
        }), 750)
      }
    }
  })

  sock.ev.on("messages.upsert", async ({ type, messages }) => {
    if (type !== "notify") return
    for (const msg of messages) {
      try {
        if (!msg?.message || msg.key.fromMe) continue
        const summary = summarizeMessage(msg)

        // Ignorar grupos
        if (summary.chatType === "group") {
          console.log(`?? [${agent}] GRUPO ignorado (${summary.group?.id || ""})`)
          continue
        }

        console.dir({ agent, ...summary }, { depth: null, colors: true })

        // Whitelist por sesión (mantiene tu filtro de ?teléfono único?)
        if (S.whitelist.size && !S.whitelist.has(summary.from?.number)) {
          console.log(`[${agent}] fuera de whitelist: ${summary.from?.number}`)
        } else {
          // Auto-respuesta via PHP (opcional)
          const replyText = await getReplyFromPHP({
            fromNumber: summary.from.number,
            text: summary.text || "",
            jid: numberToJid(summary.from.number)
          }).catch(() => null)

          if (replyText) {
            await sock.sendMessage(numberToJid(summary.from.number), { text: replyText })
            console.log(`?? [${agent}] Respuesta enviada`)
          }
        }

        bcastMsg({
          isGroup: false,
          number: summary.from?.number,
          groupId: null,
          text: summary.text || ""
        })
      } catch (e) {
        console.error(`[${agent}] Error en messages.upsert:`, e)
      }
    }
  })

  return S
}

// ================== Express + SSE ==================
const app = express()
app.use(express.static(path.join(__dirname, "public")))
app.use(express.json())

// SSE por agente (?agent=nombre) ? compatible con tu UI
app.get("/qr-events", async (req, res) => {
  const agent = String(req.query.agent || "default")
  const S = await startSession(agent)

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  })
  res.write("retry: 5000\n\n")

  S.sse.add(res)
  const keep = setInterval(() => { try { res.write(`event: ping\ndata: ${Date.now()}\n\n`) } catch {} }, 15000)
  req.on("close", () => { clearInterval(keep); S.sse.delete(res) })

  // estado inicial
  res.write(`event: update\ndata: ${JSON.stringify({
    agent: S.agent,
    latestQR: S.latestQR,
    connectionStatus: S.status,
    lastError: S.lastError,
    meId: S.meId,
    meName: S.meName
  })}\n\n`)
})

// Health y debug rápidos
app.get("/health", (_req, res) => {
  const states = {}
  for (const [id, S] of sessions) states[id] = { status: S.status, meId: S.meId, meName: S.meName }
  res.json({ ok: true, states })
})

// ---------- API: enviar mensaje de prueba ----------
app.post("/send-test", async (req, res) => {
  try {
    const agent = String(req.query.agent || req.body?.agent || "default")
    const S = await startSession(agent)
    const { to, text } = req.body || {}
    if (!S.sock) return res.status(503).json({ ok: false, msg: "Sesión no iniciada" })
    if (!to || !text) return res.status(400).json({ ok: false, msg: "Faltan campos {to, text}" })
    const jid = numberToJid(to)
    if (!jid) return res.status(400).json({ ok: false, msg: "Número inválido" })
    await S.sock.sendMessage(jid, { text })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, msg: e?.message || String(e) })
  }
})

// ====== envío desde array (batch) ======
async function sendBatchFromArray(agent, items = []) {
  const S = await startSession(agent)
  if (!S.sock || !S.sock.user) throw new Error("No conectado a WhatsApp")
  if (!Array.isArray(items) || items.length === 0) return { ok: true, total: 0, results: [] }

  const results = []
  for (const item of items) {
    try {
      const jid = numberToJid(item?.to)
      if (!jid) throw new Error("Número inválido")
      const payload = { text: String(item?.text || "Mensaje de prueba ?") }
      await S.sock.sendMessage(jid, payload)
      results.push({ to: item?.to, ok: true })
    } catch (e) {
      results.push({ to: item?.to || null, ok: false, error: e?.message || String(e) })
    }
    if (SEND_RATE_MS > 0) await sleep(SEND_RATE_MS)
  }
  return { ok: true, total: items.length, results }
}

// GET /send-batch-demo?agent=victor
app.get("/send-batch-demo", async (req, res) => {
  try {
    const agent = String(req.query.agent || "default")
    const demo = [
      { to: "34644550262", text: "Mensaje de prueba ?" }
    ]
    const r = await sendBatchFromArray(agent, demo)
    res.json(r)
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "demo failed" })
  }
})

// ---------- Logout por agente ----------
app.post("/logout", async (req, res) => {
  try {
    const agent = String(req.query.agent || req.body?.agent || "default")
    const S = sessions.get(agent)
    if (!S) return res.status(404).json({ ok: false, msg: "Agente desconocido" })

    try { await S.sock?.logout?.() } catch {}
    try { S.sock?.end?.(true) } catch {}
    S.sock = null

    try { fs.rmSync(path.join(__dirname, "baileys_auth", agent), { recursive: true, force: true }) } catch {}
    S.status = "logged-out"; S.latestQR = null; S.meId = null; S.meName = null

    await startSession(agent) // pedirá nuevo QR
    res.json({ ok: true, msg: `Sesión ${agent} cerrada. Generando nuevo QR...` })
  } catch (e) {
    res.status(500).json({ ok: false, msg: e?.message || String(e) })
  }
})

// Raíz
app.get("/", (_req, res) => res.redirect("/qr.html"))

// Lanzar servidor
app.listen(PORT, () => console.log(`?? UI en http://localhost:${PORT}/qr.html`))

// Arrancar sesiones iniciales
const AGENTS = (process.env.AGENTS || "default").split(",").map(s => s.trim()).filter(Boolean)
Promise.all(AGENTS.map(id => startSession(id)))
  .then(() => console.log(`Sesiones activas: ${AGENTS.join(", ")}`))
  .catch(e => console.error("Error iniciando sesiones:", e))

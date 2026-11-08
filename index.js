const express = require('express');
const cors = require('cors');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());

const sesiones = {};
const codigosQR = {};
const estadoConexion = {};
// Buzón en memoria para entregar mensajes en tiempo real a tu pantalla
const buzonMensajes = [];
const logger = pino({ level: 'silent' });

function limpiarCarpetaSesion(idMarca) {
  const ruta = path.join(__dirname, 'sesiones_wa', idMarca);
  if (fs.existsSync(ruta)) {
    fs.rmSync(ruta, { recursive: true, force: true });
  }
}

function normalizarTelefonoMexico(tel) {
  let limpio = (tel || '').replace(/\D/g, '');
  if (limpio.length === 10) return '52' + limpio;
  if (limpio.length === 13 && limpio.startsWith('521')) {
    return '52' + limpio.substring(3);
  }
  return limpio;
}

function extraerTextoMensaje(msg) {
  if (!msg || !msg.message) return '';
  return (
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    msg.message.videoMessage?.caption ||
    msg.message.buttonsResponseMessage?.selectedDisplayText ||
    msg.message.listResponseMessage?.title ||
    ''
  );
}

async function iniciarSesionWhatsApp(idMarca, forzarReinicio = false) {
  if (forzarReinicio) {
    if (sesiones[idMarca]) {
      try { sesiones[idMarca].end(); } catch (e) {}
      delete sesiones[idMarca];
    }
    delete codigosQR[idMarca];
    limpiarCarpetaSesion(idMarca);
  }

  if (sesiones[idMarca]) return sesiones[idMarca];

  const { state, saveCreds } = await useMultiFileAuthState(`./sesiones_wa/${idMarca}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 90000,
    defaultQueryTimeoutMs: 90000,
    keepAliveIntervalMs: 20000,
    getMessage: async () => ({ conversation: 'AudioMaxPlus' })
  });

  sesiones[idMarca] = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      codigosQR[idMarca] = await QRCode.toDataURL(qr);
      estadoConexion[idMarca] = 'LISTO_PARA_ESCANEAR';
    }

    if (connection === 'open') {
      codigosQR[idMarca] = null;
      estadoConexion[idMarca] = 'CONECTADO_24_7';
      console.log(`Marca ${idMarca} CONECTADA 24/7.`);
    }

    if (connection === 'close') {
      delete sesiones[idMarca];
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (codigo === 515) {
        iniciarSesionWhatsApp(idMarca, false);
      } else if (codigo === DisconnectReason.loggedOut || codigo === 401 || codigo === 403) {
        limpiarCarpetaSesion(idMarca);
        estadoConexion[idMarca] = 'DESCONECTADO';
      } else {
        setTimeout(() => iniciarSesionWhatsApp(idMarca, false), 2500);
      }
    }
  });

  // 📡 ESCUCHAR MENSAJES REALES ENTRANTES DE WHATSAPP BUSINESS
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const jid = msg.key.remoteJid || '';
      if (jid.includes('@g.us') || jid === 'status@broadcast') continue;

      const texto = extraerTextoMensaje(msg).trim();
      if (!texto) continue;

      const esMio = Boolean(msg.key.fromMe);
      const telefonoLimpio = jid.split('@')[0];
      const nombreContacto = msg.pushName || (`Paciente ${telefonoLimpio.slice(-4)}`);

      const nuevoEvento = {
        id: msg.key.id || ('msg_' + Date.now() + Math.random()),
        marcaId: idMarca,
        jid: jid,
        telefono: telefonoLimpio,
        nombre: nombreContacto,
        texto: texto,
        fromMe: esMio,
        timestamp: Date.now(),
        hora: new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
      };

      buzonMensajes.push(nuevoEvento);
      if (buzonMensajes.length > 300) buzonMensajes.shift();
      console.log(`[${idMarca}] Mensaje de ${nombreContacto}: ${texto}`);
    }
  });

  return sock;
}

app.get('/', (req, res) => {
  res.json({ ok: true, motor: 'AudioMax Business Activo con Buzón en Vivo', marcas: estadoConexion });
});

app.get('/qr-json', async (req, res) => {
  const sesion = req.query.sesion || 'audiomax';
  const reset = req.query.reset === '1';
  await iniciarSesionWhatsApp(sesion, reset);
  res.json({
    ok: true,
    conectado: estadoConexion[sesion] === 'CONECTADO_24_7',
    qr: codigosQR[sesion] || null
  });
});

app.get('/codigo-8-letras', async (req, res) => {
  try {
    const sesion = req.query.sesion || 'audiomax';
    const telefono = normalizarTelefonoMexico(req.query.telefono);
    if (telefono.length < 12) return res.json({ ok: false, codigo: 'ERROR_FORMATO' });

    const sock = await iniciarSesionWhatsApp(sesion, true);
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(telefono);
        const formateado = code?.match(/.{1,4}/g)?.join('-') || code;
        res.json({ ok: true, codigo: formateado });
      } catch (e) {
        res.json({ ok: false, codigo: 'ERROR' });
      }
    }, 4000);
  } catch (e) {
    res.json({ ok: false, codigo: 'ERROR' });
  }
});

// 📥 RUTA PARA QUE TU PÁGINA RECIBA LOS MENSAJES EN TIEMPO REAL CADA 3 SEGUNDOS
app.get('/mensajes-nuevos', (req, res) => {
  const desde = parseInt(req.query.desde || '0', 10);
  const nuevos = buzonMensajes.filter(m => m.timestamp > desde);
  res.json({ ok: true, mensajes: nuevos, estado: estadoConexion });
});

// 📤 RUTA PARA ENVIAR MENSAJES REALES (DE DIANA O TUYOS) AL WHATSAPP DEL PACIENTE
app.post('/enviar-mensaje', async (req, res) => {
  try {
    const { sesion = 'audiomax', jid, telefono, texto } = req.body;
    const sock = sesiones[sesion];
    if (!sock) return res.json({ ok: false, error: 'Sesión no conectada' });

    let destino = jid;
    if (!destino && telefono) {
      destino = telefono.replace(/\D/g, '') + '@s.whatsapp.net';
    }
    await sock.sendMessage(destino, { text: texto });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('Motor Business con Buzón en Vivo corriendo en puerto ' + PORT);
  iniciarSesionWhatsApp('audiomax');
  iniciarSesionWhatsApp('audiaplus');
});

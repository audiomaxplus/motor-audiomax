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
const logger = pino({ level: 'silent' });

function limpiarCarpetaSesion(idMarca) {
  const ruta = path.join(__dirname, 'sesiones_wa', idMarca);
  if (fs.existsSync(ruta)) {
    fs.rmSync(ruta, { recursive: true, force: true });
  }
}

// Normaliza números de México: quita el '1' después de '52' para que WhatsApp Business acepte el código
function normalizarTelefonoMexico(tel) {
  let limpio = (tel || '').replace(/\D/g, '');
  if (limpio.length === 10) return '52' + limpio;
  if (limpio.length === 13 && limpio.startsWith('521')) {
    return '52' + limpio.substring(3);
  }
  return limpio;
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
    // Mac OS Desktop pasa directo los filtros de WhatsApp Business
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
      console.log(`Marca ${idMarca} CONECTADA.`);
    }

    if (connection === 'close') {
      delete sesiones[idMarca];
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (codigo === 515) {
        // 515 es normal tras escanear QR: reconectar de inmediato sin borrar credenciales
        iniciarSesionWhatsApp(idMarca, false);
      } else if (codigo === DisconnectReason.loggedOut || codigo === 401 || codigo === 403) {
        limpiarCarpetaSesion(idMarca);
        estadoConexion[idMarca] = 'DESCONECTADO';
      } else {
        setTimeout(() => iniciarSesionWhatsApp(idMarca, false), 2500);
      }
    }
  });

  return sock;
}

app.get('/', (req, res) => {
  res.json({ ok: true, motor: 'AudioMax Business Ligero Activo', marcas: estadoConexion });
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
        res.json({ ok: true, codigo: formateado, numeroUsado: telefono });
      } catch (e) {
        res.json({ ok: false, codigo: 'ERROR' });
      }
    }, 4000);
  } catch (e) {
    res.json({ ok: false, codigo: 'ERROR' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('Motor Business corriendo en puerto ' + PORT);
  iniciarSesionWhatsApp('audiomax');
  iniciarSesionWhatsApp('audiaplus');
});

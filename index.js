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
    // Identificador oficial requerido por WhatsApp Business para no rechazar el QR
    browser: Browsers.ubuntu('Chrome'),
    // Evita que WhatsApp Business se trabe descargando miles de chats antiguos
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000
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
      console.log(`Marca ${idMarca} vinculada exitosamente.`);
    }

    if (connection === 'close') {
      delete sesiones[idMarca];
      const codigoSalida = lastDisconnect?.error?.output?.statusCode;

      // Si WhatsApp rechazó la sesión o se cerró desde el celular, limpiamos basura
      if (
        codigoSalida === DisconnectReason.loggedOut ||
        codigoSalida === DisconnectReason.badSession ||
        codigoSalida === 401 ||
        codigoSalida === 515
      ) {
        if (codigoSalida === 515) {
          // Código 515 en WhatsApp Business: pide reconexión inmediata tras escanear QR
          setTimeout(() => iniciarSesionWhatsApp(idMarca, false), 1500);
        } else {
          limpiarCarpetaSesion(idMarca);
          estadoConexion[idMarca] = 'DESCONECTADO';
          setTimeout(() => iniciarSesionWhatsApp(idMarca, false), 2000);
        }
      } else {
        setTimeout(() => iniciarSesionWhatsApp(idMarca, false), 3000);
      }
    }
  });

  return sock;
}

app.get('/', (req, res) => {
  res.json({ ok: true, motor: 'AudioMax & Audia Plus Business 24/7', marcas: estadoConexion });
});

// Ruta JSON para QR (Permite limpiar sesión trabada con &reset=1)
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

// Ruta para Código de 8 Letras optimizada para WhatsApp Business
app.get('/codigo-8-letras', async (req, res) => {
  try {
    const sesion = req.query.sesion || 'audiomax';
    const telefono = (req.query.telefono || '').replace(/\D/g, '');
    if (telefono.length < 12) return res.json({ ok: false, codigo: 'ERROR' });

    // Reiniciamos limpio para que el código de 8 letras sea fresco
    const sock = await iniciarSesionWhatsApp(sesion, true);
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(telefono);
        const formateado = code?.match(/.{1,4}/g)?.join('-') || code;
        res.json({ ok: true, codigo: formateado });
      } catch (e) {
        res.json({ ok: false, codigo: 'ERROR' });
      }
    }, 3500);
  } catch (e) {
    res.json({ ok: false, codigo: 'ERROR' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('Motor WhatsApp Business corriendo en puerto ' + PORT);
  iniciarSesionWhatsApp('audiomax');
  iniciarSesionWhatsApp('audiaplus');
});

const express = require('express');
const cors = require('cors');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());

const sesiones = {};
const codigosQR = {};
const estadoConexion = {};

async function iniciarSesionWhatsApp(idMarca) {
  if (sesiones[idMarca]) return sesiones[idMarca];

  const { state, saveCreds } = await useMultiFileAuthState(`./sesiones_wa/${idMarca}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['AudioMaxPlus ATC', 'Chrome', '122.0.0']
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
    }
    if (connection === 'close') {
      delete sesiones[idMarca];
      const codigoSalida = lastDisconnect?.error?.output?.statusCode;
      if (codigoSalida !== DisconnectReason.loggedOut) {
        setTimeout(() => iniciarSesionWhatsApp(idMarca), 3000);
      }
    }
  });

  return sock;
}

app.get('/', (req, res) => {
  res.json({ ok: true, motor: 'AudioMax & Audia Plus 24/7 Activo', marcas: estadoConexion });
});

// Ruta JSON anti-pantalla blanca para QR
app.get('/qr-json', async (req, res) => {
  const sesion = req.query.sesion || 'audiomax';
  await iniciarSesionWhatsApp(sesion);
  res.json({
    ok: true,
    conectado: estadoConexion[sesion] === 'CONECTADO_24_7',
    qr: codigosQR[sesion] || null
  });
});

// Ruta para Código de 8 Letras sin cámara
app.get('/codigo-8-letras', async (req, res) => {
  try {
    const sesion = req.query.sesion || 'audiomax';
    const telefono = (req.query.telefono || '').replace(/\D/g, '');
    if (telefono.length < 12) return res.json({ ok: false, codigo: 'ERROR' });

    const sock = await iniciarSesionWhatsApp(sesion);
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(telefono);
        const formateado = code?.match(/.{1,4}/g)?.join('-') || code;
        res.json({ ok: true, codigo: formateado });
      } catch (e) {
        res.json({ ok: false, codigo: 'ERROR' });
      }
    }, 2500);
  } catch (e) {
    res.json({ ok: false, codigo: 'ERROR' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('Motor AudioMax & Audia Plus corriendo en puerto ' + PORT);
  iniciarSesionWhatsApp('audiomax');
  iniciarSesionWhatsApp('audiaplus');
});

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

const URL_HOSTINGER = 'https://atc.audiomaxplus.com/api_whatsapp_intranet.php';
const sesiones = {};
const codigosQR = {};
const estadoConexion = {};

async function iniciarSesionWhatsApp(idSucursal, telefonoParaCodigo = null) {
  const { state, saveCreds } = await useMultiFileAuthState(`./sesiones_wa/${idSucursal}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['Audio Max Plus ATC', 'Chrome', '120.0.0']
  });

  sesiones[idSucursal] = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      codigosQR[idSucursal] = await QRCode.toDataURL(qr);
      estadoConexion[idSucursal] = 'Esperando escaneo o código';
    }
    if (connection === 'open') {
      codigosQR[idSucursal] = null;
      estadoConexion[idSucursal] = 'CONECTADO 24/7';
      console.log(`Sucursal ${idSucursal} conectada exitosamente.`);
    }
    if (connection === 'close') {
      const codigoSalida = lastDisconnect?.error?.output?.statusCode;
      estadoConexion[idSucursal] = 'Reconectando...';
      if (codigoSalida !== DisconnectReason.loggedOut) {
        setTimeout(() => iniciarSesionWhatsApp(idSucursal), 4000);
      }
    }
  });

  // Escuchar mensajes entrantes reales y avisar a Hostinger
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const remitente = msg.key.remoteJid;
      const texto =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';
      if (!texto) continue;

      console.log(`[${idSucursal}] Mensaje de ${remitente}: ${texto}`);
    }
  });

  return sock;
}

// 1. Ruta para verificar que el motor está despierto 24/7
app.get('/', (req, res) => {
  res.json({
    ok: true,
    motor: 'Audio Max Plus+ WhatsApp 24/7 Activo',
    sucursales: estadoConexion
  });
});

// 2. Ruta para pedir el Código de 8 Letras (Sin cámara, cuando el celular está lejos)
app.get('/codigo-8-letras', async (req, res) => {
  try {
    const sesion = req.query.sesion || 'lindavista';
    const telefono = (req.query.telefono || '').replace(/\D/g, '');
    if (!telefono || telefono.length < 10) {
      return res.json({ codigo: 'FALTA NUMERO' });
    }

    const sock = await iniciarSesionWhatsApp(sesion);
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(telefono);
        const formateado = code?.match(/.{1,4}/g)?.join('-') || code;
        res.json({ ok: true, codigo: formateado });
      } catch (err) {
        res.json({ ok: false, codigo: 'REINTENTA EN 5 SEG' });
      }
    }, 2500);
  } catch (e) {
    res.json({ ok: false, codigo: 'ERROR' });
  }
});

// 3. Ruta para ver el Código QR en imagen
app.get('/qr', async (req, res) => {
  const sesion = req.query.sesion || 'lindavista';
  if (!sesiones[sesion]) {
    await iniciarSesionWhatsApp(sesion);
  }
  setTimeout(() => {
    const dataUrl = codigosQR[sesion];
    if (!dataUrl) {
      return res.redirect('https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=Conectado_o_Cargando');
    }
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    const img = Buffer.from(base64Data, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': img.length });
    res.end(img);
  }, 2000);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Motor Audio Max Plus corriendo en puerto ' + PORT);
  iniciarSesionWhatsApp('lindavista');
  iniciarSesionWhatsApp('romasur');
});

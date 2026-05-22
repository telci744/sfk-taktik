const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express  = require('express');
const cors     = require('cors');
const qrcode   = require('qrcode');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const mime     = require('mime-types');
const pino     = require('pino');

const PORT       = process.env.PORT || 3001;
const SUNUCU_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100mb' }));

const uploadsDir = path.join(__dirname, 'uploads');
const authDir    = path.join(__dirname, 'auth_info');
[uploadsDir, authDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.use('/uploads', express.static(uploadsDir));

const upload = multer({ dest: uploadsDir, limits: { fileSize: 50 * 1024 * 1024 } });

let qrData = null;
let hazir  = false;
let sock   = null;

async function baslat() {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    sock = makeWASocket({
        auth:  state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Mavikonak', 'Chrome', '1.0.0'],
        generateHighQualityLinkPreview: false
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrData = await qrcode.toDataURL(qr);
            hazir  = false;
            console.log('📱 QR kodu oluşturuldu');
        }

        if (connection === 'close') {
            hazir  = false;
            qrData = null;
            const statusCode   = lastDisconnect?.error?.output?.statusCode;
            const cikisYapildi = statusCode === DisconnectReason.loggedOut;
            console.log('🔴 Bağlantı kesildi:', statusCode);
            setTimeout(baslat, cikisYapildi ? 1000 : 4000);
        }

        if (connection === 'open') {
            hazir  = true;
            qrData = null;
            console.log('🟢 WhatsApp bağlandı!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

console.log('⏳ WhatsApp başlatılıyor...');
baslat().catch(console.error);

// ── Endpoints ─────────────────────────────────────────────────

app.get('/durum', (req, res) => res.json({ hazir, qr: qrData }));

app.get('/gruplar', async (req, res) => {
    if (!hazir) return res.status(503).json({ hata: 'WhatsApp bağlı değil' });
    try {
        const veri    = await sock.groupFetchAllParticipating();
        const gruplar = Object.values(veri)
            .map(g => ({ id: g.id, ad: g.subject, uyeSayisi: g.participants?.length || 0 }))
            .sort((a, b) => a.ad.localeCompare(b.ad, 'tr'));
        res.json(gruplar);
    } catch (e) {
        res.status(500).json({ hata: e.message });
    }
});

app.post('/gonder', async (req, res) => {
    if (!hazir) return res.status(503).json({ hata: 'WhatsApp bağlı değil' });

    const { grupIdler, mesaj, dosyaUrl, dosyaAdi } = req.body;
    if (!grupIdler?.length)    return res.status(400).json({ hata: 'En az bir grup seçilmeli' });
    if (!mesaj && !dosyaUrl)   return res.status(400).json({ hata: 'Mesaj veya dosya gerekli' });

    const sonuclar = [];

    for (let i = 0; i < grupIdler.length; i++) {
        const grupId = grupIdler[i];
        try {
            if (dosyaUrl) {
                const dosyaAdiUrl = path.basename(new URL(dosyaUrl).pathname);
                const tamYol      = path.join(uploadsDir, dosyaAdiUrl);
                const buffer      = fs.readFileSync(tamYol);
                const mimeType    = mime.lookup(tamYol) || 'application/octet-stream';
                const goruntulAd  = dosyaAdi || dosyaAdiUrl;

                const icerik = mimeType.startsWith('image/')
                    ? { image: buffer, caption: mesaj || '', mimetype: mimeType }
                    : { document: buffer, mimetype: mimeType, fileName: goruntulAd, caption: mesaj || '' };

                await sock.sendMessage(grupId, icerik);
            } else {
                await sock.sendMessage(grupId, { text: mesaj });
            }
            sonuclar.push({ grupId, basari: true });
            console.log(`  ✅ Gönderildi → ${grupId}`);
        } catch (e) {
            sonuclar.push({ grupId, basari: false, hata: e.message });
            console.log(`  ❌ Hata (${grupId}):`, e.message);
        }
        if (i < grupIdler.length - 1) await new Promise(r => setTimeout(r, 4000));
    }

    const basarili = sonuclar.filter(s => s.basari).length;
    console.log(`📊 Gönderim: ${basarili}/${grupIdler.length}`);
    res.json({ sonuclar, basarili, toplam: grupIdler.length });
});

app.post('/yukle', upload.single('dosya'), (req, res) => {
    if (!req.file) return res.status(400).json({ hata: 'Dosya bulunamadı' });
    const orijinalAd = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const uzanti     = path.extname(orijinalAd);
    const yeniAd     = req.file.filename + uzanti;
    fs.renameSync(req.file.path, path.join(uploadsDir, yeniAd));
    console.log(`📁 Yüklendi: ${orijinalAd}`);
    res.json({ url: `${SUNUCU_URL}/uploads/${yeniAd}`, ad: orijinalAd });
});

app.listen(PORT, () => console.log(`\n🚀 Sunucu hazır → ${SUNUCU_URL}\n`));

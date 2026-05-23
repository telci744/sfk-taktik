const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express  = require('express');
const cors     = require('cors');
const qrcode   = require('qrcode');
const path     = require('path');
const fs       = require('fs');
const pino     = require('pino');
const webpush  = require('web-push');

const PORT             = process.env.PORT || 3001;
const FIREBASE_PROJECT = 'sfk-taktik';
const FIREBASE_API_KEY = 'AIzaSyD_zEbZek8IyacdHojnBpb4cWTIvBSdOtk';
const FS_BASE          = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

const VAPID_PUBLIC  = 'BMf7FqKbLe6QrIL7PonKODsM7DgGRoANWRgNS41PwWsGPFsDffL8Mq-siQUlYtv0RbJwr88VrD2CuySkMLhBkDs';
const VAPID_PRIVATE = 'EJmg0lOVdbhdXIb7Vu1fiwfvTCxPKZRgglCQleBGUKA';
webpush.setVapidDetails('mailto:sfk@mavikonak.app', VAPID_PUBLIC, VAPID_PRIVATE);

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname, { index: 'index.html' }));

const authDir = path.join(__dirname, 'auth_info');
if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

// ── Firestore REST yardımcıları ────────────────────────────────

function toFS(val) {
    if (val === null || val === undefined) return { nullValue: null };
    if (typeof val === 'boolean')          return { booleanValue: val };
    if (typeof val === 'number')           return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
    if (typeof val === 'string')           return { stringValue: val };
    if (Array.isArray(val))                return { arrayValue: { values: val.map(toFS) } };
    if (typeof val === 'object')           return { mapValue: { fields: objToFields(val) } };
    return { stringValue: String(val) };
}

function objToFields(obj) {
    const f = {};
    for (const [k, v] of Object.entries(obj)) f[k] = toFS(v);
    return f;
}

function fromFS(val) {
    if (!val) return null;
    if ('nullValue'    in val) return null;
    if ('booleanValue' in val) return val.booleanValue;
    if ('integerValue' in val) return Number(val.integerValue);
    if ('doubleValue'  in val) return val.doubleValue;
    if ('stringValue'  in val) return val.stringValue;
    if ('arrayValue'   in val) return (val.arrayValue.values || []).map(fromFS);
    if ('mapValue'     in val) return fieldsToObj(val.mapValue.fields || {});
    return null;
}

function fieldsToObj(fields) {
    const obj = {};
    for (const [k, v] of Object.entries(fields)) obj[k] = fromFS(v);
    return obj;
}

async function fsSet(col, doc, data) {
    const r = await fetch(`${FS_BASE}/${col}/${doc}?key=${FIREBASE_API_KEY}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: objToFields(data) })
    });
    if (!r.ok) throw new Error(await r.text());
}

async function fsUpdate(col, doc, data) {
    const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    const r = await fetch(`${FS_BASE}/${col}/${doc}?key=${FIREBASE_API_KEY}&${mask}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: objToFields(data) })
    });
    if (!r.ok) throw new Error(await r.text());
}

async function fsGet(col, doc) {
    const r = await fetch(`${FS_BASE}/${col}/${doc}?key=${FIREBASE_API_KEY}`);
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    return fieldsToObj(data.fields || {});
}

async function fsAdd(col, data) {
    const r = await fetch(`${FS_BASE}/${col}?key=${FIREBASE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: objToFields(data) })
    });
    if (!r.ok) throw new Error(await r.text());
}

async function fsQueryAll(col, field, op, value) {
    const fsVal = typeof value === 'boolean' ? { booleanValue: value } : { stringValue: value };
    const r = await fetch(`${FS_BASE}:runQuery?key=${FIREBASE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            structuredQuery: {
                from: [{ collectionId: col }],
                where: { fieldFilter: { field: { fieldPath: field }, op, value: fsVal } }
            }
        })
    });
    if (!r.ok) throw new Error(await r.text());
    const rows = await r.json();
    return rows
        .filter(x => x.document)
        .map(x => ({ _id: x.document.name.split('/').pop(), ...fieldsToObj(x.document.fields) }));
}

async function fsDelete(col, doc) {
    await fetch(`${FS_BASE}/${col}/${doc}?key=${FIREBASE_API_KEY}`, { method: 'DELETE' });
}

// ── Web Push bildirimleri ─────────────────────────────────────
async function bildirimGonder(baslik, mesaj) {
    try {
        const ayarlar = await fsGet('ayarlar', 'push');
        if (!ayarlar?.endpoint) return;
        const sub = { endpoint: ayarlar.endpoint, keys: { p256dh: ayarlar.p256dh, auth: ayarlar.auth } };
        await webpush.sendNotification(sub, JSON.stringify({ baslik, mesaj }));
        console.log(`🔔 Bildirim: ${baslik}`);
    } catch(e) {
        if (!e.message?.includes('410') && !e.message?.includes('404')) {
            console.error('Bildirim hatası:', e.message);
        }
    }
}

// Günlük istatistik sayacı
let gunStats = { gun: '', gonderilenler: 0, hatalar: 0 };
function gunIstatistikGuncelle(basarili, hatali) {
    const bugun = new Date().toISOString().split('T')[0];
    if (gunStats.gun !== bugun) gunStats = { gun: bugun, gonderilenler: 0, hatalar: 0 };
    gunStats.gonderilenler += basarili;
    gunStats.hatalar       += hatali;
}

async function dosyaBufferOku(dosyaId) {
    const meta = await fsGet('dosyalar', dosyaId);
    const parcaSayisi = meta.parcaSayisi || 1;
    const buffers = [];
    for (let i = 0; i < parcaSayisi; i++) {
        const parca = await fsGet(`dosyalar/${dosyaId}/parcalar`, String(i));
        buffers.push(Buffer.from(parca.data, 'base64'));
    }
    return { buffer: Buffer.concat(buffers), mime: meta.mime, ad: meta.ad };
}

async function fsQuery(col, field, op, value) {
    const fsVal = typeof value === 'boolean' ? { booleanValue: value } : { stringValue: value };
    const r = await fetch(`${FS_BASE}:runQuery?key=${FIREBASE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            structuredQuery: {
                from: [{ collectionId: col }],
                where: { fieldFilter: { field: { fieldPath: field }, op, value: fsVal } },
                limit: 5
            }
        })
    });
    if (!r.ok) throw new Error(await r.text());
    const rows = await r.json();
    return rows
        .filter(x => x.document)
        .map(x => ({ _id: x.document.name.split('/').pop(), ...fieldsToObj(x.document.fields) }));
}

// ── WhatsApp ───────────────────────────────────────────────────

let hazir = false;
let sock  = null;

async function baslat() {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version }          = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth:   state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal:            false,
        browser:                      ['Ubuntu', 'Chrome', '22.04'],
        generateHighQualityLinkPreview: false,
        connectTimeoutMs:             30000,
        keepAliveIntervalMs:          10000
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrData = await qrcode.toDataURL(qr);
            hazir = false;
            fsUpdate('durum', 'whatsapp', { hazir: false, qr: qrData, ts: Date.now() }).catch(() => {});
            console.log('📱 QR kodu oluşturuldu');
        }

        if (connection === 'close') {
            hazir = false;
            const statusCode   = lastDisconnect?.error?.output?.statusCode;
            const cikisYapildi = statusCode === DisconnectReason.loggedOut;
            console.log('🔴 Bağlantı kesildi:', statusCode);
            fsUpdate('durum', 'whatsapp', { hazir: false, qr: null, ts: Date.now() }).catch(() => {});
            bildirimGonder('⚠️ WhatsApp Bağlantısı Koptu', 'Mavikonak sunucusu WhatsApp\'tan ayrıldı. Kontrol edin.').catch(() => {});
            if (statusCode === 405) {
                fs.rmSync(authDir, { recursive: true, force: true });
                fs.mkdirSync(authDir, { recursive: true });
                console.log('🔄 Auth temizlendi');
            }
            if (!cikisYapildi) setTimeout(baslat, 5000);
            else baslat();
        }

        if (connection === 'open') {
            hazir = true;
            fsUpdate('durum', 'whatsapp', { hazir: true, qr: null, ts: Date.now() }).catch(() => {});
            console.log('🟢 WhatsApp bağlandı!');
            gruplarYaz().catch(() => {});
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

async function gruplarYaz() {
    const veri    = await sock.groupFetchAllParticipating();
    const gruplar = Object.values(veri)
        .map(g => ({ id: g.id, ad: g.subject, uyeSayisi: g.participants?.length || 0 }))
        .sort((a, b) => a.ad.localeCompare(b.ad, 'tr'));
    await fsSet('gruplar', 'liste', { items: gruplar, ts: Date.now() });
    console.log(`📋 ${gruplar.length} grup Firestore'a yazıldı`);
}

// ── İş kuyruğu ────────────────────────────────────────────────

let isleniyor = false;

async function isKontrol() {
    if (!hazir || isleniyor) return;

    let isler;
    try {
        isler = await fsQuery('isler', 'durum', 'EQUAL', 'bekliyor');
    } catch { return; }

    for (const is of isler) {
        // Grupları yenile isteği
        if (is.tur === 'gruplar_yenile') {
            await fsDelete('isler', is._id);
            gruplarYaz().catch(() => {});
            continue;
        }

        // Mesaj gönderme işi
        if (is.tur !== 'gonder') continue;

        isleniyor = true;
        try {
            await fsUpdate('isler', is._id, { durum: 'isleniyor' });

            const { grupIdler, mesaj, dosyaId, dosyaAdi } = is;
            const sonuclar = [];

            // Dosya varsa tek seferinde oku
            let dosyaBilgi = null;
            if (dosyaId) {
                dosyaBilgi = await dosyaBufferOku(dosyaId);
                console.log(`📎 Dosya okundu: ${dosyaBilgi.ad} (${dosyaBilgi.buffer.length} byte)`);
            }

            for (let i = 0; i < grupIdler.length; i++) {
                const grupId = grupIdler[i];
                try {
                    if (dosyaBilgi) {
                        const { buffer, mime, ad } = dosyaBilgi;
                        const mimeType = mime || 'application/octet-stream';
                        const goruntulAd = dosyaAdi || ad || 'dosya';

                        const icerik = mimeType.startsWith('image/')
                            ? { image: buffer, caption: mesaj || '', mimetype: mimeType }
                            : { document: buffer, mimetype: mimeType, fileName: goruntulAd, caption: mesaj || '' };

                        await sock.sendMessage(grupId, icerik);
                    } else {
                        await sock.sendMessage(grupId, { text: mesaj });
                    }
                    sonuclar.push({ grupId, basari: true });
                    console.log(`  ✅ → ${grupId}`);
                } catch (e) {
                    sonuclar.push({ grupId, basari: false, hata: e.message });
                    console.log(`  ❌ (${grupId}):`, e.message);
                }

                await fsUpdate('isler', is._id, { ilerleme: i + 1 }).catch(() => {});

                if (i < grupIdler.length - 1) await new Promise(r => setTimeout(r, 4000));
            }

            const basarili = sonuclar.filter(s => s.basari).length;
            const hatali   = grupIdler.length - basarili;
            console.log(`📊 ${basarili}/${grupIdler.length}`);
            await fsUpdate('isler', is._id, { durum: 'tamamlandi', basarili, toplam: grupIdler.length });
            if (basarili > 0 && is.animsaticiId) {
                await fsUpdate('animsaticilar', is.animsaticiId, { tamamlandi: true }).catch(() => {});
            }
            gunIstatistikGuncelle(basarili, hatali);
            if (basarili > 0 && hatali === 0) {
                bildirimGonder('✅ Gönderim Tamamlandı', `${basarili} gruba başarıyla gönderildi.`).catch(() => {});
            } else if (basarili > 0) {
                bildirimGonder('⚠️ Kısmi Gönderim', `${basarili} başarılı, ${hatali} başarısız.`).catch(() => {});
            } else {
                bildirimGonder('❌ Gönderim Başarısız', `${grupIdler.length} gruptan hiçbirine gönderilemedi.`).catch(() => {});
            }
        } catch (e) {
            console.error('İş hatası:', e.message);
            await fsUpdate('isler', is._id, { durum: 'hata', hata: e.message }).catch(() => {});
        } finally {
            isleniyor = false;
        }
    }
}

setInterval(isKontrol, 3000);

// ── Zamanlı gönderim ──────────────────────────────────────────
async function zamanlıGonderimKontrol() {
    if (!hazir) return;
    try {
        const adaylar = await fsQueryAll('animsaticilar', 'otomatikGonder', 'EQUAL', true);
        const simdi   = new Date();

        for (const item of adaylar) {
            if (item.tamamlandi || item.otomatikGonderildi) continue;
            if (!item.tarih || !item.otomatikGruplar?.length) continue;

            const zamanStr    = `${item.tarih}T${item.saat || '00:00'}:00`;
            const zamanlanmis = new Date(zamanStr);
            if (zamanlanmis > simdi) continue;

            console.log(`⏰ Zamanlı gönderim başlıyor: ${item.baslik}`);
            await fsUpdate('animsaticilar', item._id, { otomatikGonderildi: true });
            await fsAdd('isler', {
                tur:          'gonder',
                grupIdler:    item.otomatikGruplar,
                mesaj:        item.mesaj || item.baslik,
                dosyaId:      item.dosyaId  || null,
                dosyaAdi:     item.dosyaAdi || null,
                durum:        'bekliyor',
                ilerleme:     0,
                toplam:       item.otomatikGruplar.length,
                animsaticiId: item._id
            });
        }
    } catch(e) {
        if (!e.message?.includes('DOCUMENT_NOT_FOUND')) {
            console.error('Zamanlı kontrol hatası:', e.message);
        }
    }
}

setInterval(zamanlıGonderimKontrol, 30000);

// ── Mavikent v2 Realtime DB ────────────────────────────────────
const MAVIKENT_APIKEY = 'AIzaSyDb2IuKMeXHNvhqL8GLiaY_4GYF60dv81A';
const MAVIKENT_RTDB   = 'https://mavikent-aa820-default-rtdb.firebaseio.com';
let _mavikentToken    = null;
let _mavikentTokenExp = 0;

async function mavikentAnon() {
    if (_mavikentToken && Date.now() < _mavikentTokenExp) return _mavikentToken;
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInAnonymously?key=${MAVIKENT_APIKEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true })
    });
    const d = await r.json();
    if (!d.idToken) throw new Error('Mavikent anonim giriş başarısız: ' + JSON.stringify(d));
    _mavikentToken    = d.idToken;
    _mavikentTokenExp = Date.now() + (Number(d.expiresIn) - 120) * 1000;
    return _mavikentToken;
}

async function mavikentRtdb(path) {
    const token       = await mavikentAnon();
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const r = await fetch(`${MAVIKENT_RTDB}/mavikent_premium/${encodedPath}.json?auth=${token}`);
    if (!r.ok) throw new Error(`Mavikent RTDB ${r.status}: ${await r.text()}`);
    return r.json();
}

// ── Yoklama raporu (22:30 otomatik) ────────────────────────────
let yoklamaGonderildiGun = '';

async function yoklamaRaporuGonder() {
    try {
        const ayarlar = await fsGet('yoklama_ayarlari', 'ayarlar').catch(() => null);
        if (!ayarlar?.aktif) return;
        const sinifGruplar = ayarlar.siniflar || {};
        if (!Object.values(sinifGruplar).some(Boolean)) return;

        const todayStr = new Date().toDateString();
        console.log(`📋 Yoklama raporu başlıyor — ${todayStr}`);

        const [rosterRaw, studentClasses, yoklamaData] = await Promise.all([
            mavikentRtdb('roster'),
            mavikentRtdb('student_classes'),
            mavikentRtdb(`yoklama_d/${todayStr}`)
        ]);

        const roster = Array.isArray(rosterRaw)
            ? rosterRaw.filter(Boolean)
            : Object.values(rosterRaw || {}).filter(Boolean);
        if (!roster.length) { console.log('Yoklama: roster boş'); return; }

        // Sınıflara göre grupla
        const siniflar = {};
        for (const ogrenci of roster) {
            const sinif = studentClasses?.[ogrenci];
            if (!sinif || !sinifGruplar[sinif]) continue;
            if (!siniflar[sinif]) siniflar[sinif] = [];
            siniflar[sinif].push(ogrenci);
        }

        const tarihStr = new Date().toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });

        for (const [sinif, ogrenciler] of Object.entries(siniflar)) {
            const grupId = sinifGruplar[sinif];
            if (!grupId || !hazir) continue;

            ogrenciler.sort((a, b) => a.localeCompare(b, 'tr'));
            const satirlar = [];
            let geldi = 0, gec = 0, gelmedi = 0, kayitYok = 0;

            for (const ogrenci of ogrenciler) {
                const sessions = yoklamaData?.[ogrenci]?.sessions || {};
                const stList   = Object.values(sessions).map(s => s?.st).filter(Boolean);
                let durum = null;
                if (stList.includes('t'))      durum = 't';
                else if (stList.includes('p')) durum = 'p';
                else if (stList.includes('l')) durum = 'l';
                else if (stList.includes('a')) durum = 'a';

                if (durum === 't' || durum === 'p') { satirlar.push(`✅ ${ogrenci}`); geldi++; }
                else if (durum === 'l')              { satirlar.push(`⏰ ${ogrenci} (geç)`); gec++; }
                else if (durum === 'a')              { satirlar.push(`❌ ${ogrenci}`); gelmedi++; }
                else                                 { satirlar.push(`➖ ${ogrenci}`); kayitYok++; }
            }

            const ozetParcalar = [`✅ ${geldi} geldi`];
            if (gec > 0)       ozetParcalar.push(`⏰ ${gec} geç`);
            ozetParcalar.push(`❌ ${gelmedi} gelmedi`);
            if (kayitYok > 0)  ozetParcalar.push(`➖ ${kayitYok} kayıt yok`);

            const mesaj = `📋 *${sinif} — Akşam Yoklaması*\n📅 ${tarihStr}\n\n${satirlar.join('\n')}\n\n${'─'.repeat(16)}\n${ozetParcalar.join('  |  ')}\nToplam: ${ogrenciler.length} öğrenci`;

            await sock.sendMessage(grupId, { text: mesaj });
            console.log(`  ✅ ${sinif} → ${geldi} geldi, ${gelmedi} gelmedi, ${kayitYok} kayıtsız`);
            if (ogrenciler !== Object.values(siniflar).at(-1)) await new Promise(r => setTimeout(r, 3000));
        }

        const sinifSayisi = Object.keys(siniflar).length;
        bildirimGonder('📋 Yoklama Gönderildi', `${sinifSayisi} sınıfın akşam yoklaması velilere iletildi.`).catch(() => {});
    } catch(e) {
        console.error('Yoklama raporu hatası:', e.message);
        bildirimGonder('❌ Yoklama Hatası', e.message).catch(() => {});
    }
}

// ── 23:00 Günlük özet & 22:30 Yoklama ────────────────────────
let ozetGonderildiGun = '';
setInterval(() => {
    const simdi  = new Date();
    const bugun  = simdi.toISOString().split('T')[0];
    const sa     = simdi.getHours();
    const dk     = simdi.getMinutes();

    if (sa === 22 && dk === 30 && yoklamaGonderildiGun !== bugun) {
        yoklamaGonderildiGun = bugun;
        yoklamaRaporuGonder().catch(e => console.error('Yoklama tetikleme hatası:', e.message));
    }

    if (sa === 23 && dk < 1 && ozetGonderildiGun !== bugun) {
        ozetGonderildiGun = bugun;
        const { gonderilenler, hatalar } = gunStats;
        const mesaj = gonderilenler > 0
            ? `Bugün ${gonderilenler} mesaj gönderildi${hatalar > 0 ? `, ${hatalar} hata oluştu` : ''}.`
            : 'Bugün hiç mesaj gönderilmedi.';
        bildirimGonder('📊 Günlük Özet', mesaj).catch(() => {});
    }
}, 30000);

console.log('⏳ WhatsApp başlatılıyor...');
baslat().catch(console.error);

app.listen(PORT, () => console.log(`\n🚀 Sunucu hazır → http://localhost:${PORT}\n`));

import webpush from 'web-push';

const FIREBASE_PROJECT = 'sfk-taktik';
const FIREBASE_API_KEY = 'AIzaSyD_zEbZek8IyacdHojnBpb4cWTIvBSdOtk';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

webpush.setVapidDetails(
    'mailto:sfk@mavikonak.app',
    process.env.VAPID_PUBLIC,
    process.env.VAPID_PRIVATE
);

function sinifTuru(sinifNo) {
    const n = parseInt(sinifNo);
    if (!n) return 'yatili';
    if (n <= 3) return 'kucuk';
    if (n === 4) return 'nehari';
    return 'yatili';
}

async function firestoreAbonelikler() {
    const url = `${FS_BASE}/abonelikler?key=${FIREBASE_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    if (!data.documents) return [];
    return data.documents.map(doc => {
        const f = doc.fields || {};
        return {
            _id:      doc.name.split('/').pop(),
            endpoint: f.endpoint?.stringValue,
            p256dh:   f.p256dh?.stringValue,
            auth:     f.auth?.stringValue,
        };
    }).filter(a => a.endpoint);
}

async function firestoreDeleteAbonelik(id) {
    await fetch(`${FS_BASE}/abonelikler/${id}?key=${FIREBASE_API_KEY}`, { method: 'DELETE' });
}

async function badgeArttir(tur) {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:commit?key=${FIREBASE_API_KEY}`;
    const docPath = `projects/${FIREBASE_PROJECT}/databases/(default)/documents/sistem/potansiyel_badges`;
    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            writes: [{
                transform: {
                    document: docPath,
                    fieldTransforms: [{
                        fieldPath: tur,
                        increment: { integerValue: '1' }
                    }]
                }
            }]
        })
    });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ ok: false });

    const { ad_soyad, sinif, okul, veli_ad, telefon } = req.body || {};
    if (!ad_soyad) return res.status(400).json({ ok: false, hata: 'ad_soyad gerekli' });

    const tur = sinifTuru(sinif);

    const satirlar = [
        sinif   ? `${sinif}. Sınıf` : null,
        okul    || null,
        veli_ad ? `Veli: ${veli_ad}` : null,
        telefon || null,
    ].filter(Boolean).join(' · ');

    const payload = JSON.stringify({
        baslik: '📋 Yeni Potansiyel Başvuru',
        mesaj:  ad_soyad + (satirlar ? '\n' + satirlar : ''),
    });

    await Promise.all([
        // Push bildirimi gönder
        firestoreAbonelikler().then(abonelikler =>
            Promise.all(abonelikler.map(async a => {
                const sub = { endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } };
                try {
                    await webpush.sendNotification(sub, payload);
                } catch(e) {
                    if (e.statusCode === 410 || e.statusCode === 404) {
                        await firestoreDeleteAbonelik(a._id);
                    }
                }
            }))
        ),
        // Badge sayacını artır
        badgeArttir(tur),
    ]);

    res.json({ ok: true, tur });
}

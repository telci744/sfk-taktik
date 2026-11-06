# Firebase ve Vercel bağlantı bilgileri

Eski Mavikonak uygulaması kaldırıldı (6 Kasım 2026). Yeni bir uygulama kurarken bu bilgileri kullan.

## Firebase (proje: sfk-taktik)

Web uygulaması ayarları:

```js
const firebaseConfig = {
    apiKey: "AIzaSyD_zEbZek8IyacdHojnBpb4cWTIvBSdOtk",
    authDomain: "sfk-taktik.firebaseapp.com",
    projectId: "sfk-taktik",
    storageBucket: "sfk-taktik.firebasestorage.app",
    messagingSenderId: "773612917206",
    appId: "1:773612917206:web:6c21289cc1fc179c5a9477"
};
```

Firestore REST adresi:
`https://firestore.googleapis.com/v1/projects/sfk-taktik/databases/(default)/documents`

## Vercel

- Hesap: telci744 (ekip: telci744s-projects)
- Eski `mavikonak` projesi silindi. Yeni proje için klasörde `vercel` komutunu çalıştır.
- Push bildirimi için gereken `VAPID_PUBLIC` ve `VAPID_PRIVATE` anahtarları `.env` dosyasında duruyor (git'e gönderilmez). Yeni Vercel projesine `vercel env add` ile ekle.

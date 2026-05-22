self.addEventListener('push', e => {
    const veri = e.data?.json() || {};
    e.waitUntil(
        self.registration.showNotification(veri.baslik || 'Mavikonak', {
            body:    veri.mesaj || '',
            icon:    '/icon-192.png',
            badge:   '/icon-192.png',
            tag:     'mavikonak',
            renotify: true,
            vibrate: [200, 100, 200]
        })
    );
});

self.addEventListener('notificationclick', e => {
    e.notification.close();
    e.waitUntil(clients.openWindow('/'));
});

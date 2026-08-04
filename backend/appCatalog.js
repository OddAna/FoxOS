const DASHBOARD_ICON_BASE = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/';

const APP_CATALOG = Object.freeze([
  Object.freeze({
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    publisher: 'Louis Lam',
    category: 'Monitoring',
    summary: 'Servislerinizi ve web sitelerinizi tek ekrandan izleyin.',
    description: 'Kendi sunucunuzda çalışan açık kaynaklı uptime takip ve bildirim paneli.',
    image: 'louislam/uptime-kuma:2',
    containerPort: 3001,
    defaultPort: 3001,
    accent: '#62e6a7',
    icon: 'activity',
    logoUrl: DASHBOARD_ICON_BASE + 'uptime-kuma.svg',
    docsUrl: 'https://github.com/louislam/uptime-kuma',
    volumes: Object.freeze([
      Object.freeze({ name: 'foxos-app-uptime-kuma-data', target: '/app/data' })
    ]),
    binds: Object.freeze([]),
    environment: Object.freeze([]),
    notes: Object.freeze(['İzleme geçmişi ve ayarlar kalıcı volume içinde tutulur.'])
  }),
  Object.freeze({
    id: 'dozzle',
    name: 'Dozzle',
    publisher: 'Amir 20',
    category: 'Docker',
    summary: 'Docker container loglarını canlı ve hızlı biçimde inceleyin.',
    description: 'Sunucudaki container loglarını arama ve canlı akış desteğiyle gösteren hafif arayüz.',
    image: 'amir20/dozzle:latest',
    containerPort: 8080,
    defaultPort: 8082,
    accent: '#8ba9ff',
    icon: 'logs',
    logoUrl: DASHBOARD_ICON_BASE + 'dozzle.svg',
    docsUrl: 'https://github.com/amir20/dozzle',
    volumes: Object.freeze([]),
    binds: Object.freeze(['/var/run/docker.sock:/var/run/docker.sock:ro']),
    environment: Object.freeze([]),
    risk: 'Dozzle, container bilgilerini ve loglarını okuyabilmek için Docker socket erişimi kullanır.',
    notes: Object.freeze(['Docker socket salt okunur olarak bağlanır.'])
  }),
  Object.freeze({
    id: 'it-tools',
    name: 'IT-Tools',
    publisher: 'Corentin Thomasset',
    category: 'Utilities',
    summary: 'Geliştirici ve sistem yöneticisi araçlarını tek panelde kullanın.',
    description: 'Kodlayıcılar, dönüştürücüler, ağ yardımcıları ve günlük işler için web tabanlı araç kutusu.',
    image: 'corentinth/it-tools:latest',
    containerPort: 80,
    defaultPort: 8083,
    accent: '#ffbd66',
    icon: 'tools',
    logoUrl: DASHBOARD_ICON_BASE + 'it-tools.svg',
    docsUrl: 'https://github.com/CorentinTh/it-tools',
    volumes: Object.freeze([]),
    binds: Object.freeze([]),
    environment: Object.freeze([]),
    notes: Object.freeze(['Sunucu üzerinde kalıcı veri oluşturmaz.'])
  }),
  Object.freeze({
    id: 'stirling-pdf',
    name: 'Stirling PDF',
    publisher: 'Stirling Tools',
    category: 'Documents',
    summary: 'PDF dosyalarını sunucunuzda birleştirin, dönüştürün ve düzenleyin.',
    description: 'Dosyaları üçüncü taraf bir buluta göndermeden çok sayıda PDF işlemi sunan araç seti.',
    image: 'docker.stirlingpdf.com/stirlingtools/stirling-pdf:latest',
    containerPort: 8080,
    defaultPort: 8084,
    accent: '#ff7a90',
    icon: 'document',
    logoUrl: DASHBOARD_ICON_BASE + 'stirling-pdf.svg',
    docsUrl: 'https://github.com/Stirling-Tools/Stirling-PDF',
    volumes: Object.freeze([]),
    binds: Object.freeze([]),
    environment: Object.freeze([]),
    notes: Object.freeze(['İlk imaj indirmesi diğer uygulamalardan daha uzun sürebilir.'])
  })
]);

function getCatalogApp(appId) {
  return APP_CATALOG.find((catalogApp) => catalogApp.id === appId) || null;
}

module.exports = { APP_CATALOG, getCatalogApp };

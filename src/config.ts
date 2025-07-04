const config = {
  isDevelopment: import.meta.env.DEV,
  requireConsent: import.meta.env.VITE_TARGET_BROWSER === 'firefox',
  assetsonarServer: {
    protocol: import.meta.env.DEV ? 'http' : 'https',
    host: import.meta.env.DEV ? 'lvh.me:3000' : 'assetsonar.com',
  },
  heartbeat: {
    alarmName: 'heartbeat',
    intervalInSeconds: 60,
  },
  blockedDomains: {
    alarmName: 'blockedDomains',
    intervalInSeconds: 1800,
  },
}

export default config

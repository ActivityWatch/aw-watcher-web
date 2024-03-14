const config = {
  isDevelopment: import.meta.env.DEV,
  requireConsent: import.meta.env.VITE_TARGET_BROWSER === 'firefox',
  heartbeat: {
    alarmName: 'heartbeat',
    intervalInSeconds: 60,
  },
}

export default config

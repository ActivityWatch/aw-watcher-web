import browser from 'webextension-polyfill'
import { setConsentStatus, setEnabled } from '../storage'

const consentRefused = document.getElementById('consent-refused')!
consentRefused.addEventListener('click', () => {
  // Conditionally uninstall if not Safari
  if (import.meta.env.VITE_TARGET_BROWSER !== 'safari') {
    browser.management.uninstallSelf()
  }
  window.close()
})

const consentGiven = document.getElementById('consent-given')!
consentGiven.addEventListener('click', async () => {
  await setConsentStatus({ consent: true, required: true })
  await setEnabled(true)
  window.close()
})

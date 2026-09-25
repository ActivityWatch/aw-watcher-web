import browser from 'webextension-polyfill'
import config from '../config'

export async function getIsConsentRequired() {
  if (!config.requireConsent) return false
  return browser.storage.managed
    .get('consentOfflineDataCollection')
    .then(
      ({ consentOfflineDataCollection }) =>
        consentOfflineDataCollection !== true,
    )
    .catch(() => true)
}

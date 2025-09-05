import { IEvent } from 'aw-client'
import browser from 'webextension-polyfill'

function watchKey<T>(key: string, cb: (value: T) => void | Promise<void>) {
  const listener = (
    changes: browser.Storage.StorageAreaOnChangedChangesType,
  ) => {
    if (!(key in changes)) return
    cb(changes[key].newValue as T)
  }
  browser.storage.local.onChanged.addListener(listener)
  return () => browser.storage.local.onChanged.removeListener(listener)
}

async function waitForKey<T>(key: string, desiredValue: T) {
  const value = await browser.storage.local.get(key).then((_) => _[key])
  if (value === desiredValue) return
  return new Promise<void>((resolve) => {
    const unsubscribe = watchKey<T>(key, (value) => {
      if (value !== desiredValue) return
      resolve()
      unsubscribe()
    })
  })
}

type SyncStatus = { success?: boolean; date?: string }
export const getSyncStatus = (): Promise<SyncStatus> =>
  browser.storage.local
    .get(['lastSyncSuccess', 'lastSync'])
    .then(({ lastSyncSuccess, lastSync }) => ({
      success:
        lastSyncSuccess === undefined
          ? lastSyncSuccess
          : Boolean(lastSyncSuccess),
      date: lastSync === undefined ? lastSync : String(lastSync),
    }))
export const setSyncStatus = (lastSyncSuccess: boolean) =>
  browser.storage.local.set({
    lastSyncSuccess,
    lastSync: new Date().toISOString(),
  })
export const watchSyncSuccess = (
  cb: (success: boolean | undefined) => void | Promise<void>,
) => watchKey('lastSyncSuccess', cb)
export const watchSyncDate = (
  cb: (date: string | undefined) => void | Promise<void>,
) => watchKey('lastSync', cb)

type ConsentStatus = { consent?: boolean; required?: boolean }
export const getConsentStatus = async (): Promise<ConsentStatus> =>
  browser.storage.local
    .get(['consentRequired', 'consent'])
    .then(({ consent, consentRequired }) => ({
      consent: typeof consent === 'boolean' ? consent : undefined,
      required:
        typeof consentRequired === 'boolean' ? consentRequired : undefined,
    }))
export const setConsentStatus = async (status: ConsentStatus): Promise<void> =>
  browser.storage.local.set({
    consentRequired: status.required,
    consent: status.consent,
  })

type Enabled = boolean
export const waitForEnabled = () => waitForKey('enabled', true)
export const getEnabled = (): Promise<Enabled> =>
  browser.storage.local.get('enabled').then((_) => Boolean(_.enabled))
export const setEnabled = (enabled: Enabled) =>
  browser.storage.local.set({ enabled })

type BaseUrl = string
export const getBaseUrl = (): Promise<BaseUrl | undefined> =>
  browser.storage.local
    .get('baseUrl')
    .then((_) => _.baseUrl as string | undefined)
export const setBaseUrl = (baseUrl: BaseUrl) =>
  browser.storage.local.set({ baseUrl })

type HeartbeatData = IEvent['data']
export const getHeartbeatData = (): Promise<HeartbeatData | undefined> =>
  browser.storage.local
    .get('heartbeatData')
    .then((_) => _.heartbeatData as HeartbeatData | undefined)
export const setHeartbeatData = (heartbeatData: HeartbeatData) =>
  browser.storage.local.set({ heartbeatData })

type BrowserName = string
type StorageData = { [key: string]: any }
export const getBrowserName = (): Promise<BrowserName | undefined> =>
  browser.storage.local
    .get('browserName')
    .then((data: StorageData) => data.browserName as string | undefined)
export const setBrowserName = (browserName: BrowserName) =>
  browser.storage.local.set({ browserName })

type Hostname = string
export const getHostname = (): Promise<Hostname | undefined> =>
  browser.storage.local
    .get('hostname')
    .then((data: StorageData) => data.hostname as string | undefined)
export const setHostname = (hostname: Hostname) =>
  browser.storage.local.set({ hostname })

type ProfileIdentifier = string
export const getProfileIdentifier = (): Promise<ProfileIdentifier | undefined> =>
  browser.storage.local
    .get('profileIdentifier')
    .then((data: StorageData) => data.profileIdentifier as string | undefined)

export const setProfileIdentifier = (profileIdentifier: ProfileIdentifier) =>
  browser.storage.local.set({ profileIdentifier })

export const generateProfileIdentifier = async (): Promise<ProfileIdentifier> => {
  const existing = await getProfileIdentifier()
  if (existing) {
    return existing
  }
  
  // Generate a unique identifier for this profile/installation
  const profileId = crypto.randomUUID()
  await setProfileIdentifier(profileId)
  return profileId
}

type CustomProfileName = string
export const getCustomProfileName = (): Promise<CustomProfileName | undefined> =>
  browser.storage.local
    .get('customProfileName')
    .then((data: StorageData) => data.customProfileName as string | undefined)

export const setCustomProfileName = (customProfileName: CustomProfileName) => {
  if (customProfileName.trim() === '') {
    // Remove custom profile name if empty string is provided
    return browser.storage.local.remove('customProfileName')
  }
  return browser.storage.local.set({ customProfileName })
}

export const getDisplayProfileName = async (): Promise<string> => {
  const customName = await getCustomProfileName()
  if (customName) {
    return customName
  }
  
  // Fallback to a shortened version of the unique identifier
  const profileId = await generateProfileIdentifier()
  return `Profile-${profileId.slice(0, 8)}`
}

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

type Domain = { id: string, domain: string, matchType: string }
export const getDomains = (): Promise<Domain[] | undefined> =>
  browser.storage.local
    .get('domains')
    .then((data: StorageData) => {
      const domains = data.domains as Domain[] | undefined
      if (!Array.isArray(domains)) return undefined
      return domains.map(domain => ({
        id: domain.id as string,
        domain: domain.domain as string,
        matchType: domain.matchType as string
      }))
    })

export const setDomains = (domains: Domain[]): Promise<void> =>
  browser.storage.local.set({ domains })

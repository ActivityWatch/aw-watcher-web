/**
 * Opens the extension settings page from the popup.
 *
 * Some Chromium-based browsers (e.g. Arc and Dia) do not reliably support
 * `runtime.openOptionsPage()`. When the API is missing or rejects, fall back to
 * opening the settings page in a new tab.
 */

export const SETTINGS_PAGE_PATH = 'src/settings/index.html'

export interface OpenSettingsApi {
  openOptionsPage?: () => Promise<void>
  getURL: (path: string) => string
  createTab: (properties: { active: boolean; url: string }) => Promise<unknown>
}

export async function openSettingsPage(api: OpenSettingsApi): Promise<void> {
  if (typeof api.openOptionsPage === 'function') {
    try {
      await api.openOptionsPage()
      return
    } catch (error) {
      console.warn('openOptionsPage failed, opening settings in a tab:', error)
    }
  }
  await api.createTab({ active: true, url: api.getURL(SETTINGS_PAGE_PATH) })
}

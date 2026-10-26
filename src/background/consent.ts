/**
 * Firefox managed-storage consent gate.
 *
 * `browser.storage.managed.get('consentOfflineDataCollection')` resolves to an
 * object keyed by the requested policy names, not to the property value. The
 * install gate must therefore read the named boolean explicitly: an empty
 * object, a false value, a malformed value, or a rejected read all mean the
 * enterprise policy has not granted consent.
 */

export type ManagedConsentResult = Record<string, unknown> | null | undefined

/** True only when managed policy explicitly sets the consent boolean to true. */
export function isManagedConsentGranted(
  managed: ManagedConsentResult,
): boolean {
  if (managed === null || typeof managed !== 'object') return false
  return managed.consentOfflineDataCollection === true
}

/**
 * Resolve whether consent is required before enabling collection.
 *
 * Chromium builds do not require consent (`requireConsent` is false). On
 * Firefox, a failed or malformed managed read keeps consent required.
 */
export async function getIsConsentRequired(
  requireConsent: boolean,
  readManaged: () => Promise<ManagedConsentResult>,
): Promise<boolean> {
  if (!requireConsent) return false
  try {
    return !isManagedConsentGranted(await readManaged())
  } catch {
    return true
  }
}

export type InstallAction = 'enable' | 'show-consent'

/** Decide what the install listener does: enable collection or show consent. */
export function installAction(
  isConsentRequired: boolean,
  consent: boolean | undefined,
): InstallAction {
  return !isConsentRequired || consent === true ? 'enable' : 'show-consent'
}

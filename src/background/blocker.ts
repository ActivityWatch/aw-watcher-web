import browser from 'webextension-polyfill'
import config from '../config'
import { assetsonarServerUrl } from './helpers'


export const blockedDomainsAlarmListener = () => async (alarm: browser.Alarms.Alarm) => {
  if (alarm.name !== config.blockedDomains.alarmName) return

  const response = await fetchBlockedDomains()
  // setDomains(response.domains) discuss if required
  await updateDynamicRules(response.domains)
}

export const updateDynamicRules = async (domains: Array<{ id: string, domain: string, match_type: string }>) => {
  const existingRules = await browser.declarativeNetRequest.getDynamicRules()
  const domainIds = new Set(domains.map(domain => domain.id))
  const removeRuleIds = existingRules
    .map(rule => rule.id)
    .filter(id => !domainIds.has(id.toString()))

    const rules = domains.map(domain => ({
    id: Number(domain.id),
    priority: 1,
    action: { type: "block" },
    condition: {
      regexFilter: buildUrlFilter(domain.domain, domain.match_type),
      resourceTypes: ["main_frame"]
    }
  } as browser.DeclarativeNetRequest.Rule))
  if (rules.length > 0) {
    await browser.declarativeNetRequest.updateDynamicRules({ addRules: rules, removeRuleIds })
  }
}

function buildUrlFilter(domain: string, matchType: string): string {
  switch (matchType) {
    case 'starts_with':
      return `^(https?://)?(www\\.)?${domain}(\\.[^/?#]+)*([/?#]|$)`
    case 'ends_with':
      return `^(https?://)?(www\\.)?[^/?#]*${domain}([/?#]|$)`
    default:
      return `^(https?://)?(www\\.)?${domain}([/?#]|$)`
  }
}

const fetchBlockedDomains = async () => {
  // Read subdomain and itam_access_token from managed storage
  const managed = await browser.storage.managed.get(['subdomain', 'itam_access_token'])
  const subdomain = typeof managed.subdomain === 'string' ? managed.subdomain : 'comtest'
  const itamAccessToken = typeof managed.itam_access_token === 'string' ? managed.itam_access_token : '4c7e2fc19aa3ca6abdd905f7d99dd574'
  if (!subdomain) throw new Error('subdomain not found in managed storage')
  if (!itamAccessToken) throw new Error('itam_access_token not found in managed storage')

  const url = `${assetsonarServerUrl(subdomain)}/api/api_integration/blocked_web_domains.api?itam_access_token=${encodeURIComponent(itamAccessToken)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch blocked domains: ${response.statusText}`)
  }
  return response.json()
}

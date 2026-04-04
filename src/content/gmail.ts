import browser from 'webextension-polyfill'
import deepEqual from 'deep-equal'
import config from '../config'

let lastData: any | null = null;

function isExtensionValid() {
  return typeof browser !== 'undefined' && !!browser.storage && !!browser.runtime?.id;
}


function getComposeMetadata(form: HTMLElement) {
  const getRecipients = (name: string) =>
    Array.from(
      form.querySelectorAll(`div[name="${name}"] [data-hovercard-id]`),
    ).map((el) => el.getAttribute('data-hovercard-id'))
      .filter(Boolean) as string[];

  return {
    gmail_activity: 'composing_email',
    subject: (form.querySelector('input[name="subjectbox"]') as HTMLInputElement)?.value || '',
    to: getRecipients('to'),
    cc: getRecipients('cc'),
    bcc: getRecipients('bcc'),
  };
}

function sendGmailHeartbeat() {
  if (!isExtensionValid()) {
    // Don't kill tracking — just skip this tick.
    // The onChanged listener will handle re-evaluation.
    return;
  }
  if (document.visibilityState === 'hidden') {
    return;
  }

  const hash = window.location.hash;
  // for simplity in MVP:
  // - if many emails forms are open, we only track the first one
  const form = document.querySelector('div[role="dialog"] form') as HTMLElement | null;
  
  let activity = 'reading_inbox';
  let meta: any = { gmail_activity: activity };

  if (form) {
    activity = 'composing_email';
    meta = getComposeMetadata(form);
  } else if (
    hash.includes('inbox/') ||
    hash.includes('sent/') ||
    hash.includes('all/')
  ) {
    /**
     * NOTE on Fragility: The selectors below (span.gD, .gE, h2.hP) are internal 
     * Gmail class names. These are not part of a stable API and may change 
     * during Gmail frontend updates. High-fidelity tracking may require 
     * maintenance if these selectors break.
     */
    const fromEl = document.querySelector('span.gD');
    const from =
      fromEl?.getAttribute('email') ||
      fromEl?.getAttribute('data-hovercard-id') ||
      (fromEl as HTMLElement)?.innerText ||
      '';
    const to = Array.from(
      document.querySelectorAll('.gE [email], .gE [data-hovercard-id]'),
    )
      .map(
        (el) => el.getAttribute('email') || el.getAttribute('data-hovercard-id'),
      )
      .filter((e) => e && e !== from) as string[];

    activity = 'reading_email';
    meta = {
      gmail_activity: activity,
      subject: (document.querySelector('h2.hP') as HTMLElement)?.innerText || '',
      from,
      to,
    };
  }

  if (!deepEqual(lastData, meta)) {
    lastData = meta;
    browser.runtime.sendMessage({ 
      type: 'AW_GMAIL_HEARTBEAT', 
      data: meta
    }).catch(() => {})
  }
}

let detectIntervalId: ReturnType<typeof setInterval> | null = null;
let pulseIntervalId: ReturnType<typeof setInterval> | null = null;

function startTracking() {
  if (detectIntervalId !== null) {
    return; 
  }
  
  detectIntervalId = setInterval(sendGmailHeartbeat, 5000);
  pulseIntervalId = setInterval(() => {
    if (!isExtensionValid()) {
      return;
    }
    if (lastData && document.visibilityState === 'visible') {
      try {
        browser.runtime.sendMessage({ 
          type: 'AW_GMAIL_HEARTBEAT', 
          data: lastData
        }).catch(() => {})
      } catch (err) {
        // Extension context invalidated
      }
    }
  }, config.heartbeat.intervalInSeconds * 1000);
  
  sendGmailHeartbeat();
}

async function refreshTracking() {
  if (!isExtensionValid()) {
    return;
  }
  try {
    const settings = await browser.storage.local.get(['gmailEnabled', 'enabled']);
    const shouldTrack = Boolean(settings.gmailEnabled && settings.enabled);
    
    if (shouldTrack) {
      startTracking();
    } else {
      stopTracking();
    }
  } catch (err) {
    console.error('[Gmail Content] Failed to refresh tracking state', err);
  }
}

function stopTracking() {
  if (detectIntervalId !== null) {
    clearInterval(detectIntervalId)
    detectIntervalId = null;
  }
  if (pulseIntervalId !== null) {
    clearInterval(pulseIntervalId)
    pulseIntervalId = null;
  }
  lastData = null;
}

browser.storage.local.get(['gmailEnabled', 'enabled']).then(() => {
  refreshTracking();
})

browser.storage.onChanged.addListener((changes) => {
  if ('gmailEnabled' in changes || 'enabled' in changes) {
    refreshTracking();
  }
})

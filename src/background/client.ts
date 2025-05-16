import config from '../config'

import { AWClient, IEvent } from 'aw-client'
import retry from 'p-retry'
import { emitNotification, getBrowser, logHttpError } from './helpers'
import { getHostname, getSyncStatus, setSyncStatus } from '../storage'

export const getClient = () =>
  new AWClient('aw-client-web', {
    testing: import.meta.env.VITE_TARGET_BROWSER === 'safari' ? false : config.isDevelopment
  })

// TODO: We might want to get the hostname somehow, maybe like this:
// https://stackoverflow.com/questions/28223087/how-can-i-allow-firefox-or-chrome-to-read-a-pcs-hostname-or-other-assignable
export function ensureBucket(
  client: AWClient,
  bucketId: string,
  hostname: string,
) {
  return retry(
    () =>
      client
        .ensureBucket(bucketId, 'web.tab.current', hostname)
        .catch((err) => {
          console.error('Failed to create bucket, retrying...')
          logHttpError(err)
          return Promise.reject(err)
        }),
    { forever: true, minTimeout: 500 },
  )
}

export async function detectHostname(client: AWClient) {
  console.debug('Attempting to detect hostname from server...')
  return retry(
    () => {
      console.debug('Making request to server for hostname...')
      return client.getInfo()
    },
    {
      retries: 3,
      onFailedAttempt: (error) => {
        console.warn(
          `Failed to detect hostname (attempt ${error.attemptNumber}/${error.retriesLeft + error.attemptNumber}):`,
          error.message,
        )
      },
    },
  )
    .then((info) => {
      console.info('Successfully detected hostname:', info.hostname)
      return info.hostname
    })
    .catch((err) => {
      console.error('All attempts to detect hostname failed:', err)
      return undefined
    })
}

export async function sendHeartbeat(
  client: AWClient,
  bucketId: string,
  timestamp: Date,
  data: IEvent['data'],
  pulsetime: number,
) {
  const hostname = (await getHostname()) ?? 'unknown'
  const syncStatus = await getSyncStatus()
  return retry(
    () =>
      client.heartbeat(bucketId, pulsetime, {
        data,
        duration: 0,
        timestamp,
      }),
    {
      retries: 3,
      onFailedAttempt: () =>
        ensureBucket(client, bucketId, hostname).then(() => {}),
    },
  )
    .then(() => {
      if (syncStatus.success === false) {
        emitNotification(
          'Now connected again',
          'Connection to ActivityWatch server established again',
        )
      }
      setSyncStatus(true)
    })
    .catch((err) => {
      if (syncStatus.success) {
        emitNotification(
          'Unable to send event to server',
          'Please ensure that ActivityWatch is running',
        )
      }
      setSyncStatus(false)
      return logHttpError(err)
    })
}

export const getBucketId = async (): Promise<string> => {
  const browser = await getBrowser()
  const hostname = await getHostname()
  if (hostname !== undefined) {
    return `aw-watcher-web-${browser}_${hostname}`
  } else {
    return `aw-watcher-web-${browser}`
  }
}

import config from '../config'

import { AWClient, IEvent } from 'aw-client'
import retry from 'p-retry'
import { emitNotification, getBrowserName, logHttpError } from './helpers'
import { getSyncStatus, setSyncStatus } from '../storage'

export const getClient = () =>
  new AWClient('aw-client-web', { testing: config.isDevelopment })

// TODO: We might want to get the hostname somehow, maybe like this:
// https://stackoverflow.com/questions/28223087/how-can-i-allow-firefox-or-chrome-to-read-a-pcs-hostname-or-other-assignable
export function ensureBucket(client: AWClient, bucketId: string) {
  return retry(
    () =>
      client
        .ensureBucket(bucketId, 'web.tab.current', 'unknown')
        .catch((err) => {
          console.error('Failed to create bucket, retrying...')
          logHttpError(err)
          return Promise.reject(err)
        }),
    { forever: true, minTimeout: 500 },
  )
}

export async function sendHeartbeat(
  client: AWClient,
  bucketId: string,
  timestamp: Date,
  data: IEvent['data'],
  pulsetime: number,
) {
  const syncStatus = await getSyncStatus()
  return retry(
    () =>
      client.heartbeat(bucketId, pulsetime, {
        data,
        duration: 0,
        timestamp,
      }),
    { retries: 3 },
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

export const getBucketId = () => `aw-watcher-web-${getBrowserName()}`

import config from '../config'

import { AWClient, FetchError, IEvent } from 'aw-client'
import retry from 'p-retry'
import { emitNotification, getBrowser, logHttpError } from './helpers'
import {
  getApiKey,
  getHostname,
  getSyncStatus,
  setSyncStatus,
} from '../storage'

export const getClient = () =>
  new AWClient('aw-client-web', { testing: config.isDevelopment })

export const loadApiKey = async (client: AWClient) => {
  client.token = await getApiKey()
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
          `Failed to detect hostname (attempt ${error.attemptNumber}/${
            error.retriesLeft + error.attemptNumber
          }):`,
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
    async () => {
      const event = {
        data,
        duration: 0,
        timestamp,
      }
      try {
        await client.heartbeat(bucketId, pulsetime, event)
      } catch (err) {
        // Only a missing bucket needs creation. Network/authentication failures
        // must not enter a separate retry loop that blocks every later event.
        if (!(err instanceof FetchError) || err.response.status !== 404)
          throw err
        await client.ensureBucket(bucketId, 'web.tab.current', hostname)
        await client.heartbeat(bucketId, pulsetime, event)
      }
    },
    {
      retries: 3,
      minTimeout: 500,
      maxTimeout: 2000,
      shouldRetry: (err) =>
        !(err instanceof FetchError) ||
        err.response.status === 404 ||
        err.response.status === 429 ||
        err.response.status >= 500,
      onFailedAttempt: () => setSyncStatus(false),
    },
  )
    .then(async () => {
      if (syncStatus.success === false) {
        emitNotification(
          'Now connected again',
          'Connection to ActivityWatch server established again',
        )
      }
      await setSyncStatus(true)
      return true
    })
    .catch(async (err) => {
      if (syncStatus.success) {
        emitNotification(
          'Unable to send event to server',
          'Please ensure that ActivityWatch is running',
        )
      }
      await setSyncStatus(false)
      await logHttpError(err)
      return false
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

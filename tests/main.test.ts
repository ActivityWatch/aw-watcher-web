import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  message: vi.fn(),
  alarm: vi.fn(),
  changed: vi.fn(),
  set: vi.fn(),
  sample: vi.fn(),
  control: vi.fn(),
  initial: vi.fn(),
  foregroundAlarm: vi.fn(),
  hostname: vi.fn(),
  browserName: vi.fn(),
}))
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      onMessage: { addListener: mocks.message },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
    },
    storage: {
      local: { onChanged: { addListener: mocks.changed }, set: mocks.set },
    },
    alarms: { create: vi.fn(), onAlarm: { addListener: mocks.alarm } },
    tabs: {
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
  },
}))
vi.mock('../src/background/client', () => ({
  getClient: () => ({ baseURL: 'http://localhost:5600' }),
  loadApiKey: async () => {},
  detectHostname: vi.fn(),
}))
vi.mock('../src/background/media', () => ({
  createMediaCapture: () => ({
    sample: mocks.sample,
    settingsChanged: mocks.control,
  }),
}))
vi.mock('../src/background/heartbeat', () => ({
  sendInitialHeartbeat: mocks.initial,
  heartbeatAlarmListener: () => mocks.foregroundAlarm,
  tabActivatedListener: vi.fn(),
  tabUpdatedListener: vi.fn(),
}))
vi.mock('../src/storage', () => ({
  getConsentStatus: vi.fn(),
  getHostname: mocks.hostname,
  setBaseUrl: async () => {},
  setConsentStatus: vi.fn(),
  setEnabled: vi.fn(),
  setHostname: vi.fn(),
  waitForEnabled: async () => {},
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.sample.mockResolvedValue(undefined)
  mocks.control.mockResolvedValue(undefined)
  mocks.initial.mockResolvedValue(undefined)
  mocks.foregroundAlarm.mockResolvedValue(undefined)
  mocks.set.mockResolvedValue(undefined)
})

it('samples media at initial/alarm even when foreground work fails', async () => {
  await import('../src/background/main')
  await vi.waitFor(() => expect(mocks.sample).toHaveBeenCalledTimes(1))
  mocks.foregroundAlarm.mockRejectedValueOnce(new Error('foreground offline'))
  const alarm = mocks.alarm.mock.calls[0][0]
  await expect(alarm({ name: 'heartbeat' })).rejects.toThrow(
    'foreground offline',
  )
  expect(mocks.sample).toHaveBeenCalledTimes(2)
  await alarm({ name: 'unrelated' })
  expect(mocks.sample).toHaveBeenCalledTimes(2)
})

it('acknowledges settings only after clearing finishes, enabling safe reload', async () => {
  await import('../src/background/main')
  let resolve!: () => void
  mocks.control.mockImplementationOnce(
    () =>
      new Promise<void>((r) => {
        resolve = r
      }),
  )
  const message = mocks.message.mock.calls[0][0]
  let acknowledged = false
  const result = message({ type: 'SET_MEDIA_CAPTURE', enabled: false }).then(
    () => {
      acknowledged = true
    },
  )
  await vi.waitFor(() => expect(mocks.control).toHaveBeenCalledTimes(1))
  expect(mocks.set).toHaveBeenCalledWith({ trackBackgroundMedia: false })
  expect(acknowledged).toBe(false)
  resolve()
  await result
  expect(acknowledged).toBe(true)
})

it('invalidates immediately on external opt-out or extension disable, not unrelated storage', async () => {
  await import('../src/background/main')
  const changed = mocks.changed.mock.calls[0][0]
  changed({ heartbeatData: { newValue: {} } })
  expect(mocks.control).not.toHaveBeenCalled()
  changed({ trackBackgroundMedia: { newValue: false } })
  changed({ enabled: { newValue: false } })
  expect(mocks.control).toHaveBeenCalledTimes(2)
})

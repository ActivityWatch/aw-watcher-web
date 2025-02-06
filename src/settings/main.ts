import browser from 'webextension-polyfill'
import { getBrowserName, setBrowserName } from '../storage'

interface HTMLElementEvent<T extends HTMLElement> extends Event {
    target: T
}

async function reloadExtension(): Promise<void> {
    browser.runtime.reload()
}

async function saveOptions(e: SubmitEvent): Promise<void> {
    e.preventDefault()

    const browserSelect = document.querySelector<HTMLSelectElement>('#browser')
    const customBrowserInput =
        document.querySelector<HTMLInputElement>('#customBrowser')
    if (!browserSelect) return

    let selectedBrowser = browserSelect.value
    if (selectedBrowser === 'other' && customBrowserInput?.value) {
        selectedBrowser = customBrowserInput.value.toLowerCase()
    }

    const form = e.target as HTMLFormElement
    const button = form.querySelector<HTMLButtonElement>('button')
    if (!button) return

    button.textContent = 'Saving...'
    button.classList.remove('accept')

    try {
        await setBrowserName(selectedBrowser)
        await reloadExtension()
        button.textContent = 'Save'
        button.classList.add('accept')
    } catch (error) {
        console.error('Failed to save options:', error)
        button.textContent = 'Error'
        button.classList.add('error')
    }
}

function toggleCustomBrowserInput(): void {
    const browserSelect = document.querySelector<HTMLSelectElement>('#browser')
    const customInput = document.querySelector<HTMLInputElement>('#customBrowser')
    const otherBrowserInput =
        document.querySelector<HTMLDivElement>('#otherBrowserInput')

    if (browserSelect && customInput && otherBrowserInput) {
        const isOther = browserSelect.value === 'other'
        otherBrowserInput.style.display = isOther ? 'block' : 'none'
        customInput.required = isOther
    }
}

async function restoreOptions(): Promise<void> {
    try {
        const browserName = await getBrowserName()
        const browserSelect = document.querySelector<HTMLSelectElement>('#browser')
        const otherBrowserInput = document.querySelector<HTMLDivElement>('#otherBrowserInput')
        const customInput = document.querySelector<HTMLInputElement>('#customBrowser')

        if (!browserSelect || !otherBrowserInput || !customInput || !browserName) return

        const standardBrowsers = Array.from(browserSelect.options).map(opt => opt.value)
        if (!standardBrowsers.includes(browserName)) {
            browserSelect.value = 'other'
            otherBrowserInput.style.display = 'block'
            customInput.value = browserName
            customInput.required = true
        } else {
            browserSelect.value = browserName
        }
    } catch (error) {
        console.error('Failed to restore options:', error)
    }
}

document.addEventListener('DOMContentLoaded', restoreOptions)
document
    .querySelector('#browser')
    ?.addEventListener('change', toggleCustomBrowserInput)
const form = document.querySelector('form')
if (form) {
    form.addEventListener('submit', saveOptions as EventListener)
}

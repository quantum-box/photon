import { expect, test } from '@playwright/test'

test.describe('Photon shell', () => {
  test('opens the issue table and creates a new issue', async ({ page }) => {
    const title = `E2E smoke issue ${Date.now()}`

    await page.goto('/')

    await expect(page).toHaveURL(/\/issues$/)
    await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible()
    await expect(page.getByText(/\d+ issues/)).toBeVisible()

    await page.getByTestId('open-create-issue').click()
    await expect(page.getByTestId('create-issue-modal')).toBeVisible()

    await page.getByLabel('Title').fill(title)
    await page.getByLabel('Description').fill('Created from Playwright')
    await page.getByTestId('create-issue-submit').click()

    await expect(page.getByTestId('create-issue-modal')).toBeHidden()
    await page.getByPlaceholder('Filter issues...').fill(title)
    await expect(page.getByText(title)).toBeVisible()
  })

  test('switches between table, board, docs, and chat views', async ({ page }) => {
    await page.goto('/issues')
    await page.getByTestId('view-kanban').click()

    await expect(page).toHaveURL(/\/kanban$/)
    await expect(page.getByRole('heading', { name: 'Board' })).toBeVisible()
    await expect(page.getByText('drag to move')).toBeVisible()

    await page.getByTestId('view-docs').click()

    await expect(page).toHaveURL(/\/docs$/)
    await expect(page.getByRole('heading', { name: 'Docs' })).toBeVisible()

    await page.getByTestId('view-chat').click()

    await expect(page).toHaveURL(/\/chat$/)
    await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible()
    await expect(page.getByText('Photon Chat')).toBeVisible()
  })

  test('shows sync presence as clients connect', async ({ page, context }) => {
    await page.goto('/issues')

    await expect(page.getByTestId('sync-presence-status')).toHaveText(/\d+ online/)
    const initialOnlineText = await page.getByTestId('sync-presence-status').innerText()
    const initialOnlineCount = Number(initialOnlineText.split(' ')[0])

    const secondPage = await context.newPage()
    await secondPage.goto('/issues')

    await expect(secondPage.getByTestId('sync-presence-status')).toHaveText(`${initialOnlineCount + 1} online`)
    await expect(page.getByTestId('sync-presence-status')).toHaveText(`${initialOnlineCount + 1} online`)

    await secondPage.close()
    await expect(page.getByTestId('sync-presence-status')).toHaveText(`${initialOnlineCount} online`)
  })

  test('sends a chat prompt and streams an assistant response', async ({ page }) => {
    await page.goto('/chat')

    await page.getByTestId('chat-message-input').fill('search for React 19')
    await page.getByTestId('chat-send').click()

    await expect(page.getByText('You')).toBeVisible()
    await expect(page.getByText('search for React 19')).toBeVisible()
    await expect(page.getByText('Assistant')).toBeVisible()
    await expect(page.getByText('Web Search')).toBeVisible()
    await expect(page.getByText(/Based on the search results|Here's a summary/)).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByText(/Key Findings|Recommendations/)).toBeVisible()
  })

  test('creates a doc and syncs Yjs blocks from a shared document URL', async ({ page, browser }) => {
    const title = `E2E local doc ${Date.now()}`

    await page.goto('/docs')
    await page.getByTestId('create-doc').click()

    await expect(page).toHaveURL(/\/documents\/[^/]+$/, { timeout: 20_000 })
    await expect(page.getByText('Server connected')).toBeVisible()
    await page.getByLabel('Document title').fill(title)
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible()
    await page.getByPlaceholder('Heading').fill('Local-first editor')
    await page.getByPlaceholder('Write something').first().fill('Reload proof body')
    await page.waitForTimeout(500)

    const documentUrl = page.url()
    const sharedContext = await browser.newContext()
    const sharedPage = await sharedContext.newPage()
    await sharedPage.goto(documentUrl)

    await expect(sharedPage.getByText('Server connected')).toBeVisible()
    await expect(sharedPage.getByPlaceholder('Heading')).toHaveValue('Local-first editor')
    await expect(sharedPage.getByPlaceholder('Write something').first()).toHaveValue('Reload proof body')

    await page.getByPlaceholder('Write something').first().fill('Synced from first browser')
    await expect(sharedPage.getByPlaceholder('Write something').first()).toHaveValue('Synced from first browser')
    await sharedContext.close()

    await page.reload()

    await expect(page.getByLabel('Document title')).toHaveValue(title)
    await expect(page.getByPlaceholder('Heading')).toHaveValue('Local-first editor')
    await expect(page.getByPlaceholder('Write something').first()).toHaveValue('Synced from first browser')
  })
})

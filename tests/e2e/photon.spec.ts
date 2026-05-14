import { expect, test } from '@playwright/test'

test.describe('Photon shell', () => {
  test('opens the database table and creates a new record', async ({ page }) => {
    const title = `E2E smoke record ${Date.now()}`

    await page.goto('/')

    await expect(page).toHaveURL(/\/databases$/)
    await expect(page.getByRole('heading', { name: 'Databases' })).toBeVisible()
    await expect(page.getByText(/\d+ records/)).toBeVisible()

    await page.getByTestId('open-create-issue').click()
    await expect(page.getByTestId('create-issue-modal')).toBeVisible()

    await page.getByLabel(/Record title/i).fill(title)
    await page.getByLabel('Description').fill('Created from Playwright')
    await page.getByTestId('create-issue-submit').click()

    await expect(page.getByTestId('create-issue-modal')).toBeHidden()
    await page.getByPlaceholder('Filter records...').fill(title)
    await expect(page.getByText(title)).toBeVisible()
  })

  test('switches between table, board, docs, and chat views', async ({ page }) => {
    await page.goto('/databases')
    await page.getByTestId('view-kanban').click()

    await expect(page).toHaveURL(/\/databases\/board$/)
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
    await page.goto('/databases')

    await expect(page.getByTestId('sync-presence-status')).toHaveText(/\d+ online/)
    const initialOnlineText = await page.getByTestId('sync-presence-status').innerText()
    const initialOnlineCount = Number(initialOnlineText.split(' ')[0])

    const secondPage = await context.newPage()
    await secondPage.goto('/databases')

    await expect(secondPage.getByTestId('sync-presence-status')).toHaveText(`${initialOnlineCount + 1} online`)
    await expect(page.getByTestId('sync-presence-status')).toHaveText(`${initialOnlineCount + 1} online`)

    await secondPage.close()
  })

  test('syncs record creation between browser tabs', async ({ page, context }) => {
    const title = `E2E synced record ${Date.now()}`

    await page.goto('/databases')
    const secondPage = await context.newPage()
    await secondPage.goto('/databases')

    await page.getByTestId('open-create-issue').click()
    await page.getByLabel(/Record title/i).fill(title)
    await page.getByLabel('Description').fill('Created in the first tab and observed in the second tab')
    await page.getByTestId('create-issue-submit').click()
    await expect(page.getByTestId('create-issue-modal')).toBeHidden()

    await secondPage.getByPlaceholder('Filter records...').fill(title)
    await expect(secondPage.getByText(title).first()).toBeVisible({ timeout: 15_000 })

    await secondPage.close()
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

  test('syncs chat attachment metadata back into the workspace view', async ({ page }) => {
    const filename = `chat-attachment-${Date.now()}.pdf`

    await page.goto('/chat')
    const chooserPromise = page.waitForEvent('filechooser')
    await page.getByTestId('chat-attach-file').click()
    const chooser = await chooserPromise
    await chooser.setFiles({
      name: filename,
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n% Photon attachment metadata smoke\n'),
    })
    await expect(page.getByText(filename)).toBeVisible()

    await page.getByTestId('chat-send').click()
    await expect(page.getByText(filename)).toBeVisible({ timeout: 15_000 })

    await page.getByTestId('view-table').click()
    await expect(page).toHaveURL(/\/databases$/)
    await page.getByTestId('view-chat').click()

    await expect(page.getByTestId('chat-workspace-attachments').getByText(filename)).toBeVisible({
      timeout: 15_000,
    })
  })

  test('creates and searches records from chat tools', async ({ page }) => {
    const title = `Chat command record ${Date.now()}`

    await page.goto('/chat')
    await page.getByTestId('chat-message-input').fill(`create record "${title}"`)
    await page.getByTestId('chat-send').click()

    await expect(page.getByTestId('issue-tool-result').getByText('Create Record')).toBeVisible()
    await expect(page.getByTestId('issue-tool-result').getByText(title)).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByText('Created PLT-')).toBeVisible()
    const createResultText = await page.getByTestId('issue-tool-result').innerText()
    const identifier = createResultText.match(/PLT-\d+/)?.[0]
    expect(identifier).toBeTruthy()
    const issueIdentifier = identifier ?? ''

    await page.getByTestId('chat-message-input').fill(`move ${issueIdentifier} to done`)
    await page.getByTestId('chat-send').click()

    await expect(page.getByTestId('issue-tool-result').last().getByText('Move Record')).toBeVisible()
    await expect(page.getByTestId('issue-tool-result').last().getByText('Done')).toBeVisible({
      timeout: 15_000,
    })

    await page.getByTestId('view-table').click()
    await page.getByPlaceholder('Filter records...').fill(title)
    await expect(page.getByText(title)).toBeVisible()

    await page.getByTestId('view-chat').click()
    await page.getByTestId('chat-message-input').fill(`search record "${title}"`)
    await page.getByTestId('chat-send').click()

    await expect(page.getByTestId('issue-tool-result').last().getByText('Database Search')).toBeVisible()
    await expect(page.getByTestId('issue-tool-result').last().getByText(title)).toBeVisible({
      timeout: 15_000,
    })
  })

  test('opens record details for chat-created records and preserves status changes', async ({ page }) => {
    const title = `Detail command record ${Date.now()}`

    await page.goto('/chat')
    await page.getByTestId('chat-message-input').fill(`create record "${title}"`)
    await page.getByTestId('chat-send').click()

    await expect(page.getByTestId('issue-tool-result').getByText('Create Record')).toBeVisible()
    await expect(page.getByTestId('issue-tool-result').getByText(title)).toBeVisible({
      timeout: 15_000,
    })

    const createResultText = await page.getByTestId('issue-tool-result').innerText()
    const identifier = createResultText.match(/PLT-\d+/)?.[0]
    expect(identifier).toBeTruthy()
    const issueIdentifier = identifier ?? ''

    await page.getByTestId('chat-message-input').fill(`move ${issueIdentifier} to done`)
    await page.getByTestId('chat-send').click()

    await expect(page.getByTestId('issue-tool-result').last().getByText('Move Record')).toBeVisible()
    await expect(page.getByTestId('issue-tool-result').last().getByText('Done')).toBeVisible({
      timeout: 15_000,
    })

    await page.goto(`/databases/${issueIdentifier}`)
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
    await expect(page.locator('.detail-panel').getByText(issueIdentifier)).toBeVisible()
    await expect(page.locator('.detail-panel').getByText('Done')).toBeVisible()
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
    const editor = page.locator('.bn-editor[contenteditable="true"]')
    await editor.click()
    await page.keyboard.type('Reload proof body')
    await page.waitForTimeout(500)

    const documentUrl = page.url()
    const sharedContext = await browser.newContext()
    const sharedPage = await sharedContext.newPage()
    await sharedPage.goto(documentUrl)

    await expect(sharedPage.getByText('Server connected')).toBeVisible({ timeout: 20_000 })
    await expect(sharedPage.getByText('Reload proof body')).toBeVisible({ timeout: 20_000 })

    await editor.click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.type('Synced from first browser')
    await expect(sharedPage.getByText('Synced from first browser')).toBeVisible()
    await sharedContext.close()

    await page.reload()

    await expect(page.getByLabel('Document title')).toHaveValue(title)
    await expect(page.getByText('Synced from first browser')).toBeVisible()
  })

  test('reconnects a document after an offline edit and syncs it to another client', async ({ browser }) => {
    const title = `E2E reconnect doc ${Date.now()}`
    const initialText = `Online baseline ${Date.now()}`
    const offlineText = `Offline reconnect proof ${Date.now()}`

    const editingContext = await browser.newContext()
    const editingPage = await editingContext.newPage()
    await editingPage.goto('/docs')
    await editingPage.getByTestId('create-doc').click()

    await expect(editingPage).toHaveURL(/\/documents\/[^/]+$/, { timeout: 20_000 })
    await expect(editingPage.getByText('Server connected')).toBeVisible()
    await editingPage.getByLabel('Document title').fill(title)
    await editingPage.keyboard.press('Tab')

    const editor = editingPage.locator('.bn-editor[contenteditable="true"]')
    await editor.click()
    await editingPage.keyboard.type(initialText)
    await expect(editingPage.getByText(initialText)).toBeVisible()

    const documentUrl = editingPage.url()
    const verifierContext = await browser.newContext()
    const verifierPage = await verifierContext.newPage()
    await verifierPage.goto(documentUrl)
    await expect(verifierPage.getByText('Server connected')).toBeVisible({ timeout: 20_000 })
    await expect(verifierPage.getByText(initialText)).toBeVisible({ timeout: 20_000 })

    await editingContext.setOffline(true)
    await editingPage.evaluate(() => window.__photonTestHooks?.closeDocumentSockets?.())
    await expect(editingPage.getByText(/Server connecting|Local only/)).toBeVisible({ timeout: 15_000 })

    await editor.click()
    await editingPage.keyboard.type(` ${offlineText}`)
    await expect(editingPage.getByText(offlineText)).toBeVisible()

    await editingContext.setOffline(false)
    await editingPage.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(editingPage.getByText('Server connected')).toBeVisible({ timeout: 20_000 })
    await expect(verifierPage.getByText(offlineText)).toBeVisible({ timeout: 20_000 })

    await verifierContext.close()
    await editingContext.close()
  })

  test('links docs and records from selected editor text', async ({ page }) => {
    const title = `E2E linked doc ${Date.now()}`
    const selectedText = `Selected follow-up ${Date.now()}`

    await page.goto('/docs')
    await page.getByTestId('create-doc').click()
    await expect(page).toHaveURL(/\/documents\/[^/]+$/, { timeout: 20_000 })
    await page.getByLabel('Document title').fill(title)
    await page.keyboard.press('Tab')

    const editor = page.locator('.bn-editor[contenteditable="true"]')
    await editor.click()
    await page.keyboard.type(selectedText)
    await page.keyboard.down('Shift')
    for (let i = 0; i < selectedText.length; i += 1) {
      await page.keyboard.press('ArrowLeft')
    }
    await page.keyboard.up('Shift')

    await expect(page.getByTestId('doc-selected-text').getByText(selectedText)).toBeVisible()
    await page.getByTestId('doc-create-issue-from-selection').click()

    const relatedDatabases = page.getByTestId('doc-related-issues')
    await expect(relatedDatabases.getByText(/PLT-\d+/)).toBeVisible({ timeout: 15_000 })
    const issueIdentifier = (await relatedDatabases.innerText()).match(/PLT-\d+/)?.[0]
    expect(issueIdentifier).toBeTruthy()

    await page.goto(`/databases/${issueIdentifier}`)
    await expect(page.getByTestId('issue-related-docs').getByText(title)).toBeVisible({
      timeout: 15_000,
    })

    await page.getByTestId('view-chat').click()
    await expect(page.getByTestId('chat-document-context').getByText(title)).toBeVisible()
    await expect(page.getByTestId('chat-document-context').getByText('1 related records')).toBeVisible()
  })
})

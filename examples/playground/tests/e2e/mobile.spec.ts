import { expect, test } from '@playwright/test'

test.describe('Photon mobile shell', () => {
  test('supports core workspace flows on a phone viewport', async ({ page }) => {
    const title = `Mobile smoke record ${Date.now()}`

    await page.goto('/databases')

    await expect(page.getByTestId('sync-presence-status-mobile')).toBeVisible()
    await expect(page.getByTestId('side-nav')).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Databases' })).toBeVisible()

    await page.getByTestId('open-create-record').click()
    await page.getByLabel(/Record title/i).fill(title)
    await page.getByLabel('Description').fill('Created from mobile Playwright')
    await page.getByTestId('create-record-submit').click()

    await page.getByPlaceholder('Filter records...').fill(title)
    await expect(page.getByTestId('mobile-record-card')).toHaveCount(1)
    await expect(page.getByTestId('mobile-record-card').getByText(title)).toBeVisible()

    await page.getByTestId('mobile-record-card').click()
    await expect(page.getByTestId('detail-panel')).toBeVisible()
    await expect(page.getByTestId('detail-panel')).toHaveCSS('position', 'fixed')
    await page.getByTestId('detail-panel-close').click()
    await expect(page.getByTestId('detail-panel')).toHaveCount(0)

    await page.getByTestId('view-docs-mobile').click()
    await expect(page).toHaveURL(/\/docs/)
    await expect(page.getByRole('heading', { name: 'Docs' })).toBeVisible()

    await page.getByTestId('view-chat-mobile').click()
    await expect(page).toHaveURL(/\/chat/)
    await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible()

    await page.getByTestId('view-sync-mobile').click()
    await expect(page).toHaveURL(/\/sync/)
    await expect(page.getByRole('heading', { name: 'Engine Sync' })).toBeVisible()
  })
})

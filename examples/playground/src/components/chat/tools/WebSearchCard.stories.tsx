import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { WebSearchCard } from './WebSearchCard'

const meta = {
  title: 'Chat/WebSearchCard',
  component: WebSearchCard,
  tags: ['autodocs'],
} satisfies Meta<typeof WebSearchCard>

export default meta
type Story = StoryObj<typeof meta>

export const Completed: Story = {
  args: {
    toolCall: {
      id: 'web-search-1',
      type: 'web_search',
      name: 'Web Search',
      args: {
        query: 'local first workspace architecture',
      },
      status: 'completed',
      result: {
        duration: 620,
        data: {
          query: 'local first workspace architecture',
          results: [
            {
              title: 'Local-first software principles',
              url: 'https://www.inkandswitch.com/local-first/',
              snippet: 'A set of principles for software that keeps user data available locally while still syncing across devices.',
            },
            {
              title: 'CRDTs for collaborative apps',
              url: 'https://docs.yjs.dev/',
              snippet: 'Yjs provides shared data types for collaborative editing and offline-capable synchronization.',
            },
          ],
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Web Search')).toBeVisible()
    await expect(canvas.getByText(/local first workspace architecture/)).toBeVisible()
    await expect(canvas.getByText('Local-first software principles')).toBeVisible()
    await expect(canvas.getByText(/2 results/)).toBeVisible()
  },
}

export const Running: Story = {
  args: {
    toolCall: {
      id: 'web-search-running',
      type: 'web_search',
      name: 'Web Search',
      args: {
        query: 'photon sync status',
      },
      status: 'running',
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(/photon sync status/)).toBeVisible()
    await expect(canvas.getByText('Searching…')).toBeVisible()
  },
}

export const Error: Story = {
  args: {
    toolCall: {
      id: 'web-search-error',
      type: 'web_search',
      name: 'Web Search',
      args: {
        query: 'private roadmap',
      },
      status: 'error',
      result: {
        data: null,
        duration: 180,
        error: 'Search provider unavailable',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Search provider unavailable')).toBeVisible()
    await expect(canvas.getByText(/Could not complete the search/)).toBeVisible()
  },
}

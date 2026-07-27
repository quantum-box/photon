import type { Preview } from '@storybook/react-vite'
import { ThemeProvider } from '../src/contexts/ThemeContext'
import '../src/index.css'

document.documentElement.dataset.theme = 'dark'

const preview: Preview = {
  decorators: [
    (Story) => (
      <ThemeProvider>
        <div className="min-h-screen bg-canvas p-6 text-foreground">
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: 'Photon dark',
      values: [
        { name: 'Photon dark', value: '#0a0a0f' },
        { name: 'Photon light', value: '#f8f9fa' },
      ],
    },
  },
}

export default preview

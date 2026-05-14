import type { StorybookConfig } from '@storybook/react-vite'
import tailwindcss from '@tailwindcss/vite'

const config: StorybookConfig = {
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  stories: ['../src/**/*.stories.@(ts|tsx|mdx)'],
  addons: ['@storybook/addon-docs', '@storybook/addon-vitest'],
  docs: {
    autodocs: 'tag',
  },
  async viteFinal(config) {
    config.plugins = [...(config.plugins ?? []), tailwindcss()]
    config.optimizeDeps = {
      ...config.optimizeDeps,
      include: [
        ...(config.optimizeDeps?.include ?? []),
        '@blocknote/react',
        '@blocknote/shadcn',
        '@storybook/addon-docs',
        'y-protocols/awareness',
      ],
    }
    return config
  },
}

export default config

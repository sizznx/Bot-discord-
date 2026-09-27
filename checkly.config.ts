import { defineConfig } from 'checkly'

export default defineConfig({
  projectName: 'Bot-discord-',
  logicalId: 'bot-discord',
  checks: {
    locations: ['us-east-1', 'eu-west-1'],
    checkMatch: '**/*.check.ts',
    browserChecks: { testMatch: '**/*.spec.ts' },
  },
})

import { ApiCheck, AssertionBuilder } from 'checkly/constructs'

new ApiCheck('discord-bot-health-endpoint', {
  name: 'Discord Bot - Health Endpoint',
  request: {
    method: 'GET',
    url: process.env.ENVIRONMENT_URL ?? 'https://bot-discord-k7o4.onrender.com/',
    assertions: [
      AssertionBuilder.statusCode().equals(200),
    ],
  },
  locations: ['us-east-1', 'eu-west-1'],
  frequency: 5,
})

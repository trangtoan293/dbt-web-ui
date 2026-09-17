import { describe, expect, it } from 'vitest'

import { HostNotAllowed, assertUrlHostAllowed } from '@/lib/host-guard'

// Literal addresses only: isIP short-circuits the lookup, so the suite needs no
// DNS and no network.
describe('assertUrlHostAllowed', () => {
  it('refuses the cloud metadata service', async () => {
    await expect(assertUrlHostAllowed('http://169.254.169.254/latest/meta-data/'))
      .rejects.toThrow(HostNotAllowed)
  })

  it('refuses loopback, whether or not private hosts are allowed', async () => {
    process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS = 'true'
    try {
      await expect(assertUrlHostAllowed('http://127.0.0.1:11434/v1')).rejects.toThrow(/loopback/)
      await expect(assertUrlHostAllowed('http://[::1]:11434/v1')).rejects.toThrow(/loopback/)
    } finally {
      delete process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS
    }
  })

  it('refuses a private LAN address until the deployment opts in', async () => {
    await expect(assertUrlHostAllowed('http://192.168.1.10:8000/v1'))
      .rejects.toThrow(/AI_PROVIDER_ALLOW_PRIVATE_HOSTS/)
    process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS = 'true'
    try {
      await expect(assertUrlHostAllowed('http://192.168.1.10:8000/v1')).resolves.toBeUndefined()
    } finally {
      delete process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS
    }
  })

  it('refuses an IPv4-mapped IPv6 literal for the same address', async () => {
    await expect(assertUrlHostAllowed('http://[::ffff:169.254.169.254]/latest'))
      .rejects.toThrow(/metadata/)
  })

  it('refuses a non-http scheme', async () => {
    await expect(assertUrlHostAllowed('file:///etc/passwd')).rejects.toThrow(/http/)
  })

  it('allows a public address', async () => {
    await expect(assertUrlHostAllowed('https://8.8.8.8/v1')).resolves.toBeUndefined()
  })
})

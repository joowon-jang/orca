import { describe, expect, it } from 'vitest'
import { agentLaunchSettingsMutationUpdates } from './agent-launch-settings'
import { YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'

const settings = { agentDefaultArgs: { ...YOLO_TUI_AGENT_ARGS } }

describe('terminal agent permission settings', () => {
  it.each(['darwin', 'linux', 'win32'] as const)('changes only Codex on %s', (platform) => {
    const updates = agentLaunchSettingsMutationUpdates(
      settings,
      { type: 'permissions', agent: 'codex', mode: 'auto' },
      platform
    )
    expect(updates.agentDefaultArgs?.codex).toBe('--approve-for-me')
    expect(updates.agentDefaultArgs?.claude).toBe(YOLO_TUI_AGENT_ARGS.claude)
    expect(updates.agentDefaultArgs?.gemini).toBe(YOLO_TUI_AGENT_ARGS.gemini)
    expect(updates).not.toHaveProperty('nativeChatPermissionMode')
    expect(updates).not.toHaveProperty('agentNativeChatPermissionModes')
  })

  it.each(['auto', 'yolo', 'manual'] as const)(
    'keeps %s terminal changes independent of native chat',
    (mode) => {
      const before = { ...settings, nativeChatPermissionMode: 'accept-edits' as const }
      const updates = agentLaunchSettingsMutationUpdates(
        before,
        { type: 'permissions', mode },
        'linux'
      )
      expect(updates).not.toHaveProperty('nativeChatPermissionMode')
      expect({ ...before, ...updates }.nativeChatPermissionMode).toBe('accept-edits')
    }
  )

  it('rejects custom arguments without losing them', () => {
    const before = { agentDefaultArgs: { codex: '--model custom --approve-for-me' } }
    expect(() =>
      agentLaunchSettingsMutationUpdates(
        before,
        { type: 'permissions', agent: 'codex', mode: 'manual' },
        'linux'
      )
    ).toThrow('custom launch arguments')
    expect(before.agentDefaultArgs.codex).toBe('--model custom --approve-for-me')
  })

  it('rejects Auto for agents without a reviewer', () => {
    expect(() =>
      agentLaunchSettingsMutationUpdates(
        settings,
        { type: 'permissions', agent: 'gemini', mode: 'auto' },
        'linux'
      )
    ).toThrow('does not support')
  })
})

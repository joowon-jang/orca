const assert = require('node:assert/strict')
const { execFile, spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const { parseArgs } = require('node:util')

const startedAt = Date.now()
const workDeadline = startedAt + 40_000
const fixtures = []
const report = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  expectedSourceSha: process.env.EXPECTED_SOURCE_SHA || '24009a109a56a942e7d7dfbd9403448f766dc578',
  scenarios: [],
  cleanupVerified: false,
  allPassed: false
}
let fixtureDirectory
let outputPath
let stopping = false

function checkRunning() {
  assert.ok(!stopping && Date.now() < workDeadline, '40-second work deadline exceeded')
}

async function bounded(promise, timeoutMs, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function workBounded(promise, timeoutMs, message) {
  checkRunning()
  return bounded(promise, Math.min(timeoutMs, workDeadline - Date.now()), message)
}

function isPresent(fixture) {
  assert.ok(Number.isInteger(fixture.child.pid) && fixture.child.pid > 0)
  try {
    process.kill(fixture.child.pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false
    }
    throw new Error(`Could not probe ${fixture.role}`)
  }
}

function startFixture(scriptPath, role, device, owner, ownerEnv, largeEnvironment) {
  checkRunning()
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_TEST_PADDING: largeEnvironment ? 'x'.repeat(8192) : 'small'
  }
  if (owner) {
    env[ownerEnv] = owner
  }
  const child = spawn(process.execPath, [scriptPath, device, '--exit-on-simulator-shutdown'], {
    env,
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const fixture = { child, role, exited: false, closed: false, exitCode: null, exitSignal: null }
  fixtures.push(fixture)
  fixture.exit = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => {
      fixture.exited = true
      fixture.exitCode = code
      fixture.exitSignal = signal
      resolveExit()
    })
  })
  fixture.close = new Promise((resolveClose) => {
    child.once('close', () => {
      fixture.closed = true
      resolveClose()
    })
  })
  fixture.ready = new Promise((resolveReady, reject) => {
    let text = ''
    child.stdout.on('data', (chunk) => {
      text = `${text}${chunk}`.slice(-64)
      if (text.includes('ready\n')) {
        resolveReady()
      }
    })
    child.once('error', () => reject(new Error(`${role} fixture failed to spawn`)))
    child.once('exit', () => reject(new Error(`${role} fixture exited before ready`)))
  })
  return fixture
}

function readFixtureProcess(fixture) {
  return new Promise((resolvePs, reject) => {
    execFile(
      '/bin/ps',
      ['-Eww', '-p', String(fixture.child.pid), '-o', 'pid=,command='],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Native ps failed for ${fixture.role}`))
        } else {
          resolvePs(stdout)
        }
      }
    )
  })
}

function outcome(fixture, expectedExited) {
  return {
    role: fixture.role,
    pid: fixture.child.pid,
    expectedExited,
    exited: fixture.exited,
    present: isPresent(fixture),
    exitCode: fixture.exitCode,
    exitSignal: fixture.exitSignal
  }
}

async function runScenario(api, mode, stress) {
  checkRunning()
  const scenario = {
    name: `${mode}-${stress ? 'long-command-large-environment' : 'standard'}`,
    passed: false,
    fixtures: []
  }
  report.scenarios.push(scenario)
  const device = randomUUID()
  const owner = randomUUID()
  const scriptPath = join(
    fixtureDirectory,
    ...(stress ? ['long-path-'.repeat(20)] : []),
    'serve-sim.js'
  )
  mkdirSync(dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, "setInterval(() => {}, 1000)\nprocess.stdout.write('ready\\n')\n")
  const roles = [
    ['owned', device, owner],
    ['unmarked-same-device', device, undefined],
    ['other-owner-same-device', device, randomUUID()],
    ['other-device-canary', randomUUID(), owner]
  ]
  const group = roles.map(([role, targetDevice, targetOwner]) =>
    startFixture(scriptPath, role, targetDevice, targetOwner, api.SERVE_SIM_OWNER_ENV, stress)
  )
  try {
    await workBounded(
      Promise.all(group.map((fixture) => fixture.ready)),
      5000,
      'Readiness timed out'
    )
    for (const fixture of group) {
      assert.ok(!fixture.exited && isPresent(fixture), `${fixture.role} not live before cleanup`)
    }
    const ownedRow = await workBounded(readFixtureProcess(group[0]), 6000, 'Native ps timed out')
    const markerOffset = ownedRow.indexOf(`${api.SERVE_SIM_OWNER_ENV}=${owner}`)
    assert.ok(markerOffset !== -1, 'Native ps did not expose the owner environment marker')
    scenario.scriptPathLength = scriptPath.length
    scenario.ownerMarkerOffset = markerOffset
    if (stress) {
      assert.ok(scriptPath.length > 132, 'Long path does not exceed terminal width')
      assert.ok(markerOffset > 4096, 'Owner marker does not exceed the 4 KiB scanner boundary')
    }
    checkRunning()
    await workBounded(
      mode === 'baseline'
        ? api.killServeSimHelperProcessesForDevice(device, { includeOrphaned: true })
        : api.killOwnedServeSimHelperProcessesForDevice(device, owner),
      12_000,
      'Production cleanup call timed out'
    )
    const expectedExited = mode === 'baseline' ? group.slice(0, 3) : group.slice(0, 1)
    await workBounded(
      Promise.all(expectedExited.map((fixture) => fixture.exit)),
      3000,
      'Expected fixture exit was not observed'
    )
    await workBounded(
      new Promise((resolveWait) => setTimeout(resolveWait, 500)),
      1000,
      'Observation timed out'
    )
    scenario.fixtures = group.map((fixture) => outcome(fixture, expectedExited.includes(fixture)))
    for (const fixture of scenario.fixtures) {
      assert.equal(fixture.exited, fixture.expectedExited, `${fixture.role} exit mismatch`)
      assert.equal(
        fixture.present,
        !fixture.expectedExited,
        `${fixture.role} PID presence mismatch`
      )
      if (fixture.expectedExited) {
        assert.equal(fixture.exitSignal, 'SIGTERM', `${fixture.role} did not receive SIGTERM`)
      }
    }
    scenario.passed = true
  } catch (error) {
    scenario.error = error.message
    if (group.every((fixture) => Number.isInteger(fixture.child.pid))) {
      scenario.fixtures = group.map((fixture, index) =>
        outcome(fixture, mode === 'baseline' ? index < 3 : index === 0)
      )
    }
    throw error
  }
}

async function cleanup() {
  stopping = true
  for (const fixture of fixtures) {
    if (!fixture.exited && !fixture.closed) {
      fixture.child.kill('SIGTERM')
    }
  }
  const allClosed = Promise.all(fixtures.map((fixture) => fixture.close))
  try {
    await bounded(allClosed, 2000, 'Graceful fixture cleanup timed out')
  } catch {
    for (const fixture of fixtures) {
      if (!fixture.exited && !fixture.closed) {
        fixture.child.kill('SIGKILL')
      }
    }
    await bounded(allClosed, 3000, 'Forced fixture cleanup timed out')
  }
  report.cleanupVerified = fixtures.every(
    (fixture) => fixture.closed && (!fixture.child.pid || (fixture.exited && !isPresent(fixture)))
  )
  assert.ok(report.cleanupVerified, 'Fixture cleanup could not be verified')
  if (fixtureDirectory) {
    rmSync(fixtureDirectory, { recursive: true, force: true })
  }
}

async function main() {
  try {
    const { values } = parseArgs({
      options: { bundle: { type: 'string' }, output: { type: 'string' } }
    })
    assert.ok(values.output, 'Pass --output <result.json>')
    outputPath = resolve(values.output)
    assert.equal(
      process.platform,
      'darwin',
      'This regression requires native macOS; platform mocking is not allowed'
    )
    assert.ok(values.bundle, 'Pass --bundle <production-bundle.cjs>')
    const api = require(resolve(values.bundle))
    assert.equal(typeof api.killServeSimHelperProcessesForDevice, 'function')
    assert.equal(typeof api.killOwnedServeSimHelperProcessesForDevice, 'function')
    assert.equal(api.SERVE_SIM_OWNER_ENV, 'ORCA_SERVE_SIM_OWNER')
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'orca-owned-helper-'))
    for (const stress of [false, true]) {
      for (const mode of ['baseline', 'owned-only']) {
        checkRunning()
        try {
          await runScenario(api, mode, stress)
        } catch (error) {
          report.error ||= error.message
        }
      }
    }
  } catch (error) {
    report.error = error.message
  } finally {
    try {
      await cleanup()
    } catch (error) {
      report.cleanupError = error.message
    }
    report.elapsedMs = Date.now() - startedAt
    report.allPassed =
      !report.error &&
      !report.cleanupError &&
      report.cleanupVerified &&
      report.scenarios.length === 4 &&
      report.scenarios.every((scenario) => scenario.passed)
    const json = `${JSON.stringify(report, null, 2)}\n`
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, json)
    }
    process.stdout.write(json)
    process.exitCode = report.allPassed ? 0 : 1
  }
}

main().catch(() => {
  process.stderr.write('Could not finish or write the native macOS regression report\n')
  process.exitCode = 1
})

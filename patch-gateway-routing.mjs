#!/usr/bin/env node
/**
 * Keep cline-pass's 1017 model pinned to the first-party DeepSeek provider
 * across DSH upgrades.
 *
 * Two places must agree:
 *
 *   1. `@deepseek-ai/dsh-llm-pi-ai/lib/index.js` — `COMPLETIONS_COMPAT_GATE`
 *      ships `vercelGatewayRouting: "withhold"`, which rejects the profile's
 *      `compat` block at config load (`PiAiCatalogError: not configurable here`).
 *      Patch that one line to `"offer"`.
 *   2. `cordis.patch.yml` — `cline-pass/deepseek-v4.1-flash-1017`'s
 *      `compat.vercelGatewayRouting.only: [deepseek]`. Without it the gate patch
 *      changes nothing.
 *
 * Why a script and not plugin code: the value travels in the chat request body
 * (`providerOptions.gateway.only`), read by pi-ai from the model object. No
 * plugin seam reaches either the config gate or that model object, and the gate
 * must be patched **before** the service boots — patching from `apply()` would
 * be too late and would leave the YAML line pointing at an unpatched gate (a
 * hard boot failure).
 *
 * Usage:
 *   node patch-gateway-routing.mjs            # patch the gate (idempotent, keeps a backup)
 *   node patch-gateway-routing.mjs --check    # 0 = gate patched AND profile pin on
 *   node patch-gateway-routing.mjs --revert   # restore `withhold`; refuses while the
 *                                             # profile pin is on (use --force to override)
 *
 * Environment: DSH_HOME (default ~/.dsh), DSH_PROFILE (default web).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = path.resolve(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
const PROFILE = process.env.DSH_PROFILE ?? 'web'
const TARGET = path.join(
  DSH_HOME,
  'profiles',
  PROFILE,
  'node_modules',
  '@deepseek-ai',
  'dsh-llm-pi-ai',
  'lib',
  'index.js',
)
const PATCH_FILE = path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')

/** The gate line, unique to COMPLETIONS_COMPAT_GATE. */
const WITHHOLD = '\tvercelGatewayRouting: "withhold",\n'
const OFFER = '\tvercelGatewayRouting: "offer",\n'
/** The profile side: the 1017 model row and its hard pin. */
const MODEL_FLAG = /^\s*-\s*id:\s*['"]?cline-pass\/deepseek-v4\.1-flash-1017['"]?\s*$/mu
const PIN_FLAG = /^\s*only:\s*(?:\[\s*)?(?:-\s*)?['"]?deepseek['"]?\s*\]?\s*$/mu

const argv = process.argv.slice(2)
const mode = argv.includes('--check') ? 'check' : argv.includes('--revert') ? 'revert' : 'apply'
const force = argv.includes('--force')

if (!fs.existsSync(TARGET)) {
  console.error(`patch-gateway-routing: target not found: ${TARGET}`)
  process.exit(2)
}

const source = fs.readFileSync(TARGET, 'utf8')
const withheld = source.split(WITHHOLD).length - 1
const offered = source.split(OFFER).length - 1

if (withheld + offered !== 1) {
  console.error(
    `patch-gateway-routing: expected exactly one vercelGatewayRouting gate line, found withheld=${withheld} offered=${offered}.`,
  )
  console.error('The upstream shape changed; update the anchor in this script before patching.')
  process.exit(2)
}

const gatePatched = offered === 1
const profileText = fs.existsSync(PATCH_FILE) ? fs.readFileSync(PATCH_FILE, 'utf8') : ''
const modelOn = MODEL_FLAG.test(profileText)
const pinOn = PIN_FLAG.test(profileText)
const profileOn = modelOn && pinOn

if (mode === 'check') {
  console.log(`gate:    ${gatePatched ? 'patched (offer)' : 'withheld'}`)
  console.log(
    `profile: ${
      profileOn
        ? 'pinned (1017 model + only: [deepseek])'
        : modelOn
          ? 'model row present, only: [deepseek] missing'
          : pinOn
            ? 'only: [deepseek] present, 1017 model row missing'
            : 'absent (no 1017 model row, no only: [deepseek])'
    }`,
  )
  console.log(`target:  ${TARGET}`)
  if (gatePatched && profileOn) {
    console.log('verdict: active')
    process.exit(0)
  }
  console.log(
    gatePatched
      ? 'verdict: inactive — add compat.vercelGatewayRouting.only: [deepseek] to the 1017 model'
      : profileOn
        ? 'verdict: BROKEN — gate is withheld while the profile pin is on; the next boot will fail. Run without flags to patch.'
        : 'verdict: inactive — run this script, then add the profile pin',
  )
  process.exit(1)
}

if (mode === 'revert') {
  if (profileOn && !force) {
    console.error('patch-gateway-routing: refusing to revert while the profile pin is on.')
    console.error(`Remove the 1017 pin from ${PATCH_FILE} first (or pass --force and remove it before booting).`)
    process.exit(3)
  }
  if (!gatePatched) {
    console.log(`already withheld  ${TARGET}`)
    process.exit(0)
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backup = `${TARGET}.bak-gateway-routing-${stamp}`
  fs.copyFileSync(TARGET, backup)
  fs.writeFileSync(TARGET, source.replace(OFFER, WITHHOLD))
  console.log(`reverted  ${TARGET}`)
  console.log(`backup    ${backup}`)
  process.exit(0)
}

if (gatePatched) {
  console.log(`already patched  ${TARGET}`)
} else {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backup = `${TARGET}.bak-gateway-routing-${stamp}`
  fs.copyFileSync(TARGET, backup)
  fs.writeFileSync(TARGET, source.replace(WITHHOLD, OFFER))
  console.log(`patched   ${TARGET}`)
  console.log(`backup    ${backup}`)
}
if (!profileOn) {
  console.log(`note: profile pin not found in ${PATCH_FILE}`)
  console.log('      add compat.vercelGatewayRouting.only: [deepseek] to the 1017 model, or the patch stays inert.')
}
process.exit(0)

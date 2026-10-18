#!/usr/bin/env node
/**
 * Keep cline-pass's in-history system-prompt flag alive across DSH upgrades.
 *
 * The flag lives in **two** places and both are needed:
 *
 *   1. `@deepseek-ai/dsh-llm-pi-ai/lib/index.js` — `COMPLETIONS_COMPAT_GATE` ships
 *      `supportsMidConvoSystemMessages: "withhold"`, which rejects the profile's
 *      `compat` block at config load (`PiAiCatalogError: not configurable here`).
 *      Patch it to `"offer"`.
 *   2. `cordis.patch.yml` — `cline-pass/deepseek-v4.1-flash`'s
 *      `compat.supportsMidConvoSystemMessages: true`. Without it the gate patch
 *      changes nothing.
 *
 * Why a script and not plugin code: the flag is consumed both by the config gate
 * and by pi-ai's transcript layer (the model object's `compat`), and no plugin
 * seam reaches either. It must be applied **before the service boots**; applying
 * it from `apply()` can be too late and would leave the YAML line pointing at an
 * unpatched gate (a hard boot failure).
 *
 * Usage:
 *   node patch-inhistory.mjs            # patch the gate (idempotent, keeps a backup)
 *   node patch-inhistory.mjs --check    # 0 = gate patched AND profile flag on
 *   node patch-inhistory.mjs --revert   # restore `withhold`; refuses while the
 *                                       # profile flag is on (use --force to override)
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

/** The completions gate pair: unique to COMPLETIONS_COMPAT_GATE. */
const WITHHOLD =
  '\tsupportsMidConvoSystemMessages: "withhold",\n\tsupportsMidConvoToolAdditions: "withhold",'
const OFFER =
  '\tsupportsMidConvoSystemMessages: "offer",\n\tsupportsMidConvoToolAdditions: "withhold",'
/** A real (non-comment) profile flag line. */
const PROFILE_FLAG = /^[ \t]*supportsMidConvoSystemMessages:[ \t]*true\b/mu

const argv = process.argv.slice(2)
const mode = argv.includes('--check') ? 'check' : argv.includes('--revert') ? 'revert' : 'apply'
const force = argv.includes('--force')

if (!fs.existsSync(TARGET)) {
  console.error(`patch-inhistory: target not found: ${TARGET}`)
  process.exit(2)
}

const source = fs.readFileSync(TARGET, 'utf8')
const withheld = source.split(WITHHOLD).length - 1
const offered = source.split(OFFER).length - 1

if (withheld + offered !== 1) {
  console.error(
    `patch-inhistory: expected exactly one COMPLETIONS_COMPAT_GATE pair, found withheld=${withheld} offered=${offered}.`,
  )
  console.error('The upstream shape changed; update the anchor in this script before patching.')
  process.exit(2)
}

const gatePatched = offered === 1
const profileOn = fs.existsSync(PATCH_FILE) && PROFILE_FLAG.test(fs.readFileSync(PATCH_FILE, 'utf8'))

if (mode === 'check') {
  console.log(`gate:    ${gatePatched ? 'patched (offer)' : 'withheld'}`)
  console.log(`profile: ${profileOn ? 'on (compat flag present)' : 'off (no compat flag)'}`)
  console.log(`target:  ${TARGET}`)
  if (gatePatched && profileOn) {
    console.log('verdict: active')
    process.exit(0)
  }
  console.log(
    gatePatched
      ? 'verdict: inactive — add compat.supportsMidConvoSystemMessages: true to the cline-pass model'
      : profileOn
        ? 'verdict: BROKEN — gate is withheld while the profile flag is on; the next boot will fail. Run without flags to patch.'
        : 'verdict: inactive — run this script, then add the profile flag',
  )
  process.exit(1)
}

if (mode === 'revert') {
  if (profileOn && !force) {
    console.error('patch-inhistory: refusing to revert while the profile compat flag is on.')
    console.error(`Remove the flag from ${PATCH_FILE} first (or pass --force and remove it before booting).`)
    process.exit(3)
  }
  if (!gatePatched) {
    console.log(`already withheld  ${TARGET}`)
    process.exit(0)
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backup = `${TARGET}.bak-inhistory-${stamp}`
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
  const backup = `${TARGET}.bak-inhistory-${stamp}`
  fs.copyFileSync(TARGET, backup)
  fs.writeFileSync(TARGET, source.replace(WITHHOLD, OFFER))
  console.log(`patched   ${TARGET}`)
  console.log(`backup    ${backup}`)
}
if (!profileOn) {
  console.log(`note: profile flag not found in ${PATCH_FILE}`)
  console.log('      add compat.supportsMidConvoSystemMessages: true to the cline-pass model, or the patch stays inert.')
}
process.exit(0)

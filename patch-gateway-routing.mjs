#!/usr/bin/env node
/**
 * Keep cline-pass's 1017 model pinned to the first-party DeepSeek provider
 * across DSH upgrades.
 *
 * The pin needs **four** places to agree, and all of them live outside the
 * plugin's reach:
 *
 *   1. `@deepseek-ai/dsh-llm-pi-ai/lib/index.js` — `COMPLETIONS_COMPAT_GATE`
 *      ships `vercelGatewayRouting: "withhold"`, which rejects the profile's
 *      `compat` block at config load (`PiAiCatalogError: not configurable here`).
 *      Patch that one line to `"offer"`.
 *   2. `@earendil-works/pi-ai/dist/providers/compat-schema.js` — the
 *      `VercelGatewayRoutingSchema` TypeBox object only declares `only` and
 *      `order`. `has` is the capability filter the gateway reads out of
 *      `providerOptions.gateway.has`; without a schema entry the profile's
 *      `has:` line is rejected or stripped before it can reach the request.
 *   3. `@earendil-works/pi-ai/dist/api/openai-completions.js` — the routing
 *      branch copies `only`/`order` into `params.providerOptions.gateway`.
 *      Extend it to carry `has` as well.
 *   4. `cordis.patch.yml` — the 1017 model's
 *      `compat.vercelGatewayRouting.{only: [deepseek], has: [...]}`. Without it
 *      the other three change nothing.
 *
 * Why `has` is load-bearing (measured 2026-10-30, README §上游钉选 and
 * clinepass-deepseek-audit §二十):
 *
 *   `providerOptions.gateway.has` is the switch that moves a request from the
 *   private/VMC route onto the public candidate route. With no `has` at all the
 *   gateway serves `openai-compatible-private` and **ignores `only` entirely**
 *   (2/2 runs). With `has`, `only`/`order` select among public candidates:
 *   `only` alone → private, `has` alone → fireworks, `has` + `only` → deepseek,
 *   native `provider_metadata.deepseek.systemFingerprint` present. Holds with
 *   tools + system prompt, streaming and non-streaming.
 *
 * Why a script and not plugin code: all four values are read by pi-ai from the
 * model object and by the config gate at boot. No plugin seam reaches either,
 * and the gate must be patched **before** the service boots — patching from
 * `apply()` would be too late and would leave the YAML line pointing at an
 * unpatched gate (a hard boot failure).
 *
 * Usage:
 *   node patch-gateway-routing.mjs            # apply every anchor (idempotent, keeps backups)
 *   node patch-gateway-routing.mjs --check    # 0 = all anchors patched AND profile pin on
 *   node patch-gateway-routing.mjs --revert   # restore upstream shape; refuses while the
 *                                             # profile pin is on (use --force to override)
 *
 * Environment: DSH_HOME (default ~/.dsh), DSH_PROFILE (default web).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = path.resolve(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
const PROFILE = process.env.DSH_PROFILE ?? 'web'
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE)
const NODE_MODULES = path.join(PROFILE_DIR, 'node_modules')
const PATCH_FILE = path.join(PROFILE_DIR, 'cordis.patch.yml')

const GATE_FILE = path.join(NODE_MODULES, '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js')
const SCHEMA_FILE = path.join(NODE_MODULES, '@earendil-works', 'pi-ai', 'dist', 'providers', 'compat-schema.js')
const WIRE_FILE = path.join(NODE_MODULES, '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-completions.js')

/** 1. The gate line, unique to COMPLETIONS_COMPAT_GATE. */
const GATE_WITHHOLD = '\tvercelGatewayRouting: "withhold",\n'
const GATE_OFFER = '\tvercelGatewayRouting: "offer",\n'

/**
 * 2. The `order` arm of VercelGatewayRoutingSchema, through the object/options
 * delimiter. `has` is inserted before the object closes.
 */
const SCHEMA_FROM = `        description: 'List of provider slugs to try in order, for example ["anthropic", "openai"].',
    })),
}, {
`
const SCHEMA_TO = `        description: 'List of provider slugs to try in order, for example ["anthropic", "openai"].',
    })),
    has: Type.Optional(Type.Array(Type.String(), {
        description: 'Capability tags a candidate must provide, for example ["vision", "implicit-caching"].',
    })),
}, {
`

/** 3. The wire branch that builds providerOptions.gateway for openai-completions. */
const WIRE_FROM = `        if (routing.only || routing.order) {
            const gatewayOptions = {};
            if (routing.only)
                gatewayOptions.only = routing.only;
            if (routing.order)
                gatewayOptions.order = routing.order;
            params.providerOptions = { gateway: gatewayOptions };
`
const WIRE_TO = `        if (routing.only || routing.order || routing.has) {
            const gatewayOptions = {};
            if (routing.only)
                gatewayOptions.only = routing.only;
            if (routing.order)
                gatewayOptions.order = routing.order;
            if (routing.has)
                gatewayOptions.has = routing.has;
            params.providerOptions = { gateway: gatewayOptions };
`

/** 4. The profile side: the 1017 model row, its pin, and the capability filter. */
const MODEL_FLAG = /^\s*-\s*id:\s*['"]?cline-pass\/deepseek-v4\.1-flash-1017['"]?\s*$/mu
const PIN_FLAG = /^\s*only:\s*(?:\[\s*)?(?:-\s*)?['"]?deepseek['"]?\s*\]?\s*$/mu
const HAS_FLAG = /^\s*has:\s*\[[^\]]*\]\s*$/mu

const ANCHORS = [
  { id: 'gate', label: 'pi-ai compat gate   (vercelGatewayRouting: offer)', file: GATE_FILE, from: GATE_WITHHOLD, to: GATE_OFFER },
  { id: 'schema', label: 'pi-ai compat schema (accepts `has`)', file: SCHEMA_FILE, from: SCHEMA_FROM, to: SCHEMA_TO },
  { id: 'wire', label: 'pi-ai wire          (emits `has`)', file: WIRE_FILE, from: WIRE_FROM, to: WIRE_TO },
]

const argv = process.argv.slice(2)
const mode = argv.includes('--check') ? 'check' : argv.includes('--revert') ? 'revert' : 'apply'
const force = argv.includes('--force')

/** Read one anchor's file and classify it. `shape-changed` is fatal, never guessed at. */
function inspect(anchor) {
  if (!fs.existsSync(anchor.file)) return { ...anchor, state: 'missing-file' }
  const source = fs.readFileSync(anchor.file, 'utf8')
  const patched = source.split(anchor.to).length - 1
  const pristine = source.split(anchor.from).length - 1
  const state = patched === 1 && pristine === 0 ? 'patched' : pristine === 1 && patched === 0 ? 'pristine' : 'shape-changed'
  return { ...anchor, state, source, patched, pristine }
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

function writeWithBackup(anchor, text) {
  const backup = `${anchor.file}.bak-gateway-routing-${stamp()}`
  fs.copyFileSync(anchor.file, backup)
  fs.writeFileSync(anchor.file, text)
  return backup
}

const anchors = ANCHORS.map(inspect)
const fatal = anchors.filter((a) => a.state === 'missing-file' || a.state === 'shape-changed')
if (fatal.length) {
  for (const a of fatal) {
    console.error(
      a.state === 'missing-file'
        ? `patch-gateway-routing: target not found: ${a.file}`
        : `patch-gateway-routing: ${a.file} matches neither the pristine nor the patched shape (from=${a.pristine}, to=${a.patched}).`,
    )
  }
  console.error('The upstream shape changed; update the anchor in this script before patching.')
  process.exit(2)
}

const profileText = fs.existsSync(PATCH_FILE) ? fs.readFileSync(PATCH_FILE, 'utf8') : ''
const modelOn = MODEL_FLAG.test(profileText)
const pinOn = PIN_FLAG.test(profileText)
const hasOn = HAS_FLAG.test(profileText)
const profileOn = modelOn && pinOn && hasOn
const anchorsOn = anchors.every((a) => a.state === 'patched')

if (mode === 'check') {
  for (const a of anchors) console.log(`${a.id.padEnd(7)} ${a.state === 'patched' ? 'patched ' : 'pristine'} ${a.label}`)
  console.log(
    `profile ${
      profileOn
        ? 'pinned (1017 model + only: [deepseek] + has: [...])'
        : modelOn
          ? `1017 model present, ${pinOn ? '' : 'only: [deepseek] missing, '}${hasOn ? '' : 'has: [...] missing'}`
          : pinOn
            ? 'only: [deepseek] present, 1017 model row missing'
            : 'absent (no 1017 model row, no only: [deepseek])'
    }`,
  )
  console.log(`target  ${PROFILE_DIR}`)
  if (anchorsOn && profileOn) {
    console.log('verdict: active')
    process.exit(0)
  }
  console.log(
    !anchorsOn
      ? 'verdict: inactive — run without flags, then restart dsh web (boot-time patch)'
      : 'verdict: inactive — add compat.vercelGatewayRouting.{only: [deepseek], has: [vision, implicit-caching]} to the 1017 model',
  )
  if (!profileOn) console.log('note: a patched pi-ai with an incomplete profile is inert — nothing gets pinned.')
  process.exit(1)
}

if (mode === 'revert') {
  if (profileOn && !force) {
    console.error('patch-gateway-routing: refusing to revert while the profile pin is on.')
    console.error(`Remove the 1017 pin from ${PATCH_FILE} first (or pass --force and remove it before booting).`)
    process.exit(3)
  }
  let reverted = 0
  for (const a of anchors) {
    const current = inspect(a)
    if (current.state === 'pristine') {
      console.log(`already pristine  ${a.file}`)
      continue
    }
    const backup = writeWithBackup(a, current.source.replace(a.to, a.from))
    console.log(`reverted          ${a.file}`)
    console.log(`backup            ${backup}`)
    reverted++
  }
  console.log(reverted ? `reverted ${reverted} anchor(s); restart dsh web before the next boot.` : 'nothing to revert.')
  process.exit(0)
}

let changed = 0
for (const a of anchors) {
  const current = inspect(a)
  if (current.state === 'patched') {
    console.log(`already patched   ${a.file}`)
    continue
  }
  const backup = writeWithBackup(a, current.source.replace(a.from, a.to))
  console.log(`patched           ${a.file}`)
  console.log(`backup            ${backup}`)
  changed++
}
if (changed) console.log('restart dsh web — every anchor here is boot-time.')
if (!profileOn) {
  console.log(`note: profile pin incomplete in ${PATCH_FILE}`)
  console.log('      add compat.vercelGatewayRouting.only: [deepseek] + has: [vision, implicit-caching]')
  console.log('      to the 1017 model, or the patch stays inert.')
}
process.exit(0)

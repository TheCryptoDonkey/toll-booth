// src/init.ts — scaffold a new toll-booth project

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { TemplateContext } from './init-prompts.js'
import type { Framework, Backend } from './init-prompts.js'
import type { GeneratedProject } from './templates/shared.js'
import { parseCliFlags, runInteractivePrompt, buildTemplateContext } from './init-prompts.js'
import { generateExpressPhoenixd } from './templates/express-phoenixd.js'
import { generateHonoCashu } from './templates/hono-cashu.js'
import { generateDenoLnd } from './templates/deno-lnd.js'
import { generateExpressNwc } from './templates/express-nwc.js'
import { generateGeneric } from './templates/generic.js'

/**
 * Select the appropriate template generator for the given framework + backend combination.
 * Golden-path combos get dedicated templates; everything else falls back to generic.
 */
export function selectTemplate(
  framework: Framework,
  backend: Backend,
): (ctx: TemplateContext) => GeneratedProject {
  if (framework === 'express' && backend === 'phoenixd') return generateExpressPhoenixd
  if (framework === 'hono' && backend === 'cashu-only') return generateHonoCashu
  if (framework === 'deno' && backend === 'lnd') return generateDenoLnd
  if (framework === 'express' && backend === 'nwc') return generateExpressNwc
  return generateGeneric
}

/**
 * Parse the --output flag from process.argv (not part of InitConfig).
 */
function parseOutputFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output' && argv[i + 1] !== undefined) {
      return argv[i + 1]
    }
  }
  return undefined
}

/**
 * Write generated project files to the output directory.
 * Creates the directory if it does not exist. Throws if the directory
 * already exists and contains files (to avoid overwriting user work).
 */
export function writeProject(outputDir: string, project: GeneratedProject): void {
  if (fs.existsSync(outputDir)) {
    const existing = fs.readdirSync(outputDir)
    if (existing.length > 0) {
      throw new Error(`Directory "${outputDir}" already exists and is not empty.`)
    }
  } else {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  for (const [relativePath, content] of Object.entries(project.files)) {
    const fullPath = path.join(outputDir, relativePath)
    const dir = path.dirname(fullPath)

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(fullPath, content, 'utf-8')
  }
}

/**
 * Format the success message printed after project creation.
 */
export function formatSuccessMessage(projectName: string, outputDir: string, isDeno: boolean): string {
  const relativeDir = outputDir.startsWith('/') || outputDir.startsWith('~')
    ? outputDir
    : `./${projectName}`

  const lines = [
    '',
    `\u2713 Project created in ${relativeDir}`,
    '',
    'Next steps:',
    `  cd ${projectName}`,
    '  cp .env.example .env    # fill in your credentials',
  ]

  if (isDeno) {
    lines.push('  deno task start')
  } else {
    lines.push('  npm install')
    lines.push('  npm start')
  }

  lines.push('')
  return lines.join('\n')
}

export async function runInit(): Promise<void> {
  try {
    // 1. Parse CLI flags
    const flags = parseCliFlags(process.argv.slice(3))

    // 2. Run interactive prompt for any missing values
    const config = await runInteractivePrompt(flags)

    // 3. Build template context
    const ctx = buildTemplateContext(config)

    // 4. Select template
    const template = selectTemplate(config.framework, config.backend)

    // 5. Generate project files
    const project = template(ctx)

    // 6. Determine output directory
    const outputFlag = parseOutputFlag(process.argv.slice(3))
    const outputDir = outputFlag ?? `./${config.projectName}`

    // 7. Write files
    writeProject(outputDir, project)

    // 8. Print success message
    const isDeno = config.framework === 'deno'
    console.log(formatSuccessMessage(config.projectName, outputDir, isDeno))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Error: ${message}`)
    process.exit(1)
  }
}

/**
 * hook-shell-template.ts — Rule A: host-managed defensive shell-template
 * generator (single source of truth).
 *
 * See `CLAUDE.md` → "Spawn-Contract Resolution". The host-owned config files
 * (`plugin/hooks/hooks.json`, `plugin/hooks/codex-hooks.json`,
 * `plugin/.mcp.json`) embed a defensive POSIX-shell prelude that resolves the
 * plugin root from `${CLAUDE_PLUGIN_ROOT}` (or `${PLUGIN_ROOT}`), then falls
 * back through the host cache directories and the marketplace install dir.
 * Some host versions / cache rotations do NOT inject `CLAUDE_PLUGIN_ROOT`, so
 * the fallback chain is load-bearing (issues #1215, #1533).
 *
 * This module emits those command strings from ONE place so the shape can't
 * drift between the three files. `tests/infrastructure/plugin-distribution.test.ts`
 * asserts the hand-maintained files match the generator output byte-for-byte.
 *
 * The fallback chain ORDER is contractual and must not change:
 *   1. ${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}   (host-injected env)
 *   2. (mcp only) $PWD/plugin, $PWD               (repo/dev checkout)
 *   3. cache directories (newest first via `ls -dt`)
 *   4. $_C/plugins/marketplaces/thedotmack/plugin (marketplace install)
 */

export type ShellTemplateHost = 'claude-code' | 'claude-code-setup' | 'codex-cli' | 'mcp';

export interface ShellTemplateOptions {
  /** Host whose spawn contract / PATH prelude applies. */
  host: ShellTemplateHost;
  /** Script that must exist under `<root>/scripts/` for the root to count. */
  requireFile: string;
  /** Optional second required script (hooks needing bun-runner.js AND worker-service.cjs). */
  requireFileSecondary?: string;
  /**
   * Trailing command tokens run after `_P` resolves. Tokens are emitted
   * verbatim (callers pass already-quoted `"$_P/scripts/X"` forms), matching
   * the hand-authored files.
   */
  trailingCommand: string[];
  /** Extra env exports prepended to the trailing command (e.g. CLAUDE_MEM_CODEX_HOOK=1). */
  extraEnv?: Record<string, string>;
  /** Optional trailing JSON echoed after the command (e.g. SessionStart continue marker). */
  trailingJson?: object;
  /** stderr message when no candidate root resolves. */
  notFoundMessage: string;
  /**
   * MCP-only: extra candidate roots enumerated before the cache directories
   * (e.g. '$PWD/plugin', '$PWD'). Ignored for non-mcp hosts.
   */
  mcpExtraCandidates?: string[];
  /**
   * MCP-only: additional cache roots tried (newest first) BEFORE the Claude
   * cache root (e.g. Codex caches). Each entry is the cache root WITHOUT the
   * version-glob suffix (/[0-9]asterisk/), which the generator appends
   * uniformly. Ignored for non-mcp hosts.
   */
  mcpExtraCacheRoots?: string[];
}

const CLAUDE_CODE_PATH_PRELUDE = `export PATH="$($SHELL -lc 'echo $PATH' 2>/dev/null):$PATH";`;

const CLAUDE_CODE_SETUP_PATH_PRELUDE =
  'export PATH="$HOME/.nvm/versions/node/v$(ls \\"$HOME/.nvm/versions/node\\" 2>/dev/null | ' +
  "sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)/bin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH\";";

const CODEX_CLI_PATH_PRELUDE =
  `_HP=$(printenv PATH 2>/dev/null || true); ` +
  `if [ -z "$_HP" ] && [ -n "\${SHELL:-}" ]; then _HP=$("$SHELL" -lc 'printf %s "$PATH"' 2>/dev/null || true); fi; ` +
  `_HP=$(printf '%s' "$_HP" | tr ' ' ':'); export PATH="\${_HP:+$_HP:}$PATH"; `;

function pathPrelude(host: ShellTemplateHost): string {
  switch (host) {
    case 'claude-code':
      return CLAUDE_CODE_PATH_PRELUDE;
    case 'claude-code-setup':
      return CLAUDE_CODE_SETUP_PATH_PRELUDE;
    case 'codex-cli':
      // Trailing space is intentional: join() adds one more → double space
      // before `_C=`, matching the hand-authored codex-hooks.json.
      return CODEX_CLI_PATH_PRELUDE;
    case 'mcp':
      return '';
  }
}

function fileExistsClause(options: ShellTemplateOptions): string {
  const primary = `[ -f "$_Q/scripts/${options.requireFile}" ]`;
  if (options.requireFileSecondary) {
    return `${primary} && [ -f "$_Q/scripts/${options.requireFileSecondary}" ]`;
  }
  return primary;
}

/**
 * Build the candidate-enumeration block. The `{ ...; }` subshell prints one
 * candidate root per line in priority order; the `while` loop picks the first
 * whose `scripts/<requireFile>` exists.
 */
function candidateBlock(options: ShellTemplateOptions): string {
  // MCP no longer reaches this block (it uses buildMcpNodeLauncher); the
  // remaining POSIX-shell hosts share one candidate-enumeration shape.
  const lines: string[] = [`[ -n "$_E" ] && printf '%s\\n' "$_E";`];

  const allGlobs = `"$_C/plugins/cache/thedotmack/claude-mem"/[0-9]*/`;
  lines.push(`ls -dt ${allGlobs} 2>/dev/null;`);
  lines.push(`printf '%s\\n' "$_C/plugins/marketplaces/thedotmack/plugin";`);

  const trimAssignment = ' _R="${_R%/}";';
  const fileClause = fileExistsClause(options);

  return (
    `_P=$({ ${lines.join(' ')} } | while IFS= read -r _R; do` +
    `${trimAssignment} [ -d "$_R/plugin/scripts" ] && _Q="$_R/plugin" || _Q="$_R"; ` +
    `${fileClause} && { printf '%s\\n' "$_Q"; break; }; done);`
  );
}

const CYGPATH_CLAUSE =
  `command -v cygpath >/dev/null 2>&1 && { _W=$(cygpath -w "$_P" 2>/dev/null); [ -n "$_W" ] && _P="$_W"; };`;

/**
 * Translate a shell-style path spec into the equivalent Node `path` expression
 * used inside the MCP launcher: `$PWD` → `d`, `$PWD/plugin` → `p.join(d,'plugin')`,
 * `$HOME/a/b` → `p.join(h,'a/b')`, `$_C/a/b` → `p.join(C,'a/b')`.
 */
function nodePathExpr(spec: string): string {
  const [head, ...rest] = spec.split('/');
  const base = head === '$PWD' ? 'd' : head === '$HOME' ? 'h' : head === '$_C' ? 'C' : head;
  const sub = rest.join('/');
  return sub ? `p.join(${base},'${sub}')` : base;
}

/**
 * MCP (since #2461) launches under a portable Node inline script instead of
 * `sh -c`, so hosts without a POSIX shell (Windows) can still spawn the server.
 * This emits that launcher — the single source of truth for the `mcp-search`
 * `args[1]` string in plugin/.mcp.json. The candidate-root fallback chain
 * mirrors the POSIX-shell hosts: env root → $PWD candidates → cache dirs
 * (newest first) → marketplace install. `trailingCommand` is shell-only and
 * unused here; the server script is taken from `requireFile`.
 */
function buildMcpNodeLauncher(options: ShellTemplateOptions): string {
  const server = options.requireFile;
  const candidates = (options.mcpExtraCandidates ?? []).map(nodePathExpr);
  const cacheRoots = [
    ...(options.mcpExtraCacheRoots ?? []),
    '$_C/plugins/cache/thedotmack/claude-mem',
  ].map((root) => `...L(${nodePathExpr(root)})`);
  const marketplace = nodePathExpr('$_C/plugins/marketplaces/thedotmack/plugin');
  const candidateList = ['E', ...candidates, ...cacheRoots, marketplace].join(',');

  return (
    `const f=require('fs'),p=require('path'),o=require('os'),c=require('child_process');` +
    `const h=o.homedir();` +
    `const C=process.env.CLAUDE_CONFIG_DIR||p.join(h,'.claude');` +
    `const E=process.env.CLAUDE_PLUGIN_ROOT||process.env.PLUGIN_ROOT||'';` +
    `const d=process.cwd();` +
    `const L=x=>{try{return f.readdirSync(x).filter(n=>/^\\d/.test(n)).map(n=>p.join(x,n)).filter(z=>{try{return f.statSync(z).isDirectory()}catch{return false}}).sort((a,b)=>f.statSync(b).mtimeMs-f.statSync(a).mtimeMs)}catch{return[]}};` +
    `const K=[${candidateList}].filter(Boolean);` +
    `let R=null;for(const k of K){const r=f.existsSync(p.join(k,'plugin','scripts'))?p.join(k,'plugin'):k;if(f.existsSync(p.join(r,'scripts','${server}'))){R=r;break}}` +
    `if(!R){process.stderr.write('${options.notFoundMessage}\\n');process.exit(1)}` +
    `const ch=c.spawn(process.execPath,[p.join(R,'scripts','${server}')],{stdio:'inherit'});` +
    `for(const s of ['SIGTERM','SIGINT','SIGHUP'])process.on(s,()=>{try{ch.kill(s)}catch{}});` +
    `ch.on('exit',(code,sig)=>{if(sig){process.removeAllListeners(sig);try{process.kill(process.pid,sig)}catch{process.exit(0)}}else process.exit(code==null?0:code)})`
  );
}

/**
 * Build the full single-line command string for a Rule A site. POSIX-shell
 * hosts get the defensive shell prelude; MCP gets a portable Node launcher
 * (see buildMcpNodeLauncher). Output is byte-compatible with the hand-authored
 * command strings in the host-managed config files.
 */
export function buildShellCommand(options: ShellTemplateOptions): string {
  if (options.host === 'mcp') {
    return buildMcpNodeLauncher(options);
  }

  const parts: string[] = [];

  // The PATH prelude is pushed verbatim (including any trailing space). `parts`
  // are later joined with a single space, so claude-code preludes (no trailing
  // space) get one separator space, while the codex prelude (one trailing
  // space) gets two — matching the hand-authored files exactly.
  const prelude = pathPrelude(options.host);
  if (prelude) parts.push(prelude);

  parts.push('_C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}";');
  parts.push('_E="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}";');
  parts.push(candidateBlock(options));
  parts.push(`[ -n "$_P" ] || { echo "${options.notFoundMessage}" >&2; exit 1; };`);

  // cygpath conversion for the POSIX-shell hosts (claude-code + codex-cli).
  // MCP returned early above, so every host reaching here needs it.
  parts.push(CYGPATH_CLAUSE);

  const envPrefix = options.extraEnv
    ? Object.entries(options.extraEnv)
        .map(([key, value]) => `${key}=${value} `)
        .join('')
    : '';

  let command = `${envPrefix}${options.trailingCommand.join(' ')}`;
  if (options.trailingJson) {
    command += `; echo '${JSON.stringify(options.trailingJson)}'`;
  }
  parts.push(command);

  return parts.join(' ');
}

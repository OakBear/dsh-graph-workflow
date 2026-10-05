// Build the browser bundle: wrap client-src.js in the ModuleLoader factory.
//
// Output: dist/client.js — one file whose only external dependency is `react`,
// resolved through the loader's `require`. The plugin id MUST equal the package
// name, because the host pairs the loaded module with the mounted plugin row by
// that id.
//
// `client-src.js` is the merge of the two upstream client halves
// (dsh-session-graph's Git-graph tab + dsh-agent-workflow's Workflow tab) into
// one module with one `apply(ctx)`. It is kept as a build input rather than
// pre-wrapped so the layout logic stays diffable and testable.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
const id = pkg.name

const src = readFileSync(`${root}client-src.js`, 'utf8')

// Guard: `exports.inject` and `dsh.client.inject` are DIFFERENT namespaces.
//   - `exports.inject`  = cordis SERVICE names the client half needs at runtime
//                         (e.g. 'betterSidebar', 'slots', 'timer').
//   - `dsh.client.inject` = PACKAGE ids the client module loader must load first
//                         (e.g. 'dsh-better-sidebar').
// So they are not comparable entry-for-entry; what matters is that every
// non-core service the client requires is provided by a package we declare.
const clientInject = (() => {
  const literal = /var\s+inject\s*=\s*(\[[^\]]*\])/.exec(src)
  if (literal) return JSON.parse(literal[1].replace(/'/g, '"'))
  const byId = /exports\.inject\s*=\s*([A-Za-z_$][\w$]*)\s*;?/.exec(src)
  if (!byId) return null
  const own = new RegExp('var\\s+' + byId[1] + '\\s*=\\s*(\\[[^\\]]*\\])').exec(src)
  return own ? JSON.parse(own[1].replace(/'/g, '"')) : null
})()
if (!clientInject) {
  console.error('build: client-src.js must export an `inject` list')
  process.exit(1)
}

const declared = (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || []
if (declared.length === 0) {
  console.error('build: package.json must declare dsh.client.inject')
  process.exit(1)
}
// `betterSidebar` is the only service here provided by a third-party package
// rather than by the web-app shell, so it is the one that must be declared.
if (clientInject.includes('betterSidebar') && !declared.includes('dsh-better-sidebar')) {
  console.error('build: the client requires the betterSidebar service, so package.json must declare "dsh-better-sidebar" in dsh.client.inject')
  process.exit(1)
}

// Guard: `exports.apply`/`exports.inject` must exist, or the host loads a module
// with nothing to mount.
for (const required of ['exports.inject', 'exports.apply']) {
  if (!src.includes(required)) {
    console.error('build: client-src.js is missing ' + required)
    process.exit(1)
  }
}

const out = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${src}
    return module.exports;
  }
});
`

mkdirSync(`${root}dist`, { recursive: true })
writeFileSync(`${root}dist/client.js`, out)
writeFileSync(`${root}client.js`, out)
console.log('client.js + dist/client.js written:', (out.length / 1024).toFixed(1), 'KiB', '(id: ' + id + ')')

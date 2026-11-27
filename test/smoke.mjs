// 安装前的冒烟测试：用假的 ctx 驱动真实的 lib/index.mjs，不需要 DSH。
// 用法：node smoke.mjs 8789
import http from 'node:http'
import { apply, name } from '../lib/index.mjs'

const port = Number(process.argv[2] || 8789)
const routes = new Map()

const ctx = {
  inject(deps, cb) {
    cb({
      effect(fn) { fn() },
      webServer: {
        register(r) {
          routes.set(r.path, r.handler)
          return () => routes.delete(r.path)
        }
      }
    })
  }
}

apply(ctx)
console.log('plugin name =', name, '| routes =', [...routes.keys()].join(', '))

// 定编口径的自检：这些断言错了比路由 404 更隐蔽
const { computeQuota } = await import('../lib/index.mjs').catch(() => ({}))
if (computeQuota) {
  const cases = [
    { q: { tasks: 2, directions: 2, want_worker: 1, want_verifier: 1 }, expect: { worker: 1, verifier: 1 } },
    { q: { tasks: 6, directions: 2, want_worker: 2 }, expect: { worker: 2, verifier: 2 } },
    { q: { tasks: 12, directions: 3, want_worker: 5 }, expect: { worker: 3, verifier: 2 } },
    { q: { tasks: 1 }, expect: { worker: 1, verifier: 1 } },
    { q: { tasks: 99 }, expectFail: true }
  ]
  let bad = 0
  for (const c of cases) {
    const r = computeQuota(c.q)
    if (c.expectFail) {
      if (r.ok !== false) { bad++; console.log('FAIL expect reject', JSON.stringify(c.q), JSON.stringify(r.granted)) }
      continue
    }
    for (const k of Object.keys(c.expect)) {
      if (r.granted?.[k] !== c.expect[k]) {
        bad++
        console.log('FAIL', JSON.stringify(c.q), k, 'expected', c.expect[k], 'got', r.granted?.[k], r.notes)
      }
    }
  }
  console.log('quota self-check:', bad === 0 ? 'OK' : bad + ' failed')
}


http.createServer(async (req, res) => {
  const path = req.url.split('?')[0]
  const h = routes.get(path)
  if (!h) { res.writeHead(404); res.end('no route: ' + path); return }
  try { await h(req, res) } catch (e) { res.writeHead(500); res.end('handler error: ' + e.message) }
}).listen(port, '127.0.0.1', () => console.log('smoke on http://127.0.0.1:' + port + '/dsh-formation'))

// /reserve <percent> [five_hour|seven_day]  reserve the top of the window for this session
// /reserve                                  show the reserve
// /reserve off                              release it
//
// Account-wide plan usage is the same number in every session, so the reserve is a line
// at (100 - percent). Sessions other than the reserved one stop at that line.

const KEY = 'reserve'
const WINDOWS = ['five_hour', 'seven_day']
const WINDOW_LABEL = { five_hour: '5-hour', seven_day: '7-day' }
// A reserve whose session has not checked in for this long is ignored (crash, closed app)
const STALE_MS = 15 * 60_000
const HEARTBEAT_MS = 60_000

let turnId = null

async function liveReserve($) {
  const r = await $.store.get(KEY)
  if (!r) return null
  const now = await $.clock.now()
  return now - r.lastSeen > STALE_MS ? null : r
}

async function percentUsed($, window) {
  const usage = await $.session.usage()
  return usage.rateLimits.find((l) => l.kind === window)?.percentUsed
}

// The reason this session must stop, or null when it may continue
async function blockReason($, myId) {
  const r = await liveReserve($)
  if (!r || r.sessionId === myId) return null
  const used = await percentUsed($, r.window)
  const line = 100 - r.percent
  if (used === undefined || used < line) return null
  return (
    'Token reserve reached: the ' + WINDOW_LABEL[r.window] + ' window is at ' + used + '% and the last ' +
    r.percent + '% is reserved for another session (' + (r.title || r.sessionId.slice(0, 8)) + '). ' +
    'Run /reserve off there to release it.'
  )
}

async function refreshStatus($, myId) {
  const r = await liveReserve($)
  if (!r) return $.ui.status(undefined)
  const used = await percentUsed($, r.window)
  const now = used === undefined ? 'n/a' : used + '%'
  if (r.sessionId === myId) {
    $.ui.status('reserve: last ' + r.percent + '% of ' + WINDOW_LABEL[r.window] + ' window is yours (now ' + now + ')')
  } else {
    $.ui.status('this session stops at ' + (100 - r.percent) + '% of ' + WINDOW_LABEL[r.window] + ' window (now ' + now + ')')
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const myId = await $.session.id()
    // Reserved session checks in so others can tell it is still alive
    $.clock.every(HEARTBEAT_MS, async () => {
      const r = await $.store.get(KEY)
      if (r && r.sessionId === myId) await $.store.set(KEY, { ...r, lastSeen: await $.clock.now() })
      await refreshStatus($, myId)
    })
    await $.command.register({
      name: 'reserve',
      description: 'Reserve the top of your usage window for this session',
      argumentHint: '<percent> [five_hour|seven_day] | off',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'reserve' }, async ($, e) => {
    const myId = await $.session.id()
    const args = (e.args || '').trim().split(/\s+/).filter(Boolean)

    if (args[0] === 'off') {
      const r = await $.store.get(KEY)
      if (r && r.sessionId === myId) await $.store.delete(KEY)
      await refreshStatus($, myId)
      return { text: r && r.sessionId === myId ? 'Reserve released.' : 'This session holds no reserve.' }
    }

    if (args.length === 0) {
      const r = await liveReserve($)
      if (!r) return { text: 'No reserve. Use /reserve <percent> in the session you want to protect.' }
      const used = await percentUsed($, r.window)
      return {
        text:
          'Reserve: last ' + r.percent + '% of the ' + WINDOW_LABEL[r.window] + ' window → ' +
          (r.sessionId === myId ? 'this session' : r.title || r.sessionId.slice(0, 8)) +
          '. Other sessions stop at ' + (100 - r.percent) + '%. Window now at ' + (used ?? 'n/a') + '%.',
      }
    }

    const percent = Number(args[0])
    const window = args[1] || 'five_hour'
    if (!(percent > 0 && percent < 100) || !WINDOWS.includes(window)) {
      return { text: 'Usage: /reserve <percent 1-99> [five_hour|seven_day] | off' }
    }
    const existing = await liveReserve($)
    if (existing && existing.sessionId !== myId) {
      return { text: 'Another session already holds a reserve. Run /reserve off there first.' }
    }
    const used = await percentUsed($, window)
    if (used === undefined) {
      return { text: 'No plan usage reading yet (needs a subscription and one response). Try again after a turn.' }
    }
    await $.store.set(KEY, {
      sessionId: myId,
      title: (await $.session.cwd()).split('/').pop(),
      percent,
      window,
      lastSeen: await $.clock.now(),
    })
    await refreshStatus($, myId)
    const warn = used >= 100 - percent ? ' The window is already past that line, so other sessions are blocked now.' : ''
    return { text: 'Reserved the last ' + percent + '% of the ' + WINDOW_LABEL[window] + ' window for this session. Other sessions stop at ' + (100 - percent) + '%.' + warn }
  })

  // New prompts in other sessions are refused at the line
  on('prompt.submit', async ($, e, next) => {
    const reason = await blockReason($, await $.session.id())
    if (!reason) return next(e)
    $.ui.toast(reason, { timeoutMs: 10000 })
    return { drop: reason }
  })

  // A turn already running is stopped at its next tool call
  on('tool.call', async ($, e, next) => {
    const reason = await blockReason($, await $.session.id())
    if (!reason) return next(e)
    return { deny: reason + ' Stop and tell the user.' }
  })

  on('turn.start', async ($, e, next) => {
    turnId = e.turnId
    return next(e)
  })

  // Usage moved: abort a running turn that crossed the line, and keep the status line current
  on('session.measure', async ($, e, next) => {
    const myId = await $.session.id()
    const reason = await blockReason($, myId)
    if (reason && turnId) {
      $.ui.toast(reason, { timeoutMs: 10000 })
      $.ui.log(reason)
      await $.turn.abort({ turnId })
    }
    await refreshStatus($, myId)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) turnId = null
    return next(e)
  })

  // Give the reserve back when the reserved session ends
  on('session.end', async ($, e, next) => {
    const r = await $.store.get(KEY)
    if (r && r.sessionId === (await $.session.id())) await $.store.delete(KEY)
    return next(e)
  })
}

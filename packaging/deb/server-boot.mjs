// boot.mjs - entry point wrapper that keeps the server from outliving its
// launcher.
//
// The shell (the Electron desktop app, or /usr/bin/hot-step-server) starts this
// file and then the server. Both of those handle SIGTERM and SIGINT properly
// and shut the engine down on the way out. Neither can handle being SIGKILLed
// though, and on X11 killing a window client with XKillClient does exactly
// that. The result is an orphaned Node server still listening on 3001 with an
// ace-server child holding VRAM, and no UI to reach it by.
//
// There is no in-process handler that can catch that, so the check lives here:
// process.ppid changes to 1 the moment the parent dies and the kernel
// reparents this process to init. Poll for that and shut down.
//
// Deliberately dependency-free and side-effect-free otherwise: it registers the
// watchdog and then hands straight over to the real bundle, which computes its
// own paths from its own file location, so wrapping it changes nothing about
// how the server finds ui/dist, server/data or the engine.
//
// Usage: runtime/bin/node server/boot.mjs

'use strict';

const parentPid = process.ppid;
const POLL_MS = 3000;
const GRACE_MS = 8000;   // longer than the server's own shutdown budget

let shuttingDown = false;

const watchdog = setInterval(() => {
  if (process.ppid === parentPid) return;
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(watchdog);

  console.error(
    `[boot] launcher (pid ${parentPid}) is gone - shutting the server down`,
  );

  // Ask ourselves to stop, exactly as if the user had sent SIGTERM, so the
  // server's own handlers close the database and terminate the engine.
  process.kill(process.pid, 'SIGTERM');

  // If the graceful path wedges (a stuck SQLite handle, an engine that will
  // not die), stop waiting.
  setTimeout(() => process.exit(0), GRACE_MS);
}, POLL_MS);

// Do not hold the event loop open on our own account if the server ever exits
// on its own.
watchdog.unref?.();

await import('./server.mjs');
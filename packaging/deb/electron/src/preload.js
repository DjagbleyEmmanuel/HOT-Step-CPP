// preload.js - runs in the isolated context before the UI loads.
//
// The app's own bundle is served by the local Node server and talks to it over
// same-origin fetch, so it needs nothing from Node. This file exists to keep
// nodeIntegration off and contextIsolation on without the UI noticing a
// difference from a browser tab.

'use strict';

const { contextBridge } = require('electron');

// A couple of read-only facts the UI can use to tell it is running inside the
// desktop shell rather than a plain browser window.
contextBridge.exposeInMainWorld('hotStepDesktop', {
  desktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
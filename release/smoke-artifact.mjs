// Windows archive gate. See smoke-artifact.md for usage and retained evidence.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const contained = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

// All spawned commands have a deadline and a finally block that reaps their tree.
// On Windows even node's direct child can have children (smoke-boot -> server).
export async function withProcess(exe, args, options, timeoutMs, logFile, action) {
  const log = fs.openSync(logFile, 'a');
  const child = spawn(exe, args, { ...options, windowsHide: true, stdio: ['ignore', log, log] });
  let outcome;
  const closed = new Promise(resolve => {
    child.once('error', error => { outcome = { error }; resolve(); });
    child.once('close', (code, signal) => { outcome = { code, signal }; resolve(); });
  });
  let timer;
  let interrupt;
  const interrupted = new Promise((_, reject) => {
    interrupt = () => reject(new Error(`Interrupted while running ${exe}`));
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
  });
  try {
    return await Promise.race([
      action({ child, closed, outcome: () => outcome }),
      interrupted,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms: ${exe}`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    let reapTimer;
    try {
      if (!outcome && child.pid) {
        if (process.platform === 'win32') {
          await new Promise((resolve, reject) => {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            const killTimer = setTimeout(() => { killer.kill(); reject(new Error(`taskkill timed out for PID ${child.pid}`)); }, 10000);
            killer.once('error', error => { clearTimeout(killTimer); reject(error); });
            killer.once('close', () => { clearTimeout(killTimer); resolve(); });
          });
        } else {
          child.kill('SIGKILL');
        }
      }
      // close must be observed; a successful signal alone is not cleanup proof.
      await Promise.race([closed, new Promise((_, reject) => { reapTimer = setTimeout(() => reject(new Error(`PID ${child.pid} was not reaped`)), 5000); })]);
    } finally {
      clearTimeout(reapTimer);
      fs.closeSync(log);
    }
  }
}

export async function runCommand(exe, args, options, timeoutMs, logFile) {
  return withProcess(exe, args, options, timeoutMs, logFile, async state => {
    await state.closed;
    const result = state.outcome();
    if (result.error) throw result.error;
    if (result.code !== 0) throw new Error(`${path.basename(exe)} exited ${result.code} (signal ${result.signal}); see ${logFile}`);
  });
}

export function writeStubs(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
  const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
  const string = value => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
  for (const arch of ['acestep-lm', 'acestep-dit', 'acestep-text-enc', 'acestep-vae']) {
    fs.writeFileSync(path.join(directory, `stub-${arch}.gguf`), Buffer.concat([
      Buffer.from('GGUF'), u32(3), u64(0), u64(1), string('general.architecture'), u32(8), string(arch),
    ]));
  }
}

export async function smokeEngine(exe, root, models, env, logFile, timeoutMs = 60000, prefixArgs = []) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  await withProcess(exe, [...prefixArgs, '--models', models, '--host', '127.0.0.1', '--port', String(port)],
    { cwd: root, env }, timeoutMs, logFile, async state => {
      const assertAlive = () => {
        const result = state.outcome();
        if (result) throw new Error(`Engine exited before smoke completed: ${JSON.stringify(result)}; see ${logFile}`);
      };
      const get = async endpoint => {
        const response = await fetch(`${base}/${endpoint}`, { signal: AbortSignal.timeout(2000) });
        if (!response.ok) throw new Error(`GET /${endpoint}: HTTP ${response.status}`);
        // Drain the body under the same request deadline.
        return response.text();
      };
      for (;;) {
        assertAlive();
        try { await get('health'); break; } catch { /* bounded by the process deadline */ }
        await delay(100);
      }
      for (const endpoint of ['health', 'props', 'plugins', 'props']) {
        assertAlive();
        const body = await get(endpoint);
        fs.appendFileSync(logFile, `\nGET /${endpoint}: ${body}\n`);
      }
      await delay(2000);
      assertAlive();
    });
}

export async function smokeArtifact(zipArg, { outputParent = os.tmpdir(), timeoutMs = 60000 } = {}) {
  if (process.platform !== 'win32') throw new Error('This gate requires Windows and the packaged Windows runtime');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000) throw new Error('timeoutMs must be 100..600000');
  const zip = path.resolve(zipArg);
  if (!fs.statSync(zip).isFile()) throw new Error(`Not an archive: ${zip}`);
  const parent = fs.realpathSync(outputParent);
  const checkout = fs.realpathSync(path.join(here, '..'));
  if (contained(checkout, parent)) throw new Error('Extraction directory must be outside the checkout');
  const work = fs.mkdtempSync(path.join(parent, 'hotstep-artifact-'));
  const root = path.join(work, 'HOT Step smoke');
  const evidence = { zip, root, status: 'running' };
  const report = () => fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(`smoke-artifact: evidence ${work}`);
  report();
  try {
    await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:HOTSTEP_SMOKE_ZIP, $env:HOTSTEP_SMOKE_DEST)'],
    { env: { ...process.env, HOTSTEP_SMOKE_ZIP: zip, HOTSTEP_SMOKE_DEST: root } }, 120000, path.join(work, 'extract.log'));
    for (const file of ['runtime/node.exe', 'server/server.mjs', 'engine/ace-server.exe']) {
      if (!fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()) throw new Error(`Archive is missing ${file}`);
    }
    const temp = path.join(work, 'temp');
    fs.mkdirSync(temp);
    const env = { ...process.env, TEMP: temp, TMP: temp,
      HOT_STEP_ROOT: root, HOT_STEP_DATA_ROOT: path.join(work, 'data'), HOT_STEP_PROFILE_DIR: path.join(work, 'profile'),
      // Do not let a developer's DLL search paths mask an incomplete package.
      PATH: `${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')};${process.env.SystemRoot || 'C:\\Windows'}`,
    };
    await runCommand(path.join(root, 'runtime/node.exe'), [path.join(here, 'smoke-boot.mjs'), path.join(root, 'server/server.mjs'), String(timeoutMs / 1000)],
      { cwd: root, env }, timeoutMs + 10000, path.join(work, 'server.log'));
    evidence.server = 'pass';
    const models = path.join(work, 'stub-models');
    writeStubs(models);
    await smokeEngine(path.join(root, 'engine/ace-server.exe'), root, models, env, path.join(work, 'engine.log'), timeoutMs);
    evidence.engine = 'pass';
    evidence.status = 'pass';
    console.log('smoke-artifact: PASS - extracted portable server and engine endpoints');
    return work;
  } catch (error) {
    evidence.status = 'fail';
    evidence.error = error.message;
    throw error;
  } finally {
    report(); // Keep the extraction, isolated state and logs on both outcomes.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [zip, parent, seconds = '60', ...extra] = process.argv.slice(2);
  if (!zip || extra.length) {
    console.error('Usage: node release/smoke-artifact.mjs <windows.zip> [output-parent] [timeout-seconds]');
    process.exitCode = 2;
  } else {
    try { await smokeArtifact(zip, { outputParent: parent, timeoutMs: Number(seconds) * 1000 }); }
    catch (error) { console.error(`smoke-artifact: FAIL - ${error.message}`); process.exitCode = 1; }
  }
}

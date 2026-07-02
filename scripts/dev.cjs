const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const bin = (name) =>
  path.join(root, "node_modules", ".bin", isWindows ? `${name}.cmd` : name);

const rendererUrl = "http://127.0.0.1:5173";
const children = [];

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    ...options
  });
  children.push(child);
  return child;
}

function waitForServer(url, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(tick, 250);
      });
      req.setTimeout(1200, () => req.destroy());
    };
    tick();
  });
}

function stopAll() {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
}

process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stopAll();
  process.exit(143);
});

const vite = run(bin("vite"), ["--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
vite.on("exit", (code) => {
  if (code !== 0) stopAll();
});

waitForServer(rendererUrl)
  .then(() => {
    const electronEnv = { ...process.env, ELECTRON_RENDERER_URL: rendererUrl };
    const electron = run(bin("electron"), [".", "--dev"], { env: electronEnv });
    electron.on("exit", (code) => {
      stopAll();
      process.exit(code ?? 0);
    });
  })
  .catch((error) => {
    console.error(error);
    stopAll();
    process.exit(1);
  });


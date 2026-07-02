const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const electronBin = path.join(root, "node_modules", ".bin", isWindows ? "electron.cmd" : "electron");

function hasProcess(names) {
  if (process.platform !== "linux") return false;
  try {
    return fs.readdirSync("/proc").some((entry) => {
      if (!/^\d+$/.test(entry)) return false;
      const commPath = path.join("/proc", entry, "comm");
      const cmdlinePath = path.join("/proc", entry, "cmdline");
      const comm = fs.existsSync(commPath) ? fs.readFileSync(commPath, "utf8").trim() : "";
      const cmdline = fs.existsSync(cmdlinePath)
        ? fs.readFileSync(cmdlinePath, "utf8").replace(/\0/g, " ")
        : "";
      return names.some((name) => comm === name || cmdline.includes(name));
    });
  } catch {
    return false;
  }
}

function inputMethodEnv() {
  if (process.platform !== "linux") return {};
  const inputMethod = hasProcess(["fcitx5", "fcitx"])
    ? "fcitx"
    : hasProcess(["ibus-daemon"])
      ? "ibus"
      : null;

  if (!inputMethod) return {};
  return {
    GTK_IM_MODULE: inputMethod,
    QT_IM_MODULE: inputMethod,
    XMODIFIERS: `@im=${inputMethod}`,
    SDL_IM_MODULE: inputMethod,
    CLUTTER_IM_MODULE: inputMethod
  };
}

const child = spawn(electronBin, ["."], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    ...inputMethodEnv()
  }
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

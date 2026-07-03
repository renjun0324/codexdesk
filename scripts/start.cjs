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
  const normalizeInputMethod = (value) => {
    if (!value) return null;
    const lower = String(value).toLowerCase();
    if (lower === "fcitx5") return "fcitx";
    if (lower === "fcitx") return "fcitx";
    if (lower === "ibus") return "ibus";
    return null;
  };

  const xModifierMatch = String(process.env.XMODIFIERS || "").match(/@im=([^;]+)/i);
  const configured = [
    process.env.GTK_IM_MODULE,
    process.env.QT_IM_MODULE,
    xModifierMatch?.[1]
  ]
    .filter(Boolean)
    .map(normalizeInputMethod)
    .filter(Boolean);

  const running = hasProcess(["fcitx5", "fcitx"]) ? "fcitx" : hasProcess(["ibus-daemon"]) ? "ibus" : null;
  const fallback = hasProcess(["fcitx5", "fcitx"]) ? "fcitx" : hasProcess(["ibus-daemon"]) ? "ibus" : null;
  const inputMethod = configured.find((value) => value === "fcitx" || value === "ibus") || running || fallback;

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
    ...inputMethodEnv(),
    LC_ALL: process.env.LC_ALL || "zh_CN.UTF-8",
    LC_CTYPE: process.env.LC_CTYPE || "zh_CN.UTF-8",
    LANG: process.env.LANG || "zh_CN.UTF-8"
  }
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

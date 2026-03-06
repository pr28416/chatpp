import { spawn } from "node:child_process";
import net from "node:net";

const DEFAULT_PORT = 1420;
const MAX_PORT_SEARCH_ATTEMPTS = 200;
const MAX_LAUNCH_RETRIES = 12;

function parsePort(value) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return undefined;
  return parsed;
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });

    socket.setTimeout(250);

    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("error", (error) => {
      if (error.code === "ECONNREFUSED") {
        resolve(true);
        return;
      }
      if (error.code === "EPERM" || error.code === "EACCES") {
        resolve(undefined);
        return;
      }
      resolve(false);
    });
  });
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + MAX_PORT_SEARCH_ATTEMPTS; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    const availability = await isPortAvailable(port);
    if (availability === undefined) {
      return undefined;
    }
    if (availability) {
      return port;
    }
  }
  return null;
}

function derivePortFromWorkingDirectory() {
  const workingDirectory = process.cwd();
  let hash = 0;
  for (let i = 0; i < workingDirectory.length; i += 1) {
    hash = (hash * 31 + workingDirectory.charCodeAt(i)) % 10000;
  }
  return DEFAULT_PORT + (hash % MAX_PORT_SEARCH_ATTEMPTS);
}

function pickNextPort(port) {
  const next = port + 1;
  return next > 65534 ? DEFAULT_PORT : next;
}

function runTauriWithPort({ devPort, extraArgs, announce }) {
  return new Promise((resolve) => {
    const hmrPort = devPort + 1;
    const tauriConfigOverride = {
      build: {
        beforeDevCommand: `npm run dev -- --port ${devPort} --strictPort`,
        devUrl: `http://localhost:${devPort}`,
      },
    };

    if (announce) {
      console.log(`[tauri:dev] trying Vite port ${devPort} (HMR ${hmrPort})`);
    }

    const child = spawn(
      "npx",
      ["tauri", "dev", "-c", JSON.stringify(tauriConfigOverride), ...extraArgs],
      {
        stdio: ["inherit", "pipe", "pipe"],
        env: {
          ...process.env,
          VITE_PORT: String(devPort),
          VITE_HMR_PORT: String(hmrPort),
        },
      },
    );

    let outputBuffer = "";
    const append = (chunk) => {
      const text = chunk.toString();
      outputBuffer += text;
      if (outputBuffer.length > 20000) {
        outputBuffer = outputBuffer.slice(-20000);
      }
    };

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      append(chunk);
    });

    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      append(chunk);
    });

    child.on("error", (error) => {
      resolve({
        type: "error",
        message: error.message,
        retryablePortConflict: false,
      });
    });

    child.on("exit", (code, signal) => {
      const retryablePortConflict =
        code !== 0 &&
        /(Port \d+ is already in use|Address already in use|EADDRINUSE)/i.test(outputBuffer);

      resolve({
        type: "exit",
        code,
        signal,
        retryablePortConflict,
      });
    });
  });
}

async function main() {
  const requestedPort = parsePort(process.env.TAURI_DEV_PORT);
  if (process.env.TAURI_DEV_PORT && !requestedPort) {
    throw new Error(`Invalid TAURI_DEV_PORT value: "${process.env.TAURI_DEV_PORT}"`);
  }

  const extraArgs = process.argv.slice(2);

  if (requestedPort) {
    const requestedResult = await runTauriWithPort({
      devPort: requestedPort,
      extraArgs,
      announce: true,
    });
    if (requestedResult.type === "error") {
      throw new Error(`failed to start: ${requestedResult.message}`);
    }
    if (requestedResult.signal) {
      process.kill(process.pid, requestedResult.signal);
      return;
    }
    process.exit(requestedResult.code ?? 1);
    return;
  }

  const preferredBasePort = derivePortFromWorkingDirectory();
  const discoveredPort = await findAvailablePort(preferredBasePort);
  let candidatePort;

  if (typeof discoveredPort === "number") {
    candidatePort = discoveredPort;
  } else if (discoveredPort === undefined) {
    candidatePort = preferredBasePort;
    console.log(
      `[tauri:dev] local port probing unavailable; starting from worktree-derived port ${candidatePort}`,
    );
  } else {
    const globalPort = await findAvailablePort(DEFAULT_PORT);
    if (typeof globalPort === "number") {
      candidatePort = globalPort;
    } else {
      throw new Error(
        `Unable to find an open port in ranges ${preferredBasePort}-${preferredBasePort + MAX_PORT_SEARCH_ATTEMPTS - 1} and ${DEFAULT_PORT}-${DEFAULT_PORT + MAX_PORT_SEARCH_ATTEMPTS - 1}.`,
      );
    }
  }

  for (let attempt = 1; attempt <= MAX_LAUNCH_RETRIES; attempt += 1) {
    const result = await runTauriWithPort({
      devPort: candidatePort,
      extraArgs,
      announce: true,
    });

    if (result.type === "error") {
      throw new Error(`failed to start: ${result.message}`);
    }

    if (result.signal) {
      process.kill(process.pid, result.signal);
      return;
    }

    if (result.retryablePortConflict && attempt < MAX_LAUNCH_RETRIES) {
      const nextPort = pickNextPort(candidatePort);
      console.log(
        `[tauri:dev] port ${candidatePort} conflicted during startup; retrying with ${nextPort} (${attempt}/${MAX_LAUNCH_RETRIES - 1})`,
      );
      candidatePort = nextPort;
      continue;
    }

    process.exit(result.code ?? 1);
    return;
  }
}

main().catch((error) => {
  console.error(`[tauri:dev] ${error.message}`);
  process.exit(1);
});

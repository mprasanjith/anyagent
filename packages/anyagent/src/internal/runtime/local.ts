import { exec as execCb } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";

import type { FetchLike } from "../../types.js";

const exec = promisify(execCb);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const WHITESPACE = /\s+/u;
const SOCKET_INODE = /^socket:\[(?<inode>\d+)\]$/u;
const PID_DIR = /^\d+$/u;
const LEADING_QUOTE = /^"/u;

/**
 * `fetch` restricted to loopback. The restriction is the whole point: this
 * one is handed out without the network opt-in, so it must be unable to
 * reach anything but a service already running on this machine.
 */
export const realFetchLocal: FetchLike = (input, init) => {
  let host: string;
  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported scheme");
    }
    host = url.hostname;
  } catch {
    return Promise.reject(new Error(`fetchLocal: not a usable URL: ${input}`));
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    return Promise.reject(
      new Error(`fetchLocal: refusing to reach ${host}; loopback only`)
    );
  }
  return globalThis.fetch(input, init);
};

// `/proc/<pid>/comm` is truncated to 15 bytes by the kernel and a Windows
// name carries `.exe`, so both the trimmed command and the executable path
// are offered to the caller's pattern.
const matches = (name: RegExp, command: string, exe: string): boolean =>
  name.test(command) || name.test(exe);

// LISTEN, in the hex state column of /proc/net/tcp{,6}.
const TCP_LISTEN = "0A";

// inode -> port, for every listening socket on the machine.
const linuxListenerInodes = async (): Promise<Map<number, number>> => {
  const byInode = new Map<number, number>();
  const tables = await Promise.all(
    ["/proc/net/tcp", "/proc/net/tcp6"].map((table) =>
      readFile(table, "utf8").catch(() => "")
    )
  );
  for (const body of tables) {
    for (const line of body.split("\n").slice(1)) {
      const fields = line.trim().split(WHITESPACE);
      if (fields.length < 10 || fields[3] !== TCP_LISTEN) {
        continue;
      }
      const port = Number.parseInt(fields[1]?.split(":")[1] ?? "", 16);
      const inode = Number(fields[9]);
      if (Number.isFinite(port) && Number.isFinite(inode)) {
        byInode.set(inode, port);
      }
    }
  }
  return byInode;
};

const linuxSocketInodes = async (pid: string): Promise<number[]> => {
  let fds: string[];
  try {
    fds = await readdir(`/proc/${pid}/fd`);
  } catch {
    // A process that exited mid-walk, or one this user cannot inspect.
    return [];
  }
  const inodes = await Promise.all(
    fds.map(async (fd) => {
      try {
        const target = await readlink(`/proc/${pid}/fd/${fd}`);
        const match = SOCKET_INODE.exec(target);
        return match?.groups?.inode ? Number(match.groups.inode) : undefined;
      } catch {
        // A file descriptor closed between the listing and the read.
      }
    })
  );
  return inodes.filter((i): i is number => i !== undefined);
};

const linuxListeners = async (name: RegExp): Promise<number[]> => {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }
  const pids = entries.filter((entry) => PID_DIR.test(entry));
  const byInode = await linuxListenerInodes();
  const found = new Set<number>();
  await Promise.all(
    pids.map(async (pid) => {
      let command = "";
      try {
        command = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
      } catch {
        return;
      }
      let exe = "";
      try {
        exe = await readlink(`/proc/${pid}/exe`);
      } catch {
        // Unreadable for another user's process; the command name still counts.
      }
      if (!matches(name, command, exe)) {
        return;
      }
      for (const inode of await linuxSocketInodes(pid)) {
        const port = byInode.get(inode);
        if (port !== undefined) {
          found.add(port);
        }
      }
    })
  );
  return [...found].sort((a, b) => a - b);
};

// `lsof -Fpcn` prints one field per line: `p<pid>`, `c<command>`, `n<addr>`.
const macListeners = async (name: RegExp): Promise<number[]> => {
  let stdout: string;
  try {
    ({ stdout } = await exec("lsof -nP -iTCP -sTCP:LISTEN -Fpcn", {
      timeout: 5000,
    }));
  } catch {
    return [];
  }
  const found = new Set<number>();
  let command = "";
  for (const line of stdout.split("\n")) {
    const value = line.slice(1);
    if (line.startsWith("c")) {
      command = value;
    } else if (line.startsWith("n") && matches(name, command, command)) {
      const port = Number(value.split(":").pop());
      if (Number.isFinite(port)) {
        found.add(port);
      }
    }
  }
  return [...found].sort((a, b) => a - b);
};

// `netstat -ano` gives pid and port; `tasklist` maps pid to an image name.
const windowsListeners = async (name: RegExp): Promise<number[]> => {
  let netstat: string;
  let tasklist: string;
  try {
    [{ stdout: netstat }, { stdout: tasklist }] = await Promise.all([
      exec("netstat -ano -p TCP", { timeout: 5000 }),
      exec("tasklist /FO CSV /NH", { timeout: 5000 }),
    ]);
  } catch {
    return [];
  }
  const nameByPid = new Map<string, string>();
  for (const row of tasklist.split("\n")) {
    const cells = row.split('","');
    if (cells.length > 1) {
      nameByPid.set(
        cells[1] ?? "",
        (cells[0] ?? "").replace(LEADING_QUOTE, "")
      );
    }
  }
  const found = new Set<number>();
  for (const line of netstat.split("\n")) {
    const fields = line.trim().split(WHITESPACE);
    if (fields.length < 5 || fields[3] !== "LISTENING") {
      continue;
    }
    const image = nameByPid.get(fields[4] ?? "") ?? "";
    if (!matches(name, image, image)) {
      continue;
    }
    const port = Number(fields[1]?.split(":").pop());
    if (Number.isFinite(port)) {
      found.add(port);
    }
  }
  return [...found].sort((a, b) => a - b);
};

/**
 * Ports a locally running process matching `name` is listening on.
 *
 * Verified against `/proc` on Linux. The macOS and Windows lookups follow
 * each platform's standard tool (`lsof`, `netstat` + `tasklist`); an
 * unavailable tool or an unreadable table yields no ports, which the caller
 * reads as "that service is not running" — the same answer it gets when the
 * service genuinely is not.
 */
export const realLocalListeners = (name: RegExp): Promise<number[]> => {
  switch (process.platform) {
    case "linux": {
      return linuxListeners(name);
    }
    case "darwin": {
      return macListeners(name);
    }
    case "win32": {
      return windowsListeners(name);
    }
    default: {
      return Promise.resolve([]);
    }
  }
};

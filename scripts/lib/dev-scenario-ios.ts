import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { devScenarioError } from "./dev-scenario-api";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUNDLE_ID = "com.snackday.app";

export interface SimulatorDevice {
  readonly udid: string;
  readonly name: string;
  readonly state: string;
  readonly isAvailable?: boolean;
}

export interface SimulatorList {
  readonly devices: Readonly<Record<string, readonly SimulatorDevice[]>>;
}

function availableIPhones(list: SimulatorList): readonly SimulatorDevice[] {
  return Object.entries(list.devices)
    .toSorted(([left], [right]) => right.localeCompare(left, undefined, { numeric: true }))
    .flatMap(([, devices]) => devices)
    .filter((device) => device.isAvailable !== false && device.name.startsWith("iPhone"));
}

export function selectScenarioSimulator(list: SimulatorList, requested?: string): SimulatorDevice {
  const devices = availableIPhones(list);
  const selected =
    requested === undefined
      ? (devices.find((device) => device.state === "Booted") ?? devices[0])
      : devices.find(
          (device) =>
            device.udid === requested || device.name.toLowerCase() === requested.toLowerCase(),
        );
  if (selected === undefined) {
    throw devScenarioError(
      "select-ios-simulator",
      requested === undefined
        ? "no available iPhone simulator is installed"
        : `no available iPhone simulator matches "${requested}"`,
    );
  }
  return selected;
}

export function xcodeEnvironment(
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  return {
    ...process.env,
    ...(process.env["DEVELOPER_DIR"] === undefined
      ? { DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" }
      : {}),
    ...extra,
  };
}

async function run(
  command: readonly string[],
  step: string,
  signal?: AbortSignal,
  environment: Record<string, string> = {},
): Promise<void> {
  signal?.throwIfAborted();
  const child = Bun.spawn({
    cmd: [...command],
    cwd: ROOT,
    env: xcodeEnvironment(environment),
    ...(signal === undefined ? {} : { signal }),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  signal?.throwIfAborted();
  if (exitCode !== 0) throw devScenarioError(step, `${command[0]} exited ${exitCode}`);
}

export async function simulatorList(signal?: AbortSignal): Promise<SimulatorList> {
  signal?.throwIfAborted();
  const child = Bun.spawn({
    cmd: ["xcrun", "simctl", "list", "devices", "available", "--json"],
    cwd: ROOT,
    env: xcodeEnvironment(),
    ...(signal === undefined ? {} : { signal }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  signal?.throwIfAborted();
  if (exitCode !== 0) throw devScenarioError("list-ios-simulators", `xcrun exited ${exitCode}`);
  try {
    return JSON.parse(stdout) as SimulatorList;
  } catch {
    throw devScenarioError("list-ios-simulators", "simctl returned invalid JSON");
  }
}

export async function launchScenarioIos(
  nativeApiBaseUrl: string,
  requestedSimulator?: string,
  signal?: AbortSignal,
): Promise<SimulatorDevice> {
  await run(["bash", "scripts/ios-build.sh"], "build-ios-app", signal);
  const simulator = selectScenarioSimulator(await simulatorList(signal), requestedSimulator);
  if (simulator.state !== "Booted") {
    await run(["xcrun", "simctl", "boot", simulator.udid], "boot-ios-simulator", signal);
  }
  await run(["xcrun", "simctl", "bootstatus", simulator.udid, "-b"], "wait-ios-simulator", signal);
  await run(
    ["open", "-a", "Simulator", "--args", "-CurrentDeviceUDID", simulator.udid],
    "show-ios-simulator",
    signal,
  );

  const derivedData = process.env["DERIVED_DATA_PATH"] ?? join(ROOT, "DerivedData");
  const appPath = join(derivedData, "Build", "Products", "Debug-iphonesimulator", "Snackday.app");
  try {
    await access(appPath);
  } catch {
    throw devScenarioError("install-ios-app", "ios-build.sh did not produce Snackday.app");
  }
  await run(["xcrun", "simctl", "install", simulator.udid, appPath], "install-ios-app", signal);

  await run(
    ["xcrun", "simctl", "launch", "--terminate-running-process", simulator.udid, BUNDLE_ID],
    "launch-ios-app",
    signal,
    {
      SIMCTL_CHILD_SNACKDAY_API_BASE_URL: nativeApiBaseUrl,
      SIMCTL_CHILD_SNACKDAY_DEV_SIGN_IN: "true",
    },
  );
  return simulator;
}

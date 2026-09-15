#!/usr/bin/env bun

import {
  checkDevScenario,
  formatDevScenarioInstructions,
  startDevScenario,
} from "./lib/dev-scenario";
import { launchScenarioIos } from "./lib/dev-scenario-ios";

function usage(): string {
  return [
    "Usage: bun scripts/dev-scenario.ts [--check] [--ios[=<simulator name or UDID>]]",
    "",
    "Without arguments, starts a long-lived isolated local scenario.",
    "--check seeds and verifies the scenario, then removes it and exits.",
    "--ios also builds, installs, and launches the app in an iPhone simulator.",
  ].join("\n");
}

interface CliOptions {
  readonly check: boolean;
  readonly simulator?: string;
}

function parseOptions(args: readonly string[]): CliOptions {
  const iosOptions = args.filter(
    (argument) => argument === "--ios" || argument.startsWith("--ios="),
  );
  const unknown = args.filter(
    (argument) => argument !== "--check" && argument !== "--ios" && !argument.startsWith("--ios="),
  );
  if (unknown.length > 0) throw new Error(`unknown option: ${unknown[0]}`);
  if (iosOptions.length > 1) throw new Error("--ios may be specified only once");
  if (args.includes("--check") && iosOptions.length > 0) {
    throw new Error("--check and --ios cannot be used together");
  }
  const iosOption = iosOptions[0];
  if (iosOption === undefined || iosOption === "--ios") {
    return { check: args.includes("--check") };
  }
  const simulator = iosOption.slice("--ios=".length).trim();
  if (simulator.length === 0) throw new Error("--ios requires a simulator name or UDID after =");
  return { check: false, simulator };
}

async function runLongLived(simulator?: string, launchIos = false): Promise<void> {
  const controller = new AbortController();
  let running: Awaited<ReturnType<typeof startDevScenario>> | undefined;
  let stopPromise: Promise<void> | undefined;
  const requestStop = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    if (running !== undefined) stopPromise = running.stop();
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  try {
    running = await startDevScenario({ signal: controller.signal });
    if (launchIos) {
      const device = await launchScenarioIos(
        running.manifest.nativeApiBaseUrl,
        simulator,
        controller.signal,
      );
      console.log(`Native app launched on ${device.name} (${device.udid}).`);
    }
    console.log(formatDevScenarioInstructions(running.manifest));
    const exitCode = await running.waitForServerExit();
    if (!controller.signal.aborted) {
      throw new Error(`development scenario server exited unexpectedly with code ${exitCode}`);
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    await (stopPromise ?? running?.stop());
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
  }
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  const options = parseOptions(args);
  if (options.check) {
    await checkDevScenario();
    console.log("Development scenario check passed; temporary data removed.");
    return;
  }
  const launchIos = args.some((argument) => argument === "--ios" || argument.startsWith("--ios="));
  await runLongLived(options.simulator, launchIos);
}

try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : "development scenario failed");
  process.exitCode = 1;
}

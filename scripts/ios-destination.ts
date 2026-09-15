import { selectScenarioSimulator, simulatorList } from "./lib/dev-scenario-ios";

const simulator = selectScenarioSimulator(await simulatorList());
process.stdout.write(`platform=iOS Simulator,id=${simulator.udid}`);

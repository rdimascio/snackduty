import { loadAwsStagingConfig } from "./config";
import { buildAwsStagingPlan } from "./stack-plan";

const config = loadAwsStagingConfig(process.env);
const plan = buildAwsStagingPlan(config);

console.log(JSON.stringify(plan, undefined, 2));

import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BotFactory } from "./adapter.js";
import { DEFAULT_FACTORY } from "./adapter.js";
import { loadCase, runCase, type CaseResult } from "./runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = resolve(HERE, "../../conformance/cases");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const factoryArg = valueOf(args, "--factory") ?? DEFAULT_FACTORY;
  const only = valueOf(args, "--only");

  const factory = await loadFactory(factoryArg);
  // Management cases need their own client; a fixture run has none, and those
  // cases report a clear setup failure rather than a confusing mismatch.
  const managementArg = valueOf(args, "--management-factory");
  const managementFactory = managementArg
    ? (await import(pathToFileURL(resolve(HERE, managementArg)).href)).managementFactory
    : (await import("./admin-sdk-adapter.js")).managementFactory;
  // Without this line, "9 failed" reads as a broken SDK. It is a broken FIXTURE,
  // on purpose, and the run is measuring the runner rather than any SDK.
  const isFixture = factoryArg.includes("fixtures/") || (managementArg?.includes("fixtures/") ?? false);
  if (isFixture) {
    console.log(
      `Running against the fixture ${factoryArg}, not an SDK.\n` +
        `It is deliberately incorrect, so FAILURES ARE THE EXPECTED RESULT: they prove the\n` +
        `suite detects the guarantees it violates. The cases it does not violate should pass —\n` +
        `a mixed result is the point. See "Validating a runner" in conformance/README.md.\n`,
    );
  }
  const files = (await readdir(CASES_DIR)).filter((f) => f.endsWith(".json")).sort();
  // Match on the id's prefix, not anywhere in the name: `--only m` used to
  // catch every case with an m in it, which is most of them.
  const selected = only ? files.filter((f) => f.startsWith(only)) : files;

  if (selected.length === 0) {
    console.error(`no cases matched${only ? ` --only ${only}` : ""} in ${CASES_DIR}`);
    process.exit(2);
  }

  const results: CaseResult[] = [];
  for (const file of selected) {
    const testCase = await loadCase(join(CASES_DIR, file));
    const result = await runCase(testCase, factory, managementFactory);
    results.push(result);
    report(result);
  }

  const failed = results.filter((r) => r.failures.length > 0);
  console.log(
    `\n${results.length - failed.length}/${results.length} cases passed` +
      (failed.length ? `, ${failed.length} failed` : ""),
  );
  if (isFixture) {
    console.log(`(against a fixture — see the note above before reading this as a defect)`);
  }
  // The exit code still reports failures honestly. A fixture run is not meant
  // for CI, so it is not worth teaching the exit code to lie about it.
  process.exit(failed.length ? 1 : 0);
}

function report(result: CaseResult): void {
  const { case: c, failures } = result;
  if (failures.length === 0) {
    console.log(`PASS  ${c.guarantee.padEnd(3)} ${c.id}`);
    return;
  }
  console.log(`FAIL  ${c.guarantee.padEnd(3)} ${c.id}`);
  console.log(`      ${c.title}`);
  for (const f of failures) console.log(`      · ${f.where}: ${f.detail}`);
  // The `why` is printed on failure and nowhere else: at the moment someone is
  // deciding whether this case is worth keeping, they should be reading what
  // breaks in production if it goes.
  console.log(`      why: ${c.why}`);
  console.log();
}

async function loadFactory(specifier: string): Promise<BotFactory> {
  const target = specifier.startsWith(".")
    ? pathToFileURL(resolve(HERE, specifier)).href
    : specifier;
  try {
    const module = (await import(target)) as { factory?: BotFactory; default?: BotFactory };
    const factory = module.factory ?? module.default;
    if (!factory?.create) throw new Error("the module exports no `factory` with a create() method");
    return factory;
  } catch (error) {
    console.error(
      `could not load the SDK adapter from ${specifier}\n` +
        `  ${error instanceof Error ? error.message : String(error)}\n\n` +
        `The SDK must export a BotFactory (see adapter.ts). Until it exists, run the\n` +
        `runner against the bundled fixture:\n\n` +
        `  npm run conformance -- --factory ./fixtures/naive-bot.ts\n`,
    );
    process.exit(2);
  }
}

function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

await main();

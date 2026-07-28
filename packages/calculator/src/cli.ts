#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import {
  ProductionError,
  calculateProduction,
  parseProductionCatalog,
  parseProductionRequest,
} from "./index.js";

interface CliOptions {
  catalogPath: string;
  requestPath: string;
  pretty: boolean;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const [catalogText, requestText] = await Promise.all([
    readFile(options.catalogPath, "utf8"),
    readFile(options.requestPath, "utf8"),
  ]);
  const catalog = parseProductionCatalog(parseJson(catalogText, options.catalogPath));
  const request = parseProductionRequest(parseJson(requestText, options.requestPath));
  const result = calculateProduction(catalog, request);
  process.stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`);
}

function parseArguments(arguments_: string[]): CliOptions {
  let catalogPath: string | undefined;
  let requestPath: string | undefined;
  let pretty = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    switch (argument) {
      case "--catalog":
        catalogPath = requireArgument(arguments_, ++index, "--catalog");
        break;
      case "--request":
        requestPath = requireArgument(arguments_, ++index, "--request");
        break;
      case "--pretty":
        pretty = true;
        break;
      case "--help":
        process.stdout.write(
          "Usage: factorio-calculate --catalog <catalog.json> --request <request.json> [--pretty]\n",
        );
        process.exit(0);
        break;
      default:
        throw new ProductionError(
          "INVALID_INPUT",
          `Unknown CLI argument ${String(argument)}`,
        );
    }
  }

  if (catalogPath === undefined || requestPath === undefined) {
    throw new ProductionError(
      "INVALID_INPUT",
      "Both --catalog and --request are required",
    );
  }
  return { catalogPath, requestPath, pretty };
}

function requireArgument(
  arguments_: string[],
  index: number,
  option: string,
): string {
  const value = arguments_[index];
  if (value === undefined || value.startsWith("--")) {
    throw new ProductionError("INVALID_INPUT", `${option} requires a file path`);
  }
  return value;
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new ProductionError(
      "INVALID_INPUT",
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

try {
  await main();
} catch (error: unknown) {
  if (error instanceof ProductionError) {
    process.stderr.write(
      `${JSON.stringify({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      })}\n`,
    );
  } else {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  process.exitCode = 1;
}

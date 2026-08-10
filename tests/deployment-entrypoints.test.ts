import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const repositoryRoot = resolve(import.meta.dir, "..");
const readRepositoryFile = (path: string) => readFileSync(resolve(repositoryRoot, path), "utf8");

describe("Cloudflare deployment entrypoints", () => {
  test("all entrypoints converge on the common deployment pipeline", () => {
    const packageJson = JSON.parse(readRepositoryFile("package.json"));
    const scripts = packageJson.scripts as Record<string, string>;

    expect(scripts.deploy).toContain("bun run build:cloudflare");
    expect(scripts.deploy).toContain("EDGE_EVER_USE_EXISTING_AUTH_SECRET=true");
    expect(scripts.deploy).toContain("deploy:ci");
    expect(scripts["deploy:manual"]).toBe(
      "export EDGE_EVER_DEPLOYMENT_TRIGGER=manual EDGE_EVER_DEPLOYMENT_METHOD=local_cli && bun run deploy:doctor && bun run build:cloudflare && bun run deploy:ci",
    );
    expect(scripts["deploy:ci"]).toBe(
      "bun run db:migrate:remote && bun run deploy:worker && bun run deploy:verify",
    );
    expect(scripts["deploy:cloudflare-builds"]).toBe("bun run deploy:ci");
  });

  test("online deployment declares the required authentication Secret", () => {
    const example = readRepositoryFile(".dev.vars.example");
    expect(example).toMatch(/^EDGE_EVER_AUTH_PASSWORD=\s*$/m);

    const packageJson = JSON.parse(readRepositoryFile("package.json"));
    expect(packageJson.cloudflare.bindings.EDGE_EVER_AUTH_PASSWORD.description).toBeTruthy();
  });

  test("online deployment resolves the D1 id without editing the repository config", () => {
    const runner = readRepositoryFile("scripts/run-wrangler.mjs");
    const englishAgentDoc = readRepositoryFile("docs/agent-deploy-cloudflare.md");
    const chineseAgentDoc = readRepositoryFile("docs/agent-deploy-cloudflare.zh-CN.md");

    expect(runner).toContain('"d1", "list", "--json"');
    expect(runner).toContain("findD1DatabaseIdByName");
    expect(englishAgentDoc).toContain("automatically resolves the D1 UUID");
    expect(chineseAgentDoc).toContain("自动查询 D1 UUID");
  });

  test("keeps D1 resolver diagnostics out of Wrangler JSON stdout", () => {
    const workingDirectory = mkdtempSync(resolve(tmpdir(), "edgeever-wrangler-output-"));
    const wranglerBinDirectory = resolve(
      workingDirectory,
      "node_modules",
      "wrangler",
      "bin",
    );
    const queryOutput = JSON.stringify([{ results: [{ name: "users" }] }]);
    const inheritedEnvironment = Object.fromEntries(
      ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP"]
        .map((name) => [name, process.env[name]])
        .filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
    const environment = {
      ...inheritedEnvironment,
      EDGE_EVER_INSTANCE: "",
      WRANGLER_CONFIG: resolve(workingDirectory, "wrangler.toml"),
    };

    try {
      mkdirSync(wranglerBinDirectory, { recursive: true });
      writeFileSync(
        resolve(workingDirectory, "wrangler.toml"),
        [
          'name = "edgeever"',
          'database_name = "edgeever"',
          'database_id = "00000000-0000-0000-0000-000000000000"',
          'migrations_dir = "migrations"',
          "",
        ].join("\n"),
      );
      writeFileSync(
        resolve(wranglerBinDirectory, "wrangler.js"),
        [
          'const args = process.argv.slice(2);',
          'if (args.includes("list")) {',
          '  process.stdout.write(JSON.stringify([{ name: "edgeever", uuid: "11111111-1111-1111-1111-111111111111" }]));',
          "} else {",
          `  process.stdout.write(${JSON.stringify(`${queryOutput}\n`)});`,
          "}",
          "",
        ].join("\n"),
      );

      const resultPath = resolve(workingDirectory, "result.json");
      const runnerArguments = [
        "d1",
        "execute",
        "DB",
        "--remote",
        "--command",
        "SELECT name FROM sqlite_master",
        "--json",
      ];
      const harness = spawnSync(
        "node",
        [
          "-e",
          [
            'const { spawnSync } = require("node:child_process");',
            'const { writeFileSync } = require("node:fs");',
            "const result = spawnSync(",
            "  process.env.EDGE_TEST_RUNTIME,",
            "  [process.env.EDGE_TEST_RUNNER, ...JSON.parse(process.env.EDGE_TEST_ARGUMENTS)],",
            '  { cwd: process.env.EDGE_TEST_CWD, encoding: "utf8", env: process.env },',
            ");",
            "writeFileSync(process.env.EDGE_TEST_RESULT, JSON.stringify({",
            "  status: result.status,",
            "  stdout: result.stdout,",
            "  stderr: result.stderr,",
            "  error: result.error?.message,",
            "}));",
          ].join("\n"),
        ],
        {
          env: {
            ...environment,
            EDGE_TEST_ARGUMENTS: JSON.stringify(runnerArguments),
            EDGE_TEST_CWD: workingDirectory,
            EDGE_TEST_RESULT: resultPath,
            EDGE_TEST_RUNNER: resolve(repositoryRoot, "scripts", "run-wrangler.mjs"),
            EDGE_TEST_RUNTIME: process.execPath,
          },
        },
      );
      expect(harness.status).toBe(0);
      const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
        error?: string;
        status: number;
        stderr: string;
        stdout: string;
      };

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${queryOutput}\n`);
      expect(result.stderr).toContain("[info] resolving Cloudflare D1 database id for edgeever");
      expect(result.stderr).toContain("[ok] resolved D1 database edgeever");
    } finally {
      rmSync(workingDirectory, { force: true, recursive: true });
    }
  });

  test("deployed repositories receive guarded daily upstream updates", () => {
    const workflow = readRepositoryFile(".github/workflows/sync-edgeever-upstream.yml");

    expect(workflow).toContain("github.repository != 'tianma-if/edgeever'");
    expect(workflow).toContain("UPSTREAM_REPOSITORY: tianma-if/edgeever");
    expect(workflow).toContain("Require a GitHub Fork");
    expect(workflow).toContain(".fork");
    expect(workflow).toContain("EDGE_EVER_UPDATE_CHANNEL");
    expect(workflow).toContain("stable)");
    expect(workflow).toContain("edge)");
    expect(workflow).toContain("force_redeploy");
    expect(workflow).toContain("bun run db:migrate:local");
    expect(workflow).toContain("bun test");
    expect(workflow).toContain("git push origin HEAD:main");
    expect(workflow).toContain("git push --force-with-lease origin HEAD:main");
    expect(workflow).toContain("git reset --hard");
    expect(workflow).toContain("source repo import");
    expect(workflow).toContain("content_matches_target");
    expect(workflow).toContain("already_on_target");
    expect(workflow).toContain("GITHUB_STEP_SUMMARY");
    expect(workflow).toContain("EDGE_EVER_CLOUDFLARE_DEPLOY_HOOK_URL");
    expect(workflow).toContain("non_workflow_changes");
    expect(workflow).toContain("Prefer this workflow over GitHub **Sync fork**");
  });

  test("public deployment documentation exposes only Fork and Agent paths", () => {
    const englishReadme = readRepositoryFile("README.md");
    const chineseReadme = readRepositoryFile("README.zh-CN.md");

    expect(englishReadme).not.toContain("deploy.workers.cloudflare.com");
    expect(englishReadme).not.toContain("Option C: Manual Deployment");
    expect(englishReadme).toContain("Fork https://github.com/tianma-if/edgeever");
    expect(chineseReadme).not.toContain("deploy.workers.cloudflare.com");
    expect(chineseReadme).not.toContain("方案 C：手动部署");
    expect(chineseReadme).toContain("Fork https://github.com/tianma-if/edgeever");
  });

  test("AI Agent deployment remains fully online", () => {
    const englishAgentDoc = readRepositoryFile("docs/agent-deploy-cloudflare.md");
    const chineseAgentDoc = readRepositoryFile("docs/agent-deploy-cloudflare.zh-CN.md");

    expect(englishAgentDoc).toContain("Workers & Pages");
    expect(englishAgentDoc).toContain("Update deployed EdgeEver");
    expect(englishAgentDoc).not.toContain("bun run deploy:manual");
    expect(englishAgentDoc).not.toContain("deploy:setup");
    expect(englishAgentDoc).not.toContain(".env.local");
    expect(chineseAgentDoc).toContain("Workers & Pages");
    expect(chineseAgentDoc).not.toContain("bun run deploy:manual");
    expect(chineseAgentDoc).not.toContain("bun run deploy:manual");
  });

  test("deployment no longer requires an R2 bucket binding", () => {
    const wranglerConfig = readRepositoryFile("wrangler.toml");
    expect(wranglerConfig).not.toContain("r2_buckets");
    expect(wranglerConfig).not.toContain("RESOURCES");
    expect(wranglerConfig).not.toContain("bucket_name");

    const envExample = readRepositoryFile(".env.local.example");
    expect(envExample).not.toContain("EDGE_EVER_R2_BUCKET_NAME");
    expect(envExample).not.toContain("EDGE_EVER_R2_PREVIEW_BUCKET_NAME");

    const deployScript = readRepositoryFile("scripts/cloudflare-deploy.mjs");
    expect(deployScript).not.toContain("ensureR2");
    expect(deployScript).not.toContain("R2_BUCKET_NAME");

    const runnerScript = readRepositoryFile("scripts/run-wrangler.mjs");
    expect(runnerScript).not.toContain("R2_BUCKET_NAME");
    expect(runnerScript).not.toContain("R2_PREVIEW_BUCKET_NAME");
  });
});

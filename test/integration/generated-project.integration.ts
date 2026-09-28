import {
  SchematicTestRunner,
  type UnitTestTree,
} from '@angular-devkit/schematics/testing';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type * as ts from 'typescript';

const runner = new SchematicTestRunner(
  '.',
  path.join(process.cwd(), 'src/collection.json'),
);

async function command(cwd: string, executable: string, args: string[]) {
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        env: { ...process.env, NODE_OPTIONS: '', CI: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 180000);
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve({ code, output });
      });
    },
  );
}

function materialize(dir: string, tree: UnitTestTree) {
  for (const file of tree.files) {
    const destination = path.join(dir, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, tree.readContent(file));
  }
}

// These are intentionally separate from the fast unit suite: they install the
// generated package.json and check unmodified generated sources with its tsc.
// No dependency diagnostics are filtered and no ambient type stubs are used.
it.each(['esm', 'cjs'] as const)(
  'type-checks the entire generated %s project before and after conversion',
  async (type) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-generated-types-'));
    try {
      let tree = await runner.runSchematic('application', { name: '', type });
      materialize(dir, tree);
      const install = await command(dir, 'pnpm', [
        'install',
        '--ignore-scripts',
        '--no-frozen-lockfile',
        ...(process.env.NEST_INTEGRATION_OFFLINE === '1' ? ['--offline'] : []),
      ]);
      expect(
        install.code,
        `Dependency installation failed:\n${install.output}`,
      ).toBe(0);
      const require = createRequire(path.join(dir, 'package.json'));
      const compiler: typeof ts = require('typescript');
      const tsc = require.resolve('typescript/bin/tsc');
      const failures: string[] = [];

      async function check(stage: string, configs: string[]) {
        const covered = new Set<string>();
        for (const config of configs) {
          const parsed = compiler.getParsedCommandLineOfConfigFile(
            path.join(dir, config),
            {},
            {
              ...compiler.sys,
              onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
                throw new Error(
                  compiler.flattenDiagnosticMessageText(
                    diagnostic.messageText,
                    '\n',
                  ),
                );
              },
            },
          );
          expect(parsed, `${stage}: ${config} must exist`).toBeDefined();
          for (const file of parsed!.fileNames) covered.add(path.resolve(file));
          const result = await command(dir, process.execPath, [
            tsc,
            '--project',
            config,
            '--noEmit',
            '--pretty',
            'false',
          ]);
          if (result.code !== 0)
            failures.push(`${stage}: ${config}\n${result.output}`);
        }
        // A successful check of an empty solution config must not hide files
        // that are no longer assigned to any TypeScript project.
        function sourceFiles(directory: string): string[] {
          return fs
            .readdirSync(directory, { withFileTypes: true })
            .flatMap((entry) => {
              if (entry.name === 'node_modules') return [];
              const file = path.join(directory, entry.name);
              if (entry.isDirectory()) return sourceFiles(file);
              return file.endsWith('.ts') ? [file] : [];
            });
        }
        const generated = sourceFiles(dir);
        expect(generated.length).toBeGreaterThan(0);
        for (const file of generated) {
          expect(
            covered.has(path.resolve(dir, file)),
            `${stage}: uncovered ${file}`,
          ).toBe(true);
        }
      }

      await check('standard', ['tsconfig.json', 'tsconfig.build.json']);
      tree = await runner.runSchematic('sub-app', { name: 'secondary' }, tree);
      tree = await runner.runSchematic(
        'library',
        { name: 'shared', prefix: '@app' },
        tree,
      );
      materialize(dir, tree);
      const cli = JSON.parse(tree.readContent('/nest-cli.json'));
      // The unit-test environment disables relocation; perform only that move,
      // preserving every generated source file and compiler option verbatim.
      const originalRoot = path.dirname(cli.sourceRoot);
      for (const source of ['src', 'test']) {
        fs.renameSync(
          path.join(dir, source),
          path.join(dir, originalRoot, source),
        );
      }
      const configs = Object.values(cli.projects).map(
        (project: any) => project.compilerOptions.tsConfigPath as string,
      );
      await check('monorepo', [...configs, 'tsconfig.spec.json']);
      expect(failures, failures.join('\n\n')).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  240000,
);

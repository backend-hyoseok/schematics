import { SchematicTestRunner } from '@angular-devkit/schematics/testing';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';

const require = createRequire(import.meta.url);
const runner = new SchematicTestRunner(
  '.',
  path.join(process.cwd(), 'src/collection.json'),
);

// Exercise project discovery, not just the shape of the generated JSON.
function server(dir: string) {
  const child = spawn(
    process.execPath,
    [require.resolve('typescript/lib/tsserver.js')],
    {
      cwd: dir,
      env: { ...process.env, NODE_OPTIONS: '' },
    },
  );
  let sequence = 0;
  let buffer = Buffer.alloc(0);
  const pending = new Map<number, (message: any) => void>();
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const length = Number(
        buffer
          .subarray(0, headerEnd)
          .toString()
          .match(/Content-Length: (\d+)/)![1],
      );
      if (buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(
        buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString(),
      );
      buffer = buffer.subarray(headerEnd + 4 + length);
      if (message.type === 'response') {
        pending.get(message.request_seq)?.(message);
        pending.delete(message.request_seq);
      }
    }
  });
  return {
    async request(command: string, args: Record<string, unknown>) {
      const seq = ++sequence;
      const response = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`tsserver timed out: ${command}`)),
          10000,
        );
        pending.set(seq, (message) => {
          clearTimeout(timeout);
          if (message.success) resolve(message.body);
          else reject(new Error(message.message));
        });
      });
      child.stdin.write(
        JSON.stringify({ seq, type: 'request', command, arguments: args }) +
          '\n',
      );
      return response;
    },
    close() {
      child.kill();
    },
  };
}

it.each(['esm', 'cjs'])(
  'keeps %s workspace tests configured without emitting them',
  async (type) => {
    let tree = await runner.runSchematic('application', { name: '', type });
    const root = JSON.parse(tree.readContent('/tsconfig.json'));
    // A tiny local type package makes this independent of installed test runners.
    root.compilerOptions.types = ['test-globals'];
    root.compilerOptions.typeRoots = ['./types'];
    root.compilerOptions.outDir = './output';
    tree.overwrite('/tsconfig.json', JSON.stringify(root));
    tree = await runner.runSchematic(
      'sub-app',
      { name: 'admin', rootDir: 'services' },
      tree,
    );
    tree = await runner.runSchematic(
      'library',
      { name: 'shared', rootDir: 'packages', prefix: '@app' },
      tree,
    );
    tree = await runner.runSchematic(
      'sub-app',
      { name: 'worker', rootDir: 'services', specFileSuffix: 'test' },
      tree,
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-test-config-'));
    let client: ReturnType<typeof server> | undefined;
    const write = (relative: string, text: string) => {
      const file = path.join(dir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    try {
      for (const file of tree.files) write(file, tree.readContent(file));
      // Source relocation is disabled by the schematic under NODE_ENV=test.
      for (const source of ['src', 'test']) {
        fs.renameSync(
          path.join(dir, source),
          path.join(dir, 'services/nestjs-schematics', source),
        );
      }
      write(
        'types/test-globals/index.d.ts',
        'declare function describe(name: string, fn: () => void): void;',
      );
      write('packages/shared/src/value.ts', 'export const value = 1;');
      const files = [
        'services/nestjs-schematics/src/app.controller.spec.ts',
        'services/admin/src/admin.controller.spec.ts',
        'services/admin/test/app.e2e-spec.ts',
        'services/worker/src/worker.controller.test.ts',
        'packages/shared/src/shared.service.spec.ts',
      ];
      for (const file of files) {
        write(
          file,
          `
import { value } from '../../../packages/shared/src/value.js';
function inject(): ParameterDecorator { return () => {}; }
class Probe { constructor(@inject() public value: number) {} }
describe('test', () => { new Probe(value); });
`,
        );
      }
      write('output/ignored.spec.ts', 'invalid output');
      write(
        'services/admin/node_modules/ignored/index.ts',
        'invalid dependency',
      );
      const parse = (relative: string) =>
        ts.getParsedCommandLineOfConfigFile(
          path.join(dir, relative),
          {},
          {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: (error) => {
              throw new Error(
                ts.flattenDiagnosticMessageText(error.messageText, '\n'),
              );
            },
          },
        )!;
      const testConfig = parse('tsconfig.spec.json');
      expect(testConfig.errors).toEqual([]);
      for (const file of files)
        expect(testConfig.fileNames).toContain(path.join(dir, file));
      expect(
        testConfig.fileNames.some(
          (file) =>
            file.includes('/output/') || file.includes('/node_modules/'),
        ),
      ).toBe(false);
      expect(parse('services/admin/tsconfig.app.json').fileNames).not.toContain(
        path.join(dir, files[1]),
      );
      expect(parse('services/admin/tsconfig.app.json').fileNames).not.toContain(
        path.join(dir, files[2]),
      );
      const program = ts.createProgram(
        testConfig.fileNames,
        testConfig.options,
      );
      const emitted: string[] = [];
      program.emit(undefined, (file) => {
        emitted.push(file);
      });
      expect(emitted.filter((file) => !file.endsWith('.tsbuildinfo'))).toEqual(
        [],
      );

      client = server(dir);
      for (const relative of files) {
        const file = path.join(dir, relative);
        await client.request('open', { file, projectRootPath: dir });
        const info = await client.request('projectInfo', {
          file,
          needFileNameList: false,
        });
        expect(info.configFileName).toBe(path.join(dir, 'tsconfig.spec.json'));
        expect(
          await client.request('semanticDiagnosticsSync', { file }),
        ).toEqual([]);
      }
    } finally {
      client?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);

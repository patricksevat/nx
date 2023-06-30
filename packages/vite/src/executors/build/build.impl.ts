import 'dotenv/config';
import { ExecutorContext, readJsonFile, writeJsonFile } from '@nx/devkit';
import { build, InlineConfig, mergeConfig } from 'vite';
import {
  getProjectTsConfigPath,
  getViteBuildOptions,
  getViteSharedConfig,
} from '../../utils/options-utils';
import { ViteBuildExecutorOptions } from './schema';
import {
  createLockFile,
  createPackageJson,
  getLockFileName,
} from '@nx/js';
import { existsSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import * as fastGlob from 'fast-glob';
import { createAsyncIterable } from '@nx/devkit/src/utils/async-iterable';
import { registerPaths, validateTypes } from '../../utils/executor-utils';
import { fileHasher } from 'nx/src/hasher/file-hasher';
import { requireNx } from '@nx/devkit/nx';

const { logger } = requireNx();

export async function* viteBuildExecutor(
  options: ViteBuildExecutorOptions,
  context: ExecutorContext
) {
  const projectRoot =
    context.projectsConfigurations.projects[context.projectName].root;

  registerPaths(projectRoot, options, context);

  const normalizedOptions = normalizeOptions(options);

  const buildConfig = mergeConfig(
    getViteSharedConfig(normalizedOptions, false, context),
    {
      build: getViteBuildOptions(normalizedOptions, context),
    }
  );

  if (!options.skipTypeCheck) {
    await validateTypes({
      workspaceRoot: context.root,
      projectRoot: projectRoot,
      tsconfig: getProjectTsConfigPath(projectRoot),
    });
  }

  const watcherOrOutput = await runInstance(buildConfig);

  const libraryPackageJson = resolve(projectRoot, 'package.json');
  const rootPackageJson = resolve(context.root, 'package.json');
  const distPackageJson = resolve(normalizedOptions.outputPath, 'package.json');

  // Generate a package.json if option has been set.
  if (options.generatePackageJson) {
    const builtPackageJson = createPackageJson(
      context.projectName,
      context.projectGraph,
      {
        target: context.targetName,
        root: context.root,
        isProduction: !options.includeDevDependenciesInPackageJson, // By default we remove devDependencies since this is a production build.
        versionHash: options.generatePackageJsonVersionHash && await getHashFromDeclarationFiles(normalizedOptions.outputPath)
      }
    );

    builtPackageJson.type = 'module';

    writeJsonFile(`${options.outputPath}/package.json`, builtPackageJson);

    const lockFile = createLockFile(builtPackageJson);
    writeFileSync(`${options.outputPath}/${getLockFileName()}`, lockFile, {
      encoding: 'utf-8',
    });
  }
  // For buildable libs, copy package.json if it exists.
  else if (
    !existsSync(distPackageJson) &&
    existsSync(libraryPackageJson) &&
    rootPackageJson !== libraryPackageJson
  ) {
    const projectPackageJson = readJsonFile(libraryPackageJson);
    if(options.generatePackageJsonVersionHash) {
      const versionHash = await getHashFromDeclarationFiles(normalizedOptions.outputPath)

      projectPackageJson.version = `${projectPackageJson.version}-${versionHash}`
    }

    writeJsonFile(join(normalizedOptions.outputPath, 'package.json'), projectPackageJson)
  }

  if ('on' in watcherOrOutput) {
    const iterable = createAsyncIterable<{ success: boolean }>(({ next }) => {
      let success = true;
      watcherOrOutput.on('event', (event) => {
        if (event.code === 'START') {
          success = true;
        } else if (event.code === 'ERROR') {
          success = false;
        } else if (event.code === 'END') {
          next({ success });
        }
        // result must be closed when present.
        // see https://rollupjs.org/guide/en/#rollupwatch
        if ('result' in event) {
          event.result.close();
        }
      });
    });
    yield* iterable;
  } else {
    const output = watcherOrOutput?.['output'] || watcherOrOutput?.[0]?.output;
    const fileName = output?.[0]?.fileName || 'main.cjs';
    const outfile = resolve(normalizedOptions.outputPath, fileName);
    yield { success: true, outfile };
  }
}

function runInstance(options: InlineConfig) {
  return build({
    ...options,
  });
}

function normalizeOptions(options: ViteBuildExecutorOptions) {
  const normalizedOptions = { ...options };

  // coerce watch to null or {} to match with Vite's watch config
  if (options.watch === false) {
    normalizedOptions.watch = null;
  } else if (options.watch === true) {
    normalizedOptions.watch = {};
  }

  return normalizedOptions;
}

async function getHashFromDeclarationFiles(projectOutputPath: string): Promise<string> {
  const declarationGlobPattern = '**/*.d.ts'
  const declarationFiles = await fastGlob(declarationGlobPattern, {
    cwd: projectOutputPath
  });

  if(declarationFiles.length === 0) {
    logger.warn(`Could not find any generated .d.ts files in ${projectOutputPath}. Have you added 'vite-plugin-dts' in your vite.config.ts?`)
    return '';
  }

  return fileHasher.hashFilesMatchingGlobs(projectOutputPath, [declarationGlobPattern]);
}

export default viteBuildExecutor;

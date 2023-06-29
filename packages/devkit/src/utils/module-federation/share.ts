import type {
  SharedLibraryConfig,
  SharedWorkspaceLibraryConfig,
  WorkspaceLibrary,
} from './models';
import { AdditionalSharedConfig, SharedFunction } from './models';
import { dirname, join, normalize } from 'path';
import { readProjectPackageJson, readRootPackageJson } from './package-json';
import { readTsPathMappings, getRootTsConfigPath } from './typescript';
import {
  collectPackageSecondaryEntryPoints,
  collectWorkspaceLibrarySecondaryEntryPoints,
} from './secondary-entry-points';
import type { ProjectConfiguration } from 'nx/src/config/workspace-json-project-json';
import type { ProjectGraph, ProjectGraphProjectNode } from 'nx/src/config/project-graph';
import { requireNx } from '../../../nx';
import { Tree, names, readJson, readNxJson } from '../../../';

const { workspaceRoot, logger } = requireNx();

/**
 * Build an object of functions to be used with the ModuleFederationPlugin to
 * share Nx Workspace Libraries between Hosts and Remotes.
 *
 * @param libraries - The Nx Workspace Libraries to share
 * @param tsConfigPath - The path to TS Config File that contains the Path Mappings for the Libraries
 */
export function shareWorkspaceLibraries(
  libraries: WorkspaceLibrary[],
  projectGraph: ProjectGraph,
  tsConfigPath = process.env.NX_TSCONFIG_PATH ?? getRootTsConfigPath()
): SharedWorkspaceLibraryConfig {
  if (!libraries) {
    return getEmptySharedLibrariesConfig();
  }

  const tsconfigPathAliases = readTsPathMappings(tsConfigPath);
  if (!Object.keys(tsconfigPathAliases).length) {
    return getEmptySharedLibrariesConfig();
  }

  const pathMappings: { name: string; path: string, nameWithoutNpmScope: string }[] = [];
  for (const [key, paths] of Object.entries(tsconfigPathAliases)) {
    const library = libraries.find((lib) => lib.importKey === key);
    if (!library) {
      continue;
    }

    // This is for Angular Projects that use ng-package.json
    // It will do nothing for React Projects
    collectWorkspaceLibrarySecondaryEntryPoints(
      library,
      tsconfigPathAliases
    ).forEach(({ name, path }) =>
      pathMappings.push({
        name,
        path,
        nameWithoutNpmScope: library.name,
      })
    );

    pathMappings.push({
      name: key,
      path: normalize(join(workspaceRoot, paths[0])),
      nameWithoutNpmScope: library.name,
    });
  }

  const webpack = require('webpack');

  return {
    getAliases: () =>
      pathMappings.reduce(
        (aliases, library) => ({ ...aliases, [library.name]: library.path }),
        {}
      ),
    getLibraries: (eager?: boolean): Record<string, SharedLibraryConfig> =>
      pathMappings.reduce(
        (libraries, library) => {
          const project = projectGraph.nodes[library.nameWithoutNpmScope];
          const isBuildableProject = project && isBuildable('build', project);
          
          let sharedLibConfig: SharedLibraryConfig = { requiredVersion: false, eager };
          
          if(project && isBuildableProject) {
            // TODO: perhaps make this a bit more defensive. Not sure what happens when the require fails
            const outputVersion = require(join(workspaceRoot, project.data.targets.build.options.outputPath, 'package.json')).version;

            sharedLibConfig = {
              requiredVersion: outputVersion || false,
              singleton: false,
              strictVersion: true,
            }
          }

          return ({
            ...libraries,
            [library.name]: sharedLibConfig,
          });
        },
        {} as Record<string, SharedLibraryConfig>
      ),
    getReplacementPlugin: () =>
      new webpack.NormalModuleReplacementPlugin(/./, (req) => {
        if (!req.request.startsWith('.')) {
          return;
        }

        const from = req.context;
        const to = normalize(join(req.context, req.request));

        for (const library of pathMappings) {
          const libFolder = normalize(dirname(library.path));
          if (!from.startsWith(libFolder) && to.startsWith(libFolder)) {
            req.request = library.name;
          }
        }
      }),
  };
}

/**
 * Build the Module Federation Share Config for a specific package and the
 * specified version of that package.
 * @param pkgName - Name of the package to share
 * @param version - Version of the package to require by other apps in the Module Federation setup
 */
export function getNpmPackageSharedConfig(
  pkgName: string,
  version: string,
  project: ProjectConfiguration
): SharedLibraryConfig | undefined {
  if (!version) {
    logger.warn(
      `Could not find a version for "${pkgName}" in upward "package.json" files from ${project.root}` +
        'when collecting shared packages for the Module Federation setup. ' +
        'The package will not be shared.'
    );

    return undefined;
  }

  return { singleton: true, strictVersion: true, requiredVersion: version };
}

/**
 * Create a dictionary of packages and their Module Federation Shared Config
 * from an array of package names.
 *
 * Lookup the versions of the packages from the root package.json file in the
 * workspace.
 * @param packages - Array of package names as strings
 */
export function sharePackages(
  packages: string[],
  project: ProjectConfiguration
): Record<string, SharedLibraryConfig> {
  const pkgJson = readRootPackageJson();
  const projectPkgJson = readProjectPackageJson(project);
  const allPackages: { name: string; version: string }[] = [];
  packages.forEach((pkg) => {
    const projectPkgVersion =
      projectPkgJson.dependencies?.[pkg] ?? projectPkgJson.devDependencies?.[pkg];
    const rootPkgVersion =
      pkgJson.dependencies?.[pkg] ?? pkgJson.devDependencies?.[pkg];

    // Local version takes precedence over global version
    const version = projectPkgVersion || rootPkgVersion;
    allPackages.push({ name: pkg, version });

    // TODO: check if this change is needed as collectWorkspaceLibrarySecondaryEntryPoints it's only needed for Angular
    collectPackageSecondaryEntryPoints(pkg, version, allPackages, project);
  });

  return allPackages.reduce((shared, pkg) => {
    const config = getNpmPackageSharedConfig(pkg.name, pkg.version, project);
    if (config) {
      shared[pkg.name] = config;
    }

    return shared;
  }, {} as Record<string, SharedLibraryConfig>);
}

/**
 * Apply a custom function provided by the user that will modify the Shared Config
 * of the dependencies for the Module Federation build.
 *
 * @param sharedConfig - The original Shared Config to be modified
 * @param sharedFn - The custom function to run
 */
export function applySharedFunction(
  sharedConfig: Record<string, SharedLibraryConfig>,
  sharedFn: SharedFunction | undefined
): void {
  if (!sharedFn) {
    return;
  }

  for (const [libraryName, library] of Object.entries(sharedConfig)) {
    const mappedDependency = sharedFn(libraryName, library);
    if (mappedDependency === false) {
      delete sharedConfig[libraryName];
      continue;
    } else if (!mappedDependency) {
      continue;
    }

    sharedConfig[libraryName] = mappedDependency;
  }
}

/**
 * Add additional dependencies to the shared package that may not have been
 * discovered by the project graph.
 *
 * This can be useful for applications that use a Dependency Injection system
 * that expects certain Singleton values to be present in the shared injection
 * hierarchy.
 *
 * @param sharedConfig - The original Shared Config
 * @param additionalShared - The additional dependencies to add
 * @param projectGraph - The Nx project graph
 */
export function applyAdditionalShared(
  sharedConfig: Record<string, SharedLibraryConfig>,
  additionalShared: AdditionalSharedConfig | undefined,
  projectGraph: ProjectGraph
): void {
  if (!additionalShared) {
    return;
  }

  for (const shared of additionalShared) {
    if (typeof shared === 'string') {
      addStringDependencyToSharedConfig(sharedConfig, shared, projectGraph);
    } else if (Array.isArray(shared)) {
      sharedConfig[shared[0]] = shared[1];
    } else if (typeof shared === 'object') {
      sharedConfig[shared.libraryName] = shared.sharedConfig;
    }
  }
}

function addStringDependencyToSharedConfig(
  sharedConfig: Record<string, SharedLibraryConfig>,
  dependency: string,
  projectGraph: ProjectGraph
): void {
  if (projectGraph.nodes[dependency]) {
    sharedConfig[dependency] = { requiredVersion: false };
    
  } else if (projectGraph.externalNodes?.[`npm:${dependency}`]) {
    const project = projectGraph.nodes[dependency]?.data;
    const pkgJson = readProjectPackageJson(project);
    const config = getNpmPackageSharedConfig(
      dependency,
      pkgJson.dependencies?.[dependency] ??
        pkgJson.devDependencies?.[dependency],
      project 
    );

    if (!config) {
      return;
    }

    sharedConfig[dependency] = config;
  } else {
    throw new Error(
      `The specified dependency "${dependency}" in the additionalShared configuration does not exist in the project graph. ` +
        `Please check your additionalShared configuration and make sure you are including valid workspace projects or npm packages.`
    );
  }
}

function getEmptySharedLibrariesConfig() {
  const webpack = require('webpack');
  return {
    getAliases: () => ({}),
    getLibraries: () => ({}),
    getReplacementPlugin: () =>
      new webpack.NormalModuleReplacementPlugin(/./, () => {}),
  };
}

// Copied from packages/js/src/utils/buildable-libs-utils.ts as not to create a circ dep
// TODO: unsure where to put it so it can be shared
function isBuildable(target: string, node: ProjectGraphProjectNode): boolean {
  return (
    node.data.targets &&
    node.data.targets[target] &&
    node.data.targets[target].executor !== ''
  );
}

// TODO: Copied from packages/js/src/utils/package-json/get-npm-scope.ts to prevent circ dep
function getNpmScope(tree: Tree): string | undefined {
  const nxJson = readNxJson(tree);

  // TODO(v17): Remove reading this from nx.json
  if (nxJson?.npmScope) {
    return nxJson.npmScope;
  }

  const { name } = tree.exists('package.json')
    ? readJson<{ name?: string }>(tree, 'package.json')
    : { name: null };

  if (name?.startsWith('@')) {
    return name.split('/')[0].substring(1);
  }
}
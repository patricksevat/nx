import { existsSync } from 'fs';
import { requireNx } from '../../../nx';
import type { ProjectConfiguration } from 'nx/src/config/workspace-json-project-json';

const { workspaceRoot, readJsonFile, joinPathFragments } = requireNx();

export function readRootPackageJson(): {
  dependencies?: { [key: string]: string };
  devDependencies?: { [key: string]: string };
} {
  const pkgJsonPath = joinPathFragments(workspaceRoot, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    throw new Error(
      'NX MF: Could not find root package.json to determine dependency versions.'
    );
  }

  return readJsonFile(pkgJsonPath);
}

// TODO: combine with prev fn
export function readProjectPackageJson(project: ProjectConfiguration): {
  dependencies?: { [key: string]: string };
  devDependencies?: { [key: string]: string };
} {
  const pkgJsonPath = joinPathFragments(project.root, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    throw new Error(
      `NX MF: Could not find ${pkgJsonPath} to determine dependency versions.`
    );
  }

  return readJsonFile(pkgJsonPath);
}

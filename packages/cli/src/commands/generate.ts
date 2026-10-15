import type { Loader } from '../load'
import type { Project } from '../project'
import { generateServices } from './ensure'

export async function generateCommand(
  project: Project,
  loader: Loader,
  only?: string[],
): Promise<void> {
  await generateServices(project, loader, only)
}

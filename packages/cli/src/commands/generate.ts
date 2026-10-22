import type { Loader } from '../load'
import type { Project } from '../project'
import { generateServices } from './ensure'

export async function generateCommand(
  project: Project,
  loader: Loader,
  only?: string[],
): Promise<void> {
  // `npm install` runs this as the project's `prepare` script, and `specbook init` writes that script before any service is
  // added: a project with no services yet has nothing to generate, which is not a failure
  if (Object.keys(project.config.services).length === 0 && !only?.length) {
    console.log(
      'No services in the config yet. Add one with: specbook add <service> --spec <path or URL>',
    )
    return
  }
  await generateServices(project, loader, only)
}

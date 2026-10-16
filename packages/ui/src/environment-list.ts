import { engine } from './runtime'
import { environmentNote, environmentRisk, environments, envVarsVersion, version } from './store'

/** Reads the environment list, risks and notes again (after one is made or removed) and tells dependents. */
export async function refreshEnvironments(): Promise<void> {
  const v = version.value
  const [names, risks, notes] = await Promise.all([
    engine.environments(v),
    engine.environmentRisks(v),
    engine.environmentNotes(v),
  ])
  environments.value = names
  environmentRisk.value = risks
  environmentNote.value = notes
  envVarsVersion.value += 1
}
